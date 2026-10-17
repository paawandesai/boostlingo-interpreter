using System.Net.WebSockets;
using System.Web;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Interpreter.Providers.Deepgram;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

public class DeepgramSttTests
{
    private static DeepgramStt Stt(Uri? baseUrl = null, string? key = "test-key") =>
        new(Options.Create(new DeepgramOptions { ApiKey = key, BaseUrl = baseUrl ?? new Uri("wss://api.deepgram.com/v1/") }));

    private static async IAsyncEnumerable<AudioFrame> Audio(int frames)
    {
        for (var i = 0; i < frames; i++)
        {
            await Task.Yield();
            yield return new AudioFrame(new byte[] { (byte)i, 0, (byte)i, 0 }, 16000);
        }
    }

    private static async Task<List<SttEvent>> Collect(IAsyncEnumerable<SttEvent> events)
    {
        var list = new List<SttEvent>();
        await foreach (var e in events) list.Add(e);
        return list;
    }

    private static string Results(string text, bool isFinal, bool speechFinal, double confidence = 0.97) =>
        $$"""{"type":"Results","channel":{"alternatives":[{"transcript":"{{text}}","confidence":{{confidence}}}]},"is_final":{{(isFinal ? "true" : "false")}},"speech_final":{{(speechFinal ? "true" : "false")}}}""";

    [Fact]
    public void Every_connection_opts_out_of_model_improvement()
    {
        // Guardrail G4: no Deepgram request may be eligible for model training.
        var query = HttpUtility.ParseQueryString(Stt().ListenUri(new SttOptions("es", Keyterms: ["ibuprofeno", "dolor de pecho"])).Query);

        Assert.Equal("true", query["mip_opt_out"]);
        Assert.Equal("nova-3", query["model"]);
        Assert.Equal("es", query["language"]);
        Assert.Equal("linear16", query["encoding"]);
        Assert.Equal("16000", query["sample_rate"]);
        Assert.Equal("true", query["interim_results"]);
        Assert.Equal(["ibuprofeno", "dolor de pecho"], query.GetValues("keyterm")!);
    }

    [Fact]
    public async Task Sends_audio_and_maps_results_to_stt_events()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await WebSocketText.SendTextAsync(ws, """{"type":"Metadata","request_id":"r1"}""", default);
            await WebSocketText.SendTextAsync(ws, Results("I have", false, false), default);
            await WebSocketText.SendTextAsync(ws, Results("I have a headache.", true, false), default);
            await WebSocketText.SendTextAsync(ws, """{"type":"SpeechStarted"}""", default);
            await WebSocketText.SendTextAsync(ws, Results("Since Monday.", true, true, 0.81), default);
            await WebSocketText.SendTextAsync(ws, """{"type":"UtteranceEnd","last_word_end":2.1}""", default);
            await s.ReceiveUntil(ws, m => m.Type == WebSocketMessageType.Text && m.Text.Contains("CloseStream"));
        });

        var events = await Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(3), new SttOptions("en"), TestContext.Current.CancellationToken));

        Assert.Equal<SttEvent>(
            [new SttPartial("I have"), new SttFinal("I have a headache.", false, 0.97), new SttFinal("Since Monday.", true, 0.81), new SttUtteranceEnd()],
            events);
        Assert.Equal("Token test-key", server.Authorization);
        Assert.Equal("true", HttpUtility.ParseQueryString(server.Query!)["mip_opt_out"]);
        var binary = server.Received.Where(m => m.Type == WebSocketMessageType.Binary).ToList();
        Assert.Equal(3, binary.Count);
        Assert.Equal(new byte[] { 2, 0, 2, 0 }, binary[2].Data.ToArray());
        Assert.Contains("CloseStream", server.Received.Last().Text);
    }

    [Fact]
    public async Task Rejected_key_is_an_auth_error()
    {
        await using var server = await FakeWebSocketServer.StartAsync((_, _) => Task.CompletedTask, rejectWith: 401);

        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(1), new SttOptions("en"), TestContext.Current.CancellationToken)));

        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
        Assert.Equal("deepgram", e.Provider);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("replace-me")]
    public async Task Missing_key_fails_before_connecting(string? key)
    {
        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Stt(key: key).TranscribeAsync(Audio(1), new SttOptions("en"), TestContext.Current.CancellationToken)));
        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
    }

    [Fact]
    public async Task Abnormal_close_is_reported_as_unavailable()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, _) =>
        {
            await WebSocketText.SendTextAsync(ws, Results("Hello", false, false), default);
            await ws.CloseAsync(WebSocketCloseStatus.InternalServerError, "NET-0001", default);
        });

        var events = new List<SttEvent>();
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var ev in Stt(server.BaseUrl).TranscribeAsync(Audio(100), new SttOptions("en"), TestContext.Current.CancellationToken))
                events.Add(ev);
        });

        Assert.Equal(ProviderErrorKind.Unavailable, e.Kind);
        Assert.Equal([new SttPartial("Hello")], events);
    }

    [Fact]
    public async Task Stopping_early_closes_the_socket()
    {
        var closed = new TaskCompletionSource();
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await WebSocketText.SendTextAsync(ws, Results("Hello", false, false), default);
            try
            {
                await s.ReceiveUntil(ws, _ => false); // returns on a close frame, throws if the client aborts
            }
            finally
            {
                closed.TrySetResult();
            }
        });

        await foreach (var _ in Stt(server.BaseUrl).TranscribeAsync(Audio(int.MaxValue), new SttOptions("en"), TestContext.Current.CancellationToken))
            break;

        await closed.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public void Registration_reads_the_key_from_the_environment_variable_name()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DEEPGRAM_API_KEY"] = "from-env",
            ["Deepgram:Model"] = "nova-3-medical",
        }).Build();
        using var services = new ServiceCollection().AddDeepgramStt(config).BuildServiceProvider();

        var stt = services.GetRequiredKeyedService<IStreamingStt>("deepgram");
        var options = services.GetRequiredService<IOptions<DeepgramOptions>>().Value;

        Assert.Equal("deepgram", stt.Name);
        Assert.Equal(("from-env", "nova-3-medical"), (options.ApiKey, options.Model));
    }
}
