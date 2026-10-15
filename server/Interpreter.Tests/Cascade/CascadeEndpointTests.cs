using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Tests.Cascade;

public class CascadeEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string Token = "test-access-token";

    /// <summary>Transcribes "Hello." once the client stops sending audio, and counts the frames it got.</summary>
    private sealed class FakeStt : IStreamingStt
    {
        public int Frames;
        public string Name => "fake-stt";

        public async IAsyncEnumerable<SttEvent> TranscribeAsync(
            IAsyncEnumerable<AudioFrame> audio, SttOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var _ in audio.WithCancellation(ct)) Interlocked.Increment(ref Frames);
            yield return new SttPartial("Hel");
            yield return new SttFinal("Hello.", true, 0.9);
        }
    }

    private sealed class FakeTranslator : IStreamingTranslator
    {
        public string Name => "fake-translator";

        public async IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield return "Hola.";
        }
    }

    private sealed class FakeTts : IStreamingTts
    {
        public string Name => "fake-tts";

        public async IAsyncEnumerable<AudioChunk> SynthesizeAsync(
            IAsyncEnumerable<string> textChunks, TtsOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var t in textChunks.WithCancellation(ct))
                yield return new AudioChunk(Encoding.UTF8.GetBytes(t), 24000);
        }
    }

    /// <summary>Speaks one chunk, then waits until cancelled; records whether it was.</summary>
    private sealed class HangingTts : IStreamingTts
    {
        public readonly TaskCompletionSource Cancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "hanging-tts";

        public async IAsyncEnumerable<AudioChunk> SynthesizeAsync(
            IAsyncEnumerable<string> textChunks, TtsOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            yield return new AudioChunk(new byte[480], 24000);
            try { await Task.Delay(Timeout.Infinite, ct); }
            finally { if (ct.IsCancellationRequested) Cancelled.TrySetResult(); }
        }
    }

    /// <summary>Emits a final as soon as the first audio frame arrives, then keeps listening.</summary>
    private sealed class FirstFrameStt : IStreamingStt
    {
        public string Name => "first-frame-stt";

        public async IAsyncEnumerable<SttEvent> TranscribeAsync(
            IAsyncEnumerable<AudioFrame> audio, SttOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            var first = true;
            await foreach (var _ in audio.WithCancellation(ct))
            {
                if (!first) continue;
                first = false;
                yield return new SttFinal("Hello.", true, 0.9);
            }
        }
    }

    private async Task<(WebSocket Ws, FakeStt Stt)> Connect(string? serverToken = Token, IStreamingTts? tts = null, IStreamingStt? sttOverride = null)
    {
        var stt = new FakeStt();
        var server = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("Access:Token", serverToken ?? "");
            b.UseSetting("Access:PermitLimit", "100");
            b.ConfigureServices(s =>
            {
                s.AddKeyedSingleton<IStreamingStt>("deepgram", sttOverride ?? stt);
                s.AddKeyedSingleton<IStreamingTranslator>("openai", new FakeTranslator());
                s.AddKeyedSingleton<IStreamingTts>("elevenlabs", tts ?? new FakeTts());
            });
        }).Server;
        var ws = await server.CreateWebSocketClient().ConnectAsync(new Uri(server.BaseAddress, "ws/cascade"), TestContext.Current.CancellationToken);
        return (ws, stt);
    }

    private static Task Send(WebSocket ws, object message) =>
        WebSocketText.SendTextAsync(ws, JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(message))!.ToJsonString(), TestContext.Current.CancellationToken);

    private static async Task<List<WebSocketText.Message>> ReadAll(WebSocket ws)
    {
        var all = new List<WebSocketText.Message>();
        while (true)
        {
            var m = await WebSocketText.ReceiveAsync(ws, TestContext.Current.CancellationToken);
            all.Add(m with { Data = m.Data.ToArray() });
            if (m.Close is not null) return all;
        }
    }

    private static JsonNode Json(WebSocketText.Message m) => JsonNode.Parse(m.Text)!;

    [Theory]
    [InlineData("wrong", "en", "es")]
    [InlineData(null, "en", "es")]
    [InlineData(Token, "en", "fr")]
    public async Task Refuses_a_bad_start_and_closes(string? token, string source, string target)
    {
        var (ws, stt) = await Connect();

        await Send(ws, new { type = "start", token, source, target });
        var messages = await ReadAll(ws);

        var error = Json(messages[0]);
        Assert.Equal("error", (string?)error["type"]);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, messages[^1].Close);
        Assert.Equal(0, stt.Frames);
    }

    [Fact]
    public async Task Refuses_every_session_when_the_server_token_is_not_configured()
    {
        var (ws, _) = await Connect(serverToken: null);

        await Send(ws, new { type = "start", token = "", source = "en", target = "es" });
        var messages = await ReadAll(ws);

        Assert.Equal("Auth", (string?)Json(messages[0])["kind"]);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, messages[^1].Close);
    }

    [Fact]
    public async Task Runs_a_turn_end_to_end_and_answers_pings_on_the_same_clock()
    {
        var (ws, stt) = await Connect();
        var ct = TestContext.Current.CancellationToken;

        await Send(ws, new { type = "start", token = Token, source = "en", target = "es" });
        var ready = Json(await WebSocketText.ReceiveAsync(ws, ct));
        Assert.Equal(("ready", "fake-stt", "fake-translator", "fake-tts"),
            ((string?)ready["type"], (string?)ready["stt"], (string?)ready["translator"], (string?)ready["tts"]));

        for (var i = 0; i < 3; i++) await ws.SendAsync(new byte[640], WebSocketMessageType.Binary, true, ct);
        await Send(ws, new { type = "ping", c = 1234.5 });
        var pong = Json(await WebSocketText.ReceiveAsync(ws, ct));
        Assert.Equal(("pong", 1234.5), ((string?)pong["type"], (double)pong["c"]!));
        await Send(ws, new { type = "stop" });

        var messages = await ReadAll(ws);
        var json = messages.Where(m => m.Type == WebSocketMessageType.Text).Select(Json).ToList();
        var types = json.Select(j => (string)j["type"]!).ToList();

        Assert.Equal(3, stt.Frames);
        Assert.Contains("transcript.partial", types);
        Assert.Equal("Hello.", (string?)json.Single(j => (string?)j["type"] == "transcript.final")["text"]);
        Assert.Equal("Hola.", (string?)json.Single(j => (string?)j["type"] == "translation.final")["text"]);
        Assert.Contains(json, j => (string?)j["type"] == "latency.mark" && (string?)j["name"] == "tts.first_byte");
        Assert.Equal(1, (int?)json.Single(j => (string?)j["type"] == "utterance.done")["u"]);
        Assert.Equal("Hola.", Encoding.UTF8.GetString(messages.Single(m => m.Type == WebSocketMessageType.Binary).Data.Span));
        // Event times are on the pong's clock: later than the pong, not reset to zero by the pipeline.
        Assert.All(json, j => Assert.True((double)j["t"]! >= (double)pong["t"]!));
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
    }

    [Fact]
    public async Task Cancels_the_pipeline_when_the_client_closes_mid_turn()
    {
        // A mode switch or End closes the socket while TTS may still be speaking (T3.3).
        var tts = new HangingTts();
        var (ws, _) = await Connect(tts: tts, sttOverride: new FirstFrameStt());
        var ct = TestContext.Current.CancellationToken;
        await Send(ws, new { type = "start", token = Token, source = "en", target = "es" });
        await WebSocketText.ReceiveAsync(ws, ct); // ready
        await ws.SendAsync(new byte[640], WebSocketMessageType.Binary, true, ct);

        // Wait for the first TTS audio frame, then close from the client side.
        while ((await WebSocketText.ReceiveAsync(ws, ct)).Type != WebSocketMessageType.Binary) { }
        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "switch", ct);

        await tts.Cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
    }
}
