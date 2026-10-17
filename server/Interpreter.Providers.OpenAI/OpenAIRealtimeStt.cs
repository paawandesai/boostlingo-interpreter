using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.OpenAI;

/// <summary>
/// Cascade STT on an OpenAI Realtime transcription session (the Deepgram fallback, see README "Known
/// constraints"). Event and field names follow the GA Realtime API as typed in the openai npm package
/// v7.33.0 (RealtimeTranscriptionSessionCreateRequest), checked by a live call on 2026-10-14.
/// <para>
/// Server VAD ends each turn: <c>input_audio_buffer.speech_stopped</c> becomes <see cref="SttEndpoint"/>
/// and the transcript follows as one final per turn. With client endpointing the client's end-of-speech frame
/// commits the buffer instead (and becomes the <see cref="SttEndpoint"/>). The session only takes 24 kHz PCM, so 16 kHz input is
/// resampled here.
/// </para>
/// </summary>
public sealed class OpenAIRealtimeStt(IOptions<OpenAITranscriptionOptions> options, TimeProvider? time = null) : IStreamingStt
{
    private const string Provider = "openai-transcribe";
    private const int SessionRate = 24000;
    private readonly OpenAITranscriptionOptions _opts = options.Value;
    /// <summary>Drives the drain timers after the audio ends; tests pass a frozen clock to prove nothing waits on them.</summary>
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public string Name => Provider;

    public Uri SessionUri => new(_opts.BaseUrl, "realtime?intent=transcription");

    /// <summary>The session.update sent on connect. Public so tests can check it without a socket.</summary>
    public JsonObject SessionUpdate(SttOptions o)
    {
        var transcription = new JsonObject { ["model"] = _opts.Model, ["language"] = o.Language };
        // gpt-realtime-whisper takes no prompt, so glossary terms reach only the translator there.
        if (o.Keyterms is { Count: > 0 } terms && !_opts.IsRealtimeWhisper)
            transcription["prompt"] = "Vocabulary: " + string.Join(", ", terms);
        if (_opts.IsRealtimeWhisper && _opts.Delay is { } delay) transcription["delay"] = delay;

        return new JsonObject
        {
            ["type"] = "session.update",
            ["session"] = new JsonObject
            {
                ["type"] = "transcription",
                ["audio"] = new JsonObject
                {
                    ["input"] = new JsonObject
                    {
                        ["format"] = new JsonObject { ["type"] = "audio/pcm", ["rate"] = SessionRate },
                        ["transcription"] = transcription,
                        ["noise_reduction"] = new JsonObject { ["type"] = "near_field" },
                        ["turn_detection"] = _opts.ClientEndpointing
                            ? null
                            : new JsonObject
                            {
                                ["type"] = "server_vad",
                                ["silence_duration_ms"] = _opts.SilenceDurationMs,
                            },
                    },
                },
            },
        };
    }

    public async IAsyncEnumerable<SttEvent> TranscribeAsync(
        IAsyncEnumerable<AudioFrame> audio, SttOptions sttOptions, [EnumeratorCancellation] CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "OPENAI_API_KEY is not configured on the server");

        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {_opts.ApiKey}");
        ws.Options.CollectHttpResponseDetails = true;
        await ConnectAsync(ws, ct);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var events = Channel.CreateUnbounded<SttEvent>(new UnboundedChannelOptions { SingleWriter = false });
        var turns = new Turns();
        var sendLock = new SemaphoreSlim(1, 1);

        await WebSocketText.SendTextAsync(ws, SessionUpdate(sttOptions).ToJsonString(), ct);
        var send = SendAsync(ws, audio, sendLock, turns, events.Writer, stop.Token);
        var receive = ReceiveAsync(ws, turns, events.Writer, stop.Token);

        try
        {
            await foreach (var e in events.Reader.ReadAllAsync(ct))
                yield return e;
        }
        finally
        {
            await stop.CancelAsync();
            await Task.WhenAll(send, receive).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            await WebSocketText.CloseQuietlyAsync(ws);
        }
    }

    private async Task ConnectAsync(ClientWebSocket ws, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            await ws.ConnectAsync(SessionUri, timeout.Token);
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new ProviderException(ProviderErrorKind.Timeout, Provider, "Timed out connecting to OpenAI transcription", inner: e);
        }
        catch (WebSocketException e)
        {
            throw ws.HttpStatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ProviderException(
                    ProviderErrorKind.Auth, Provider, $"OpenAI rejected the server key (HTTP {(int)ws.HttpStatusCode})", inner: e),
                HttpStatusCode.TooManyRequests => new ProviderException(
                    ProviderErrorKind.RateLimited, Provider, "OpenAI rate limited the connection", inner: e),
                _ => new ProviderException(ProviderErrorKind.Unavailable, Provider,
                    $"Could not open the OpenAI transcription session (HTTP {(int)ws.HttpStatusCode})", inner: e),
            };
        }
    }

    /// <summary>Tracks turns the server committed but hasn't transcribed yet, so the stream ends only after the last one.</summary>
    private sealed class Turns
    {
        private int _pending;
        private int _vadCommitsDue;
        public readonly TaskCompletionSource Drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource FinalCommitAcked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public volatile bool AudioEnded;

        /// <summary>Server VAD commits the buffer right after speech_stopped; a commit without one is ours.</summary>
        public void SpeechStopped() => Interlocked.Increment(ref _vadCommitsDue);

        /// <summary>A mid-stream commit of ours (client endpointing): its ack is not the final commit's.</summary>
        public void ClientCommitted() => Interlocked.Increment(ref _vadCommitsDue);

        /// <summary>An empty-buffer error answers a mid-stream commit if one is due, else the final commit.</summary>
        public void CommitEmpty()
        {
            if (Interlocked.Decrement(ref _vadCommitsDue) < 0)
            {
                Interlocked.Exchange(ref _vadCommitsDue, 0);
                FinalCommitAcked.TrySetResult();
            }
        }

        public void Committed()
        {
            Interlocked.Increment(ref _pending);
            if (Interlocked.Decrement(ref _vadCommitsDue) < 0)
            {
                Interlocked.Exchange(ref _vadCommitsDue, 0);
                FinalCommitAcked.TrySetResult();
            }
        }

        public void Settled()
        {
            if (Interlocked.Decrement(ref _pending) <= 0 && AudioEnded) Drained.TrySetResult();
        }

        public void CheckDrained()
        {
            if (Volatile.Read(ref _pending) <= 0 && AudioEnded) Drained.TrySetResult();
        }
    }

    private async Task SendAsync(
        WebSocket ws, IAsyncEnumerable<AudioFrame> audio, SemaphoreSlim sendLock, Turns turns,
        ChannelWriter<SttEvent> events, CancellationToken ct)
    {
        try
        {
            await foreach (var frame in audio.WithCancellation(ct))
            {
                if (frame.EndOfSpeech)
                {
                    if (!_opts.ClientEndpointing) continue;
                    turns.ClientCommitted();
                    // The endpoint goes out before the commit, so a fast transcript can never overtake it.
                    await events.WriteAsync(new SttEndpoint(), ct);
                    await sendLock.WaitAsync(ct);
                    try { await WebSocketText.SendTextAsync(ws, """{"type":"input_audio_buffer.commit"}""", ct); }
                    finally { sendLock.Release(); }
                    continue;
                }
                if (frame.Pcm16.IsEmpty) continue;
                var pcm = Pcm16.Resample(frame.Pcm16.Span, frame.SampleRate, SessionRate);
                var append = new JsonObject
                {
                    ["type"] = "input_audio_buffer.append",
                    ["audio"] = Convert.ToBase64String(pcm),
                };
                await sendLock.WaitAsync(ct);
                try { await WebSocketText.SendTextAsync(ws, append.ToJsonString(), ct); }
                finally { sendLock.Release(); }
            }

            // Commit whatever is still buffered (the speaker may not have paused), wait for the server to
            // acknowledge it (an empty buffer is answered with an error instead), then wait for the
            // outstanding transcripts before closing.
            await sendLock.WaitAsync(ct);
            try { await WebSocketText.SendTextAsync(ws, """{"type":"input_audio_buffer.commit"}""", ct); }
            finally { sendLock.Release(); }
            await turns.FinalCommitAcked.Task.WaitAsync(TimeSpan.FromSeconds(2), _time, ct)
                .ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            turns.AudioEnded = true;
            turns.CheckDrained();
            await turns.Drained.Task.WaitAsync(TimeSpan.FromMilliseconds(_opts.DrainTimeoutMs), _time, ct)
                .ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            events.TryComplete();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (WebSocketException e)
        {
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "OpenAI stream closed while sending audio", inner: e));
        }
        catch (Exception e)
        {
            events.TryComplete(e);
        }
    }

    private static async Task ReceiveAsync(WebSocket ws, Turns turns, ChannelWriter<SttEvent> events, CancellationToken ct)
    {
        // Deltas arrive per item; the pipeline wants the whole interim text, so accumulate them.
        var partials = new Dictionary<string, string>();
        try
        {
            while (true)
            {
                var msg = await WebSocketText.ReceiveAsync(ws, ct);
                if (msg.Close is { } status)
                {
                    events.TryComplete(status is WebSocketCloseStatus.NormalClosure or WebSocketCloseStatus.Empty
                        ? null
                        : new ProviderException(ProviderErrorKind.Unavailable, Provider, $"OpenAI closed the stream ({(int)status})"));
                    return;
                }
                if (msg.Type != WebSocketMessageType.Text) continue;

                using var doc = JsonDocument.Parse(msg.Data);
                var root = doc.RootElement;
                var itemId = root.TryGetProperty("item_id", out var id) ? id.GetString() ?? "" : "";
                switch (root.GetProperty("type").GetString())
                {
                    case "input_audio_buffer.speech_stopped":
                        turns.SpeechStopped();
                        await events.WriteAsync(new SttEndpoint(), ct);
                        break;
                    case "input_audio_buffer.committed":
                        turns.Committed();
                        break;
                    case "conversation.item.input_audio_transcription.delta":
                        var text = partials.GetValueOrDefault(itemId, "") + root.GetProperty("delta").GetString();
                        partials[itemId] = text;
                        await events.WriteAsync(new SttPartial(text), ct);
                        break;
                    case "conversation.item.input_audio_transcription.completed":
                        partials.Remove(itemId);
                        await events.WriteAsync(new SttFinal(root.GetProperty("transcript").GetString() ?? "", true), ct);
                        turns.Settled();
                        break;
                    case "conversation.item.input_audio_transcription.failed":
                        // Close the turn with no text; the transcript shows nothing rather than a guess.
                        partials.Remove(itemId);
                        await events.WriteAsync(new SttFinal("", true), ct);
                        turns.Settled();
                        break;
                    case "error":
                        if (root.GetProperty("error").TryGetProperty("code", out var code)
                            && code.GetString() == "input_audio_buffer_commit_empty")
                            turns.CommitEmpty();
                        if (MapError(root.GetProperty("error")) is { } error)
                        {
                            events.TryComplete(error);
                            return;
                        }
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            events.TryComplete();
        }
        catch (WebSocketException e)
        {
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "OpenAI stream dropped", inner: e));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // A message this loop could not read (malformed JSON, a missing field): without this the receive task
            // faults, no transcript ever comes, and the send loop keeps streaming billed audio.
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "Unreadable message from OpenAI transcription", inner: e));
        }
    }

    /// <summary>Null for errors that don't end the session.</summary>
    private static ProviderException? MapError(JsonElement error)
    {
        var code = error.TryGetProperty("code", out var c) ? c.GetString() : null;
        var type = error.TryGetProperty("type", out var t) ? t.GetString() : null;
        if (code == "input_audio_buffer_commit_empty") return null; // the final commit found nothing left
        var kind = (code, type) switch
        {
            ("rate_limit_exceeded", _) or (_, "rate_limit_error") => ProviderErrorKind.RateLimited,
            ("invalid_api_key", _) or (_, "authentication_error") => ProviderErrorKind.Auth,
            _ => ProviderErrorKind.Unavailable,
        };
        return new ProviderException(kind, Provider, $"OpenAI transcription error ({code ?? type ?? "unknown"})");
    }
}
