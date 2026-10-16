using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

public class OpenAIRealtimeSttTests
{
    private static OpenAIRealtimeStt Stt(Uri? baseUrl = null, TimeProvider? time = null, Action<OpenAITranscriptionOptions>? configure = null)
    {
        var opts = new OpenAITranscriptionOptions
        {
            ApiKey = "test-key",
            BaseUrl = baseUrl ?? new Uri("wss://api.openai.com/v1/"),
            DrainTimeoutMs = 2000,
        };
        configure?.Invoke(opts);
        return new(Options.Create(opts), time);
    }

    /// <summary>A clock whose timers never fire: anything that waits on a drain timeout waits forever.</summary>
    private sealed class FrozenTime : TimeProvider
    {
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) => new NeverTimer();

        private sealed class NeverTimer : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period) => true;
            public void Dispose() { }
            public ValueTask DisposeAsync() => default;
        }
    }

    private static async IAsyncEnumerable<AudioFrame> Audio(int frames)
    {
        for (var i = 0; i < frames; i++)
        {
            await Task.Yield();
            yield return new AudioFrame(new byte[640], 16000); // 20 ms of 16 kHz silence
        }
    }

    private static async Task<List<SttEvent>> Collect(IAsyncEnumerable<SttEvent> events)
    {
        var list = new List<SttEvent>();
        await foreach (var e in events) list.Add(e);
        return list;
    }

    private static Task Send(WebSocket ws, string json) => WebSocketText.SendTextAsync(ws, json, default);

    [Fact]
    public void Session_is_a_24khz_transcription_session_with_server_vad()
    {
        var update = Stt().SessionUpdate(new SttOptions("es", Keyterms: ["ibuprofeno"]));
        var input = update["session"]!["audio"]!["input"]!;

        Assert.Equal("session.update", (string?)update["type"]);
        Assert.Equal("transcription", (string?)update["session"]!["type"]);
        Assert.Equal(24000, (int?)input["format"]!["rate"]);
        Assert.Equal("gpt-4o-transcribe", (string?)input["transcription"]!["model"]);
        Assert.Equal("es", (string?)input["transcription"]!["language"]);
        Assert.Equal("Vocabulary: ibuprofeno", (string?)input["transcription"]!["prompt"]);
        Assert.Equal("server_vad", (string?)input["turn_detection"]!["type"]);
        Assert.Equal("realtime?intent=transcription", Stt().SessionUri.PathAndQuery.TrimStart('/')[3..]);
    }

    [Fact]
    public void Client_endpointing_turns_off_server_vad()
    {
        var update = Stt(configure: o => o.Endpointing = "client").SessionUpdate(new SttOptions("en"));
        var input = update["session"]!["audio"]!["input"]!.AsObject();

        Assert.True(input.ContainsKey("turn_detection"));
        Assert.Null(input["turn_detection"]);
    }

    [Fact]
    public void Realtime_whisper_has_no_vad_and_no_prompt_and_takes_a_delay()
    {
        var update = Stt(configure: o => { o.Model = "gpt-realtime-whisper"; o.Delay = "low"; })
            .SessionUpdate(new SttOptions("es", Keyterms: ["ibuprofeno"]));
        var input = update["session"]!["audio"]!["input"]!.AsObject();

        Assert.Null(input["turn_detection"]);
        Assert.Equal("gpt-realtime-whisper", (string?)input["transcription"]!["model"]);
        Assert.Null(input["transcription"]!["prompt"]);
        Assert.Equal("low", (string?)input["transcription"]!["delay"]);
    }

    [Fact]
    public async Task Client_end_of_speech_commits_the_turn_and_marks_the_endpoint()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            // The client's commit, not the final one: audio keeps coming after it.
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"input_audio_buffer.committed","item_id":"a"}""");
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"a","transcript":"Hello."}""");
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.append"));
            // The final commit at the end of the audio finds nothing left.
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"error","error":{"type":"invalid_request_error","code":"input_audio_buffer_commit_empty","message":"buffer empty"}}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        static async IAsyncEnumerable<AudioFrame> Turn()
        {
            await foreach (var f in Audio(3)) yield return f;
            yield return AudioFrame.SpeechEnded(16000);
            await Task.Delay(200);
            await foreach (var f in Audio(2)) yield return f;
        }

        var events = await Collect(Stt(server.BaseUrl, configure: o => o.Endpointing = "client")
                .TranscribeAsync(Turn(), new SttOptions("en"), TestContext.Current.CancellationToken))
            .WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.Equal<SttEvent>([new SttEndpoint(), new SttFinal("Hello.", true)], events);
        Assert.Equal(2, server.Received.Count(m => m.Text.Contains("input_audio_buffer.commit")));
        Assert.Equal(5, server.Received.Count(m => m.Text.Contains("input_audio_buffer.append")));
    }

    [Fact]
    public async Task End_of_speech_is_ignored_with_server_vad()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"error","error":{"type":"invalid_request_error","code":"input_audio_buffer_commit_empty","message":"buffer empty"}}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        static async IAsyncEnumerable<AudioFrame> Turn()
        {
            await foreach (var f in Audio(2)) yield return f;
            yield return AudioFrame.SpeechEnded(16000);
        }

        var events = await Collect(Stt(server.BaseUrl).TranscribeAsync(Turn(), new SttOptions("en"), TestContext.Current.CancellationToken))
            .WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.Empty(events);
        Assert.Equal(1, server.Received.Count(m => m.Text.Contains("input_audio_buffer.commit")));
    }

    [Fact]
    public async Task Maps_vad_and_transcription_events_and_waits_for_the_last_transcript()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("session.update"));
            await Send(ws, """{"type":"input_audio_buffer.speech_started","item_id":"a"}""");
            await Send(ws, """{"type":"input_audio_buffer.speech_stopped","item_id":"a"}""");
            await Send(ws, """{"type":"input_audio_buffer.committed","item_id":"a"}""");
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.delta","item_id":"a","delta":"I have"}""");
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.delta","item_id":"a","delta":" a headache."}""");
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"a","transcript":"I have a headache."}""");
            // The client's final commit catches a turn that never paused; its transcript arrives later.
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"input_audio_buffer.committed","item_id":"b"}""");
            await Task.Delay(300);
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"b","transcript":"Since Monday."}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        var events = await Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(5), new SttOptions("en"), TestContext.Current.CancellationToken));

        Assert.Equal<SttEvent>(
        [
            new SttEndpoint(), new SttPartial("I have"), new SttPartial("I have a headache."),
            new SttFinal("I have a headache.", true), new SttFinal("Since Monday.", true),
        ], events);
        Assert.Equal("Bearer test-key", server.Authorization);
        Assert.DoesNotContain(server.Received, m => m.Text.Contains("OpenAI-Beta"));
        var appends = server.Received.Where(m => m.Text.Contains("input_audio_buffer.append")).ToList();
        Assert.Equal(5, appends.Count);
        // 640 bytes at 16 kHz become 960 bytes at 24 kHz.
        Assert.Equal(960, Convert.FromBase64String((string)JsonNode.Parse(appends[0].Text)!["audio"]!).Length);
    }

    [Fact]
    public async Task Empty_final_commit_ends_the_stream_promptly()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"error","error":{"type":"invalid_request_error","code":"input_audio_buffer_commit_empty","message":"buffer empty"}}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        // With a frozen clock the drain timeout can never fire, so the stream only ends if the empty-commit
        // error ended it; the WaitAsync below is the test's own guard against a hang, not a timing assertion.
        var events = await Collect(Stt(server.BaseUrl, new FrozenTime()).TranscribeAsync(Audio(2), new SttOptions("en"), TestContext.Current.CancellationToken))
            .WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.Empty(events);
    }

    [Fact]
    public async Task Rate_limit_error_ends_the_stream_with_a_provider_error()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("session.update"));
            await Send(ws, """{"type":"error","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"slow down"}}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(1000), new SttOptions("en"), TestContext.Current.CancellationToken)));

        Assert.Equal(ProviderErrorKind.RateLimited, e.Kind);
    }

    [Fact]
    public async Task Failed_transcription_closes_the_turn_without_inventing_text()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await Send(ws, """{"type":"input_audio_buffer.speech_stopped","item_id":"a"}""");
            await Send(ws, """{"type":"input_audio_buffer.committed","item_id":"a"}""");
            await Send(ws, """{"type":"conversation.item.input_audio_transcription.failed","item_id":"a","error":{"message":"x"}}""");
            await s.ReceiveUntil(ws, m => m.Text.Contains("input_audio_buffer.commit"));
            await Send(ws, """{"type":"error","error":{"code":"input_audio_buffer_commit_empty"}}""");
            await s.ReceiveUntil(ws, _ => false);
        });

        var events = await Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(1), new SttOptions("en"), TestContext.Current.CancellationToken));

        Assert.Equal<SttEvent>([new SttEndpoint(), new SttFinal("", true)], events);
    }
}
