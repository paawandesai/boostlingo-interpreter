using System.Net.WebSockets;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

/// <summary>
/// One error contract, run against every STT adapter, like <see cref="TranslatorContractTests"/>: the pipeline
/// and the endpoint rely on these kinds whichever vendor is configured. Each subclass only says how to build
/// its adapter and how its vendor frames an interim transcript.
/// </summary>
public abstract class SttContractTests
{
    protected abstract IStreamingStt Create(Uri baseUrl, string? apiKey = "test-key");

    /// <summary>A vendor message carrying an interim transcript of <paramref name="text"/>.</summary>
    protected abstract string Interim(string text);

    private static async IAsyncEnumerable<AudioFrame> Audio(int frames)
    {
        for (var i = 0; i < frames; i++)
        {
            await Task.Yield();
            yield return new AudioFrame(new byte[640], 16000);
        }
    }

    private static async Task<List<SttEvent>> Collect(IAsyncEnumerable<SttEvent> events)
    {
        var list = new List<SttEvent>();
        await foreach (var e in events) list.Add(e);
        return list;
    }

    private static readonly Uri Unused = new("ws://127.0.0.1:9/v1/");

    [Theory]
    [InlineData(401, ProviderErrorKind.Auth)]
    [InlineData(403, ProviderErrorKind.Auth)]
    [InlineData(429, ProviderErrorKind.RateLimited)]
    public async Task A_refused_connection_maps_to_a_provider_error(int status, ProviderErrorKind kind)
    {
        await using var server = await FakeWebSocketServer.StartAsync((_, _) => Task.CompletedTask, rejectWith: status);
        var stt = Create(server.BaseUrl);

        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(stt.TranscribeAsync(Audio(1), new SttOptions("en"), TestContext.Current.CancellationToken)));

        Assert.Equal((kind, stt.Name), (e.Kind, e.Provider));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("replace-me")] // the .env.example placeholder is never sent to the vendor
    public async Task A_missing_key_fails_before_connecting(string? key)
    {
        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Create(Unused, key).TranscribeAsync(Audio(1), new SttOptions("en"), TestContext.Current.CancellationToken)));

        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
    }

    [Fact]
    public async Task An_abnormal_close_mid_stream_is_unavailable_after_the_text_so_far()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, _) =>
        {
            await WebSocketText.SendTextAsync(ws, Interim("Hello"), default);
            await Task.Delay(50);
            await ws.CloseAsync(WebSocketCloseStatus.InternalServerError, "vendor fault", default);
        });

        var events = new List<SttEvent>();
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var ev in Create(server.BaseUrl).TranscribeAsync(Audio(1000), new SttOptions("en"), TestContext.Current.CancellationToken))
                events.Add(ev);
        });

        Assert.Equal(ProviderErrorKind.Unavailable, e.Kind);
        Assert.Contains(new SttPartial("Hello"), events);
    }

    [Fact]
    public async Task Caller_cancellation_ends_the_stream_as_a_cancellation()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) => await s.ReceiveUntil(ws, _ => false));
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        cts.CancelAfter(TimeSpan.FromMilliseconds(200));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Collect(Create(server.BaseUrl).TranscribeAsync(Audio(int.MaxValue), new SttOptions("en"), cts.Token)));
    }
}

public class DeepgramSttContractTests : SttContractTests
{
    protected override IStreamingStt Create(Uri baseUrl, string? apiKey = "test-key") =>
        new DeepgramStt(Options.Create(new DeepgramOptions { ApiKey = apiKey, BaseUrl = baseUrl }));

    protected override string Interim(string text) =>
        $$"""{"type":"Results","channel":{"alternatives":[{"transcript":"{{text}}","confidence":0.9}]},"is_final":false,"speech_final":false}""";
}

public class OpenAISttContractTests : SttContractTests
{
    protected override IStreamingStt Create(Uri baseUrl, string? apiKey = "test-key") =>
        new OpenAIRealtimeStt(Options.Create(new OpenAITranscriptionOptions { ApiKey = apiKey, BaseUrl = baseUrl }));

    protected override string Interim(string text) =>
        $$"""{"type":"conversation.item.input_audio_transcription.delta","item_id":"a","delta":"{{text}}"}""";
}
