using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Interpreter.Api.Health;
using Interpreter.Api.Security;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Languages;
using Interpreter.Core.Net;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Cascade;

/// <summary>
/// The cascade WebSocket (D5): browser audio in, transcripts, translation, latency marks and TTS audio out,
/// with every provider key on the server. Guarded like Realtime session minting (G2): the per-client rate
/// limit applies to the upgrade, and the demo token must arrive in the first message. A speaker switch is a
/// <c>direction</c> message on the same socket, not a new upgrade: the pipeline finishes the turn in flight
/// and delivers it, then runs the new direction with the finished turns as context (G9). Only a mode switch
/// drops an utterance (D12). Transcripts, translations and audio are never logged.
/// </summary>
public static class CascadeEndpoints
{
    public const string Path = "/ws/cascade";

    /// <summary>Client mic audio is 16 kHz PCM16 mono (D6).</summary>
    private const int SttRate = 16000;

    /// <summary>
    /// Frames a leg queues ahead of its STT: about 30 s of 20 ms frames. While the previous direction finishes
    /// its turn, the new speaker's frames wait here, so the queue is sized for the longest drain the providers'
    /// timeouts allow, not just the few seconds STT may fall behind. A full queue drops its oldest frame rather
    /// than stalling the socket (and its pings); a drop while waiting for the previous direction is reported.
    /// </summary>
    public const int AudioQueueFrames = 1500;

    public static IEndpointRouteBuilder MapCascadeEndpoints(this IEndpointRouteBuilder app)
    {
        app.Map(Path, Handle).RequireRateLimiting(AccessControl.RateLimitPolicy);
        // Which vendors a cascade session will send audio and text to, for the consent notice (G7). No live calls.
        app.MapGet("/api/cascade/providers", (IOptions<CascadeOptions> o) =>
            Results.Ok(new { stt = o.Value.Stt, translator = o.Value.Translator, tts = o.Value.Tts }));
        return app;
    }

    /// <summary>
    /// One direction's pipeline run, with its own audio queue. A speaker switch ends this queue and opens the
    /// next leg's: the pipeline finishes the turn in flight on what was captured (STT endpoint, translation,
    /// TTS) and delivers it, while the new speaker's audio waits for the next leg instead of reaching the old
    /// STT language. Nothing cancels a leg short of the session ending.
    /// </summary>
    private sealed class Leg : IDisposable
    {
        private readonly CancellationTokenRegistration _onLimit;
        private long _droppedSamples;

        public Leg(string source, string target, CancellationToken limit)
        {
            Source = source;
            Target = target;
            Audio = Channel.CreateBounded<AudioFrame>(
                new BoundedChannelOptions(AudioQueueFrames) { FullMode = BoundedChannelFullMode.DropOldest },
                dropped => Interlocked.Add(ref _droppedSamples, dropped.Pcm16.Length / 2));
            // G19: at the limit, end the audio (the pipeline finishes queued turns) and the session closes.
            _onLimit = limit.Register(() => Audio.Writer.TryComplete());
        }

        public string Source { get; }
        public string Target { get; }

        public Channel<AudioFrame> Audio { get; }

        /// <summary>
        /// Set when the client switched away from this leg: the next leg is queued and runs once this one has
        /// delivered everything. Otherwise the audio ended with the session (stop, close or the limit).
        /// </summary>
        public volatile bool Switched;

        /// <summary>Seconds of audio dropped from a full queue so far.</summary>
        public double DroppedSeconds => Interlocked.Read(ref _droppedSamples) / (double)SttRate;

        public void Dispose() => _onLimit.Dispose();
    }

    private static async Task Handle(
        HttpContext http,
        IServiceProvider services,
        IOptions<CascadeOptions> cascade,
        IOptions<AccessOptions> access,
        LanguageCatalog languages,
        Glossary glossary,
        ProviderActivity activity,
        ILoggerFactory loggers)
    {
        if (!http.WebSockets.IsWebSocketRequest)
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var log = loggers.CreateLogger("Interpreter.Cascade");
        using var ws = await http.WebSockets.AcceptWebSocketAsync();
        var time = TimeProvider.System;
        var clock = time.GetTimestamp();
        double Now() => time.GetElapsedTime(clock).TotalMilliseconds;
        var send = new SemaphoreSlim(1, 1);
        var ct = http.RequestAborted;

        async Task SendJson(object message)
        {
            await send.WaitAsync(ct);
            try { await WebSocketText.SendTextAsync(ws, JsonSerializer.Serialize(message, CascadeProtocol.Json), ct); }
            finally { send.Release(); }
        }

        Task SendSessionError(string reason, ProviderErrorKind kind) =>
            SendJson(CascadeProtocol.Error(null, "session", "workbench", kind, reason, Now()));

        async Task Refuse(string reason, ProviderErrorKind kind)
        {
            await SendSessionError(reason, kind);
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None);
        }

        // 1. Start message: token, direction, optional translator.
        CascadeProtocol.Start? start;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(cascade.Value.StartTimeoutSeconds));
            var first = await WebSocketText.ReceiveAsync(ws, timeout.Token, maxBytes: 16 * 1024);
            start = first.Type == WebSocketMessageType.Text
                ? JsonSerializer.Deserialize<CascadeProtocol.Start>(first.Data.Span, CascadeProtocol.Json)
                : null;
        }
        catch (Exception e) when (e is OperationCanceledException or JsonException or WebSocketException)
        {
            start = null;
        }
        if (ws.State != WebSocketState.Open) return;
        if (start is not { Type: "start" })
        {
            await Refuse("The first message must be a start message", ProviderErrorKind.Auth);
            return;
        }

        var expected = access.Value.Token;
        if (string.IsNullOrEmpty(expected))
        {
            await Refuse("Server access token is not configured. Set DEMO_ACCESS_TOKEN on the server.", ProviderErrorKind.Auth);
            return;
        }
        if (!AccessControl.TokensMatch(start.Token ?? "", expected))
        {
            await Refuse("Missing or wrong access token.", ProviderErrorKind.Auth);
            return;
        }
        if (start.Source is not { } source || start.Target is not { } target || !languages.IsSupportedDirection(source, target))
        {
            await Refuse("Unsupported language direction", ProviderErrorKind.Unavailable);
            return;
        }

        var opts = cascade.Value;
        var translatorName = start.Translator ?? opts.Translator;
        var stt = services.GetKeyedService<IStreamingStt>(opts.Stt);
        var translator = services.GetKeyedService<IStreamingTranslator>(translatorName);
        var tts = services.GetKeyedService<IStreamingTts>(opts.Tts);
        if (stt is null || translator is null || tts is null)
        {
            await Refuse("Unknown cascade provider", ProviderErrorKind.Unavailable);
            return;
        }

        await SendJson(new { type = "ready", stt = stt.Name, translator = translator.Name, tts = tts.Name, t = Now() });
        log.LogInformation("Cascade session started: {Source}>{Target} stt={Stt} translator={Translator} tts={Tts}",
            source, target, stt.Name, translator.Name, tts.Name);

        // 2. Audio and control in, pipeline events out. One leg per direction: a direction message ends the
        // current leg's audio and queues the next leg, which runs on this same socket once the current one has
        // delivered its last turn.
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(opts.MaxSessionSeconds), time);
        var legs = Channel.CreateUnbounded<Leg>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        var firstLeg = new Leg(source, target, limit.Token);
        var all = new List<Leg> { firstLeg };
        legs.Writer.TryWrite(firstLeg);
        // Finished turns on this socket (after the ones the client carried over), context for the next leg (G9).
        var history = new List<(string Source, string Target)>(CascadeProtocol.History(start));
        // Utterance ids keep counting across legs, so the client never sees one twice.
        var nextUtterance = 1;
        var receive = ReceiveAsync(firstLeg);
        var pipeline = new CascadePipeline(stt, translator, tts, time);
        try
        {
            await foreach (var leg in legs.Reader.ReadAllAsync(stop.Token))
            {
                if (leg != firstLeg)
                {
                    // Sent once the previous leg has delivered its last turn: everything after this belongs to
                    // the new direction.
                    await SendJson(new { type = "direction", source = leg.Source, target = leg.Target, t = Now() });
                    log.LogInformation("Cascade direction changed: {Source}>{Target}", leg.Source, leg.Target);
                    var dropped = leg.DroppedSeconds;
                    if (dropped > 0)
                    {
                        // The previous direction took longer to finish than this queue holds (a stalled
                        // provider): the start of this speaker's turn is gone, and they are told so.
                        log.LogWarning("Cascade direction {Source}>{Target} started with {Seconds:0.0} s of audio dropped while the previous direction finished",
                            leg.Source, leg.Target, dropped);
                        await SendSessionError(
                            $"The previous direction took too long to finish: the first {dropped:0.#} s of this speaker's audio were not interpreted.",
                            ProviderErrorKind.Unavailable);
                    }
                }
                await RunLegAsync(leg);
                // After a switch the next leg is already queued. Otherwise the audio ended with the session
                // (stop, close or the limit) or STT failed, and the session ends as before.
                if (!leg.Switched) break;
            }
            if (limit.IsCancellationRequested)
            {
                await SendSessionError(
                    $"This session reached the {opts.MaxSessionSeconds / 60.0:0.#}-minute limit. Start a new session to continue.",
                    ProviderErrorKind.Unavailable);
                log.LogInformation("Cascade session ended: duration limit");
            }
            else log.LogInformation("Cascade session ended normally");
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            log.LogInformation("Cascade session ended: client went away");
        }
        catch (WebSocketException)
        {
            log.LogInformation("Cascade session ended: socket dropped");
        }
        finally
        {
            await stop.CancelAsync();
            await receive.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            foreach (var leg in all) leg.Dispose();
            await WebSocketText.CloseQuietlyAsync(ws);
        }

        /// <summary>
        /// Runs one direction until its audio has ended and the pipeline has delivered every turn it captured
        /// (or STT failed). A speaker switch only ends the audio: the drain is bounded by the providers' own
        /// timeouts, and nothing here cuts it short of the session ending.
        /// </summary>
        async Task RunLegAsync(Leg leg)
        {
            var terms = start.Glossary ? glossary.For(leg.Source, leg.Target) : null;
            var settings = new CascadeSettings(
                leg.Source, languages.Find(leg.Source)!.Name, leg.Target, languages.Find(leg.Target)!.Name,
                Voice: opts.Voices.GetValueOrDefault(leg.Target),
                Keyterms: terms?.Keys.ToList(),
                Glossary: terms,
                History: history.TakeLast(CascadeProtocol.MaxHistoryPairs).ToList(),
                FirstUtterance: nextUtterance);
            await foreach (var e in pipeline.RunAsync(leg.Audio.Reader.ReadAllAsync(stop.Token), settings, stop.Token, clock))
            {
                nextUtterance = Math.Max(nextUtterance, e.Utterance + 1);
                switch (e)
                {
                    case SourceFinal: activity.Success($"stt:{stt.Name}"); break;
                    case TranslationFinal f:
                        activity.Success($"translator:{translator.Name}");
                        if (f.Text.Length > 0) history.Add((f.Source, f.Text));
                        if (history.Count > CascadeProtocol.MaxHistoryPairs) history.RemoveAt(0);
                        break;
                    case LatencyMark { Name: "tts.first_byte" }: activity.Success($"tts:{tts.Name}"); break;
                }
                if (e is TtsAudio a)
                {
                    await send.WaitAsync(ct);
                    try { await ws.SendAsync(a.Audio.Pcm16, WebSocketMessageType.Binary, true, ct); }
                    finally { send.Release(); }
                }
                else if (CascadeProtocol.ToWire(e) is { } message)
                {
                    await SendJson(message);
                }
            }
        }

        async Task ReceiveAsync(Leg leg)
        {
            try
            {
                while (true)
                {
                    var msg = await WebSocketText.ReceiveAsync(ws, stop.Token, maxBytes: 64 * 1024);
                    if (msg.Close is not null)
                    {
                        // The client closed the socket: nobody is listening, so stop spending provider credit now.
                        await stop.CancelAsync();
                        break;
                    }
                    if (msg.Type == WebSocketMessageType.Binary)
                    {
                        if (limit.IsCancellationRequested) continue;
                        // Copy: the next receive reuses nothing, but the frame outlives this loop iteration.
                        // TryWrite never waits (a full queue drops its oldest frame, counted on the leg), so this
                        // loop keeps answering pings and reading stop while a previous direction drains.
                        leg.Audio.Writer.TryWrite(new AudioFrame(msg.Data.ToArray(), SttRate));
                        continue;
                    }
                    var control = JsonSerializer.Deserialize<CascadeProtocol.ClientMessage>(msg.Data.Span, CascadeProtocol.Json);
                    if (control?.Type == "ping") await SendJson(new { type = "pong", c = control.C, t = Now() });
                    else if (control?.Type == "stop") break;
                    else if (control?.Type == "direction")
                    {
                        if (control.Source is not { } s || control.Target is not { } t || !languages.IsSupportedDirection(s, t))
                        {
                            // Told, not closed: the current direction keeps running.
                            await SendSessionError("Unsupported language direction", ProviderErrorKind.Unavailable);
                            continue;
                        }
                        var next = new Leg(s, t, limit.Token);
                        all.Add(next);
                        legs.Writer.TryWrite(next);
                        // End the old leg's audio and let its pipeline finish: the turn in flight is delivered
                        // before the next leg runs. Frames from here on are the new speaker's and wait in the
                        // next leg's queue.
                        leg.Switched = true;
                        leg.Audio.Writer.TryComplete();
                        leg = next;
                    }
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or JsonException)
            {
            }
            finally
            {
                // End of audio: the pipeline finishes the queued utterances, then the socket closes.
                leg.Audio.Writer.TryComplete();
                legs.Writer.TryComplete();
            }
        }
    }
}
