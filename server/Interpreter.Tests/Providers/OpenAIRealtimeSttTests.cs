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
    private static OpenAIRealtimeStt Stt(Uri? baseUrl = null) =>
        new(Options.Create(new OpenAITranscriptionOptions
        {
            ApiKey = "test-key",
            BaseUrl = baseUrl ?? new Uri("wss://api.openai.com/v1/"),
            DrainTimeoutMs = 2000,
        }));

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

        var started = DateTime.UtcNow;
        var events = await Collect(Stt(server.BaseUrl).TranscribeAsync(Audio(2), new SttOptions("en"), TestContext.Current.CancellationToken));

        Assert.Empty(events);
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(1.5), "should not wait for the drain timeout");
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
