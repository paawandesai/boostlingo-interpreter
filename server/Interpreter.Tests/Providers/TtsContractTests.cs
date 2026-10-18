using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Interpreter.Providers.ElevenLabs;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

/// <summary>
/// One error contract, run against every TTS adapter, like <see cref="TranslatorContractTests"/>. The two
/// vendors use different transports (a WebSocket and one HTTP request per phrase), so each subclass builds the
/// failing vendor; the assertions are shared.
/// </summary>
public abstract class TtsContractTests
{
    /// <summary>An adapter whose vendor refuses the request with this HTTP status.</summary>
    protected abstract Task<(IStreamingTts Tts, IAsyncDisposable? Fixture)> Refusing(int status);

    /// <summary>An adapter whose vendor sends some audio for the first phrase, then fails mid-stream.</summary>
    protected abstract Task<(IStreamingTts Tts, IAsyncDisposable? Fixture)> FailingAfterAudio();

    protected abstract IStreamingTts WithKey(string? key);

    private static async IAsyncEnumerable<string> Text(params string[] chunks)
    {
        foreach (var c in chunks)
        {
            await Task.Yield();
            yield return c;
        }
    }

    [Theory]
    [InlineData(401, ProviderErrorKind.Auth)]
    [InlineData(429, ProviderErrorKind.RateLimited)]
    public async Task A_refused_request_maps_to_a_provider_error(int status, ProviderErrorKind kind)
    {
        var (tts, fixture) = await Refusing(status);
        await using var _ = fixture;

        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var __ in tts.SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        });

        Assert.Equal((kind, tts.Name), (e.Kind, e.Provider));
    }

    [Fact]
    public async Task A_failure_after_audio_started_is_a_provider_error_after_the_audio_so_far()
    {
        var (tts, fixture) = await FailingAfterAudio();
        await using var _ = fixture;

        var chunks = new List<AudioChunk>();
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var c in tts.SynthesizeAsync(Text("Hola, ", "¿cómo está?"), new TtsOptions("es"), TestContext.Current.CancellationToken))
                chunks.Add(c);
        });

        // Mid-stream: the audio before the failure was delivered, and the error says which vendor failed.
        Assert.NotEmpty(chunks);
        Assert.All(chunks, c => Assert.True(c.Pcm16.Length % 2 == 0));
        Assert.Equal((ProviderErrorKind.Unavailable, tts.Name), (e.Kind, e.Provider));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("replace-me")] // the .env.example placeholder is never sent to the vendor
    public async Task A_missing_key_fails_before_calling_the_vendor(string? key)
    {
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var _ in WithKey(key).SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        });

        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
    }
}

public class ElevenLabsTtsContractTests : TtsContractTests
{
    private static ElevenLabsTts Create(Uri baseUrl, string? key = "test-key") =>
        new(Options.Create(new ElevenLabsOptions { ApiKey = key, BaseUrl = baseUrl }));

    protected override async Task<(IStreamingTts, IAsyncDisposable?)> Refusing(int status)
    {
        var server = await FakeWebSocketServer.StartAsync((_, _) => Task.CompletedTask, rejectWith: status);
        return (Create(server.BaseUrl), server);
    }

    protected override async Task<(IStreamingTts, IAsyncDisposable?)> FailingAfterAudio()
    {
        var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("Hola"));
            var audio = new JsonObject { ["audio"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("pcm-")), ["isFinal"] = null };
            await WebSocketText.SendTextAsync(ws, audio.ToJsonString(), default);
            await Task.Delay(50);
            await ws.CloseAsync(WebSocketCloseStatus.InternalServerError, "vendor fault", default);
        });
        return (Create(server.BaseUrl), server);
    }

    protected override IStreamingTts WithKey(string? key) => Create(new Uri("ws://127.0.0.1:9/v1/"), key);
}

public class OpenAISpeechTtsContractTests : TtsContractTests
{
    private static OpenAISpeechTts Create(StubHttpHandler handler, string? key = "test-key") =>
        new(new HttpClient(handler), Options.Create(new OpenAISpeechOptions { ApiKey = key }));

    /// <summary>Returns <paramref name="before"/> bytes, then fails the next read as a dropped connection would.</summary>
    private sealed class FailingStream(int before) : MemoryStream(new byte[before])
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            var read = await base.ReadAsync(buffer, ct);
            return read > 0 ? read : throw new IOException("The response ended prematurely.");
        }
    }

    protected override Task<(IStreamingTts, IAsyncDisposable?)> Refusing(int status) =>
        Task.FromResult<(IStreamingTts, IAsyncDisposable?)>((Create(StubHttpHandler.Json((HttpStatusCode)status, """{"error":{}}""")), null));

    protected override Task<(IStreamingTts, IAsyncDisposable?)> FailingAfterAudio() =>
        Task.FromResult<(IStreamingTts, IAsyncDisposable?)>((Create(new StubHttpHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new FailingStream(4)) })), null));

    protected override IStreamingTts WithKey(string? key) => Create(StubHttpHandler.Json(HttpStatusCode.OK, ""), key);
}
