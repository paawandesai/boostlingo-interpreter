using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using Interpreter.Api.Cascade;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
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
        public readonly List<TranslationRequest> Requests = [];
        public string Name => "fake-translator";

        public async IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            lock (Requests) Requests.Add(request);
            await Task.Yield();
            yield return "Hola.";
        }
    }

    /// <summary>Fails at once, the way an adapter does when its key is missing on the server.</summary>
    private sealed class FailingStt(ProviderException error) : IStreamingStt
    {
        public string Name => "failing-stt";

        public async IAsyncEnumerable<SttEvent> TranscribeAsync(
            IAsyncEnumerable<AudioFrame> audio, SttOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            if (error is not null) throw error;
            yield break;
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

    /// <summary>
    /// Emits a final as soon as the first audio frame arrives, then keeps listening. Records each run's language
    /// and counts every frame it was given.
    /// </summary>
    private sealed class FirstFrameStt : IStreamingStt
    {
        public readonly List<string> Languages = [];
        public int Frames;
        public string Name => "first-frame-stt";

        public async IAsyncEnumerable<SttEvent> TranscribeAsync(
            IAsyncEnumerable<AudioFrame> audio, SttOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            lock (Languages) Languages.Add(options.Language);
            var first = true;
            await foreach (var _ in audio.WithCancellation(ct))
            {
                Interlocked.Increment(ref Frames);
                if (!first) continue;
                first = false;
                yield return new SttFinal("Hello.", true, 0.9);
            }
        }
    }

    /// <summary>Holds every translation until the test releases it, so a direction change can arrive mid-turn.</summary>
    private sealed class GatedTranslator : IStreamingTranslator
    {
        public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "gated-translator";

        public async IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            Started.TrySetResult();
            await Release.Task.WaitAsync(ct);
            yield return request.SourceLanguage == "English" ? "Hola." : "Hello.";
        }
    }

    private async Task<(WebSocket Ws, FakeStt Stt)> Connect(
        string? serverToken = Token, IStreamingTts? tts = null, IStreamingStt? sttOverride = null, int? maxSessionSeconds = null,
        int permitLimit = 100, string sttKey = "deepgram", IStreamingTranslator? translator = null,
        params (string Key, string Value)[] settings)
    {
        var stt = new FakeStt();
        var server = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("Access:Token", serverToken ?? "");
            b.UseSetting("Access:PermitLimit", permitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (maxSessionSeconds is { } max) b.UseSetting("Cascade:MaxSessionSeconds", max.ToString(System.Globalization.CultureInfo.InvariantCulture));
            // The fake STT is registered under the default "deepgram" key. Without a Deepgram key in the
            // environment (CI has only OPENAI_API_KEY) the STT fallback would switch the session to the real
            // openai adapter, so pin a placeholder here; a test about the fallback overrides it via settings.
            b.UseSetting("DEEPGRAM_API_KEY", "test-placeholder-not-a-key");
            foreach (var (key, value) in settings) b.UseSetting(key, value);
            b.ConfigureServices(s =>
            {
                s.AddKeyedSingleton<IStreamingStt>(sttKey, sttOverride ?? stt);
                s.AddKeyedSingleton<IStreamingTranslator>("openai", translator ?? new FakeTranslator());
                s.AddKeyedSingleton<IStreamingTts>("elevenlabs", tts ?? new FakeTts());
            });
        }).Server;
        var ws = await server.CreateWebSocketClient().ConnectAsync(new Uri(server.BaseAddress, "ws/cascade"), TestContext.Current.CancellationToken);
        return (ws, stt);
    }

    private static async Task Start(WebSocket ws, string source = "en", string target = "es")
    {
        await Send(ws, new { type = "start", token = Token, source, target });
        var ready = Json(await WebSocketText.ReceiveAsync(ws, TestContext.Current.CancellationToken));
        Assert.Equal("ready", (string?)ready["type"]);
    }

    private static Task SendFrame(WebSocket ws) =>
        ws.SendAsync(new byte[640], WebSocketMessageType.Binary, true, TestContext.Current.CancellationToken);

    /// <summary>Reads text messages until one of the type arrives; a close first fails the test.</summary>
    private static async Task<JsonNode> ReadUntil(WebSocket ws, string type)
    {
        while (true)
        {
            var m = await WebSocketText.ReceiveAsync(ws, TestContext.Current.CancellationToken);
            if (m.Close is not null) Assert.Fail($"The socket closed ({m.Close}) before a {type} message");
            if (m.Type != WebSocketMessageType.Text) continue;
            var json = Json(m);
            if ((string?)json["type"] == type) return json;
        }
    }

    /// <summary>Reads every message up to and including the first text message of the type; a close first fails the test.</summary>
    private static async Task<List<WebSocketText.Message>> ReadThrough(WebSocket ws, string type)
    {
        var all = new List<WebSocketText.Message>();
        while (true)
        {
            var m = await WebSocketText.ReceiveAsync(ws, TestContext.Current.CancellationToken);
            if (m.Close is not null) Assert.Fail($"The socket closed ({m.Close}) before a {type} message");
            all.Add(m with { Data = m.Data.ToArray() });
            if (m.Type == WebSocketMessageType.Text && (string?)Json(m)["type"] == type) return all;
        }
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

    [Fact]
    public async Task Ends_the_session_at_the_duration_limit_and_says_why()
    {
        // G19: the client never sends stop; the server's limit ends the audio, finishes the turn and closes.
        var (ws, stt) = await Connect(maxSessionSeconds: 1);
        await Send(ws, new { type = "start", token = Token, source = "en", target = "es" });
        await ws.SendAsync(new byte[640], WebSocketMessageType.Binary, true, TestContext.Current.CancellationToken);

        var messages = await ReadAll(ws);

        var texts = messages.Where(m => m.Type == WebSocketMessageType.Text && m.Close is null).Select(Json).ToList();
        Assert.Contains(texts, m => (string?)m["type"] == "translation.final");
        var error = texts.Last(m => (string?)m["type"] == "error");
        Assert.Equal("session", (string?)error["stage"]);
        Assert.Contains("limit", (string?)error["message"]);
        Assert.NotNull(messages[^1].Close);
        Assert.Equal(1, stt.Frames);
    }

    [Fact]
    public async Task An_stt_failure_tells_the_client_which_setting_is_missing()
    {
        var error = new ProviderException(ProviderErrorKind.Auth, "deepgram", "DEEPGRAM_API_KEY is not configured on the server");
        var (ws, _) = await Connect(sttOverride: new FailingStt(error));
        await Start(ws);

        await SendFrame(ws);
        var messages = await ReadAll(ws);

        var frame = messages.Where(m => m.Type == WebSocketMessageType.Text && m.Close is null).Select(Json)
            .Single(j => (string?)j["type"] == "error");
        Assert.Equal(("stt", "deepgram", "Auth"), ((string?)frame["stage"], (string?)frame["provider"], (string?)frame["kind"]));
        Assert.Equal("DEEPGRAM_API_KEY is not configured on the server", (string?)frame["message"]);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
    }

    [Fact]
    public async Task Switches_direction_eleven_times_on_one_socket_and_one_rate_limit_permit()
    {
        // A speaker flip used to reopen the socket, and each upgrade spent one of the per-client permits
        // (10 a minute): the 11th flip in a minute got a 429. Now the flip is a message on the open socket.
        var stt = new FirstFrameStt();
        var (ws, _) = await Connect(sttOverride: stt, permitLimit: 1);
        await Start(ws);

        for (var i = 0; i < 11; i++)
        {
            var (source, target) = i % 2 == 0 ? ("es", "en") : ("en", "es");
            await Send(ws, new { type = "direction", source, target });
            var ack = await ReadUntil(ws, "direction");
            Assert.Equal((source, target), ((string?)ack["source"], (string?)ack["target"]));
        }
        await SendFrame(ws);
        await Send(ws, new { type = "stop" });
        var messages = await ReadAll(ws);

        var json = messages.Where(m => m.Type == WebSocketMessageType.Text && m.Close is null).Select(Json).ToList();
        Assert.DoesNotContain(json, j => (string?)j["type"] == "error");
        Assert.Equal("Hello.", (string?)json.Single(j => (string?)j["type"] == "transcript.final")["text"]);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
        // The last turn ran in the eleventh flip's direction (es>en).
        Assert.Equal("es", stt.Languages[^1]);
    }

    [Fact]
    public async Task A_direction_change_keeps_counting_utterances_and_carries_the_finished_turns_as_context()
    {
        var translator = new FakeTranslator();
        var (ws, _) = await Connect(sttOverride: new FirstFrameStt(), translator: translator);
        await Start(ws);

        await SendFrame(ws);
        Assert.Equal(1, (int?)(await ReadUntil(ws, "utterance.done"))["u"]);
        await Send(ws, new { type = "direction", source = "es", target = "en" });
        await ReadUntil(ws, "direction");
        await SendFrame(ws);
        var done = await ReadUntil(ws, "utterance.done");
        await Send(ws, new { type = "stop" });
        var messages = await ReadAll(ws);

        Assert.Equal(2, (int?)done["u"]);
        Assert.Equal(2, translator.Requests.Count);
        Assert.Equal(("Spanish", "English"), (translator.Requests[1].SourceLanguage, translator.Requests[1].TargetLanguage));
        Assert.Equal([("Hello.", "Hola.")], translator.Requests[1].Context!);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
    }

    [Fact]
    public async Task A_direction_change_finishes_the_turn_in_flight_before_the_new_direction_starts()
    {
        // A listener taps the other speaker a couple of seconds after a sentence, while it is still being
        // interpreted. The turn is delivered in full before the direction ack and the new leg's output, the
        // socket keeps answering while it drains, and nothing the new speaker says meanwhile is lost.
        var stt = new FirstFrameStt();
        var translator = new GatedTranslator();
        var (ws, _) = await Connect(sttOverride: stt, translator: translator);
        var ct = TestContext.Current.CancellationToken;
        await Start(ws);

        await SendFrame(ws);
        await translator.Started.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        await Send(ws, new { type = "direction", source = "es", target = "en" });
        // The switch was taken while the turn still waits on the translator, and the socket still answers.
        await Send(ws, new { type = "ping", c = 7.0 });
        var untilPong = await ReadThrough(ws, "pong");
        // The new speaker talks while the old direction finishes: more than the old 5 s queue held.
        for (var i = 0; i < 300; i++) await SendFrame(ws);
        translator.Release.SetResult();
        var untilAck = await ReadThrough(ws, "direction");
        var second = await ReadUntil(ws, "utterance.done");
        await Send(ws, new { type = "stop" });
        var rest = await ReadAll(ws);

        var drained = untilPong.Concat(untilAck).ToList();
        var json = drained.Where(m => m.Type == WebSocketMessageType.Text).Select(Json).ToList();
        Assert.Equal(7.0, (double?)json.Single(j => (string?)j["type"] == "pong")["c"]);
        var final = json.Single(j => (string?)j["type"] == "transcript.final");
        Assert.Equal(("Hello.", 1), ((string?)final["text"], (int?)final["u"]));
        var translated = json.Single(j => (string?)j["type"] == "translation.final");
        Assert.Equal(("Hola.", 1), ((string?)translated["text"], (int?)translated["u"]));
        Assert.Equal("Hola.", Encoding.UTF8.GetString(drained.Single(m => m.Type == WebSocketMessageType.Binary).Data.Span));
        Assert.Equal(1, (int?)json.Single(j => (string?)j["type"] == "utterance.done")["u"]);
        Assert.Equal(("direction", "es", "en"), ((string?)json[^1]["type"], (string?)json[^1]["source"], (string?)json[^1]["target"]));
        // The new direction's turn follows the ack, on every frame the new speaker sent during the drain.
        Assert.Equal(2, (int?)second["u"]);
        Assert.Equal(["en", "es"], stt.Languages);
        Assert.Equal(301, stt.Frames);
        Assert.DoesNotContain(
            drained.Concat(rest).Where(m => m.Type == WebSocketMessageType.Text && m.Close is null).Select(Json),
            j => (string?)j["type"] == "error");
        Assert.Equal(WebSocketCloseStatus.NormalClosure, rest[^1].Close);
    }

    [Fact]
    public async Task Audio_dropped_while_the_previous_direction_finished_is_reported()
    {
        // The next leg's queue holds about 30 s. A drain longer than that (a stalled provider) loses the oldest
        // of the new speaker's audio, and the client is told how much when the new direction starts.
        var stt = new FirstFrameStt();
        var translator = new GatedTranslator();
        var (ws, _) = await Connect(sttOverride: stt, translator: translator);
        var ct = TestContext.Current.CancellationToken;
        await Start(ws);

        await SendFrame(ws);
        await translator.Started.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        await Send(ws, new { type = "direction", source = "es", target = "en" });
        const int extra = 100; // 100 frames of 320 samples: 2 s
        for (var i = 0; i < CascadeEndpoints.AudioQueueFrames + extra; i++) await SendFrame(ws);
        // The pong proves every frame is queued (and the overflow dropped) before the old direction can finish.
        await Send(ws, new { type = "ping", c = 8.0 });
        await ReadUntil(ws, "pong");
        translator.Release.SetResult();
        await ReadUntil(ws, "direction");
        var error = await ReadUntil(ws, "error");
        await Send(ws, new { type = "stop" });
        var messages = await ReadAll(ws);

        Assert.Equal(("session", "Unavailable"), ((string?)error["stage"], (string?)error["kind"]));
        Assert.Contains("the first 2 s of this speaker's audio", (string?)error["message"]);
        Assert.Equal(1 + CascadeEndpoints.AudioQueueFrames, stt.Frames);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
    }

    [Fact]
    public async Task An_unsupported_direction_is_reported_and_the_session_goes_on()
    {
        var (ws, _) = await Connect();
        await Start(ws);

        await Send(ws, new { type = "direction", source = "en", target = "fr" });
        var error = await ReadUntil(ws, "error");
        await Send(ws, new { type = "ping", c = 1.0 });
        var pong = await ReadUntil(ws, "pong");
        await Send(ws, new { type = "stop" });
        var messages = await ReadAll(ws);

        Assert.Equal(("session", "Unsupported language direction"), ((string?)error["stage"], (string?)error["message"]));
        Assert.Equal(1.0, (double?)pong["c"]);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, messages[^1].Close);
    }

    [Fact]
    public async Task Serves_with_the_openai_stt_adapter_when_only_an_openai_key_is_configured()
    {
        var (ws, _) = await Connect(sttKey: "openai", sttOverride: new FirstFrameStt(),
            settings: [("Cascade:Stt", "deepgram"), ("DEEPGRAM_API_KEY", ""), ("OPENAI_API_KEY", "endpoint-test-placeholder-value")]);

        await Send(ws, new { type = "start", token = Token, source = "en", target = "es" });
        var ready = Json(await WebSocketText.ReceiveAsync(ws, TestContext.Current.CancellationToken));
        await Send(ws, new { type = "stop" });
        await ReadAll(ws);

        Assert.Equal(("ready", "first-frame-stt"), ((string?)ready["type"], (string?)ready["stt"]));
    }
}
