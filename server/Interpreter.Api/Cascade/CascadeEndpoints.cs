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
/// <c>direction</c> message on the same socket, not a new upgrade: the pipeline restarts for the new languages
/// (the utterance in flight is dropped, D12) and the finished turns stay as context (G9).
/// Transcripts, translations and audio are never logged.
/// </summary>
public static class CascadeEndpoints
{
    public const string Path = "/ws/cascade";

    public static IEndpointRouteBuilder MapCascadeEndpoints(this IEndpointRouteBuilder app)
    {
        app.Map(Path, Handle).RequireRateLimiting(AccessControl.RateLimitPolicy);
        // Which vendors a cascade session will send audio and text to, for the consent notice (G7). No live calls.
        app.MapGet("/api/cascade/providers", (IOptions<CascadeOptions> o) =>
            Results.Ok(new { stt = o.Value.Stt, translator = o.Value.Translator, tts = o.Value.Tts }));
        return app;
    }

    /// <summary>
    /// One direction's pipeline run. It has its own audio queue and cancellation, so a switch drops the old
    /// direction's queued audio with its pipeline instead of feeding it to the new STT language.
    /// </summary>
    private sealed class Leg : IDisposable
    {
        private readonly CancellationTokenRegistration _onLimit;

        public Leg(string source, string target, CancellationToken session, CancellationToken limit)
        {
            Source = source;
            Target = target;
            Stop = CancellationTokenSource.CreateLinkedTokenSource(session);
            // G19: at the limit, end the audio (the pipeline finishes queued turns) and the session closes.
            _onLimit = limit.Register(() => Audio.Writer.TryComplete());
        }

        public string Source { get; }
        public string Target { get; }

        // About 5 s of 20 ms frames. If STT falls that far behind, the oldest audio is dropped rather than
        // stalling this socket (and its pings); a stalled STT is already reported as an error.
        public Channel<AudioFrame> Audio { get; } = Channel.CreateBounded<AudioFrame>(
            new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });

        /// <summary>Cancelled when the client switches direction (or the session ends).</summary>
        public CancellationTokenSource Stop { get; }

        public void Dispose()
        {
            _onLimit.Dispose();
            Stop.Dispose();
        }
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
        // current leg and queues the next one on this same socket.
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(opts.MaxSessionSeconds), time);
        var legs = Channel.CreateUnbounded<Leg>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        var firstLeg = new Leg(source, target, stop.Token, limit.Token);
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
                    // Sent once the old pipeline is gone: everything after this belongs to the new direction.
                    await SendJson(new { type = "direction", source = leg.Source, target = leg.Target, t = Now() });
                    log.LogInformation("Cascade direction changed: {Source}>{Target}", leg.Source, leg.Target);
                }
                if (!await RunLegAsync(leg)) break;
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
        /// Runs one direction until its audio ends. True when the client switched direction (the next leg is
        /// queued); false when the audio ran out or STT failed, which ends the session as before.
        /// </summary>
        async Task<bool> RunLegAsync(Leg leg)
        {
            var terms = start.Glossary ? glossary.For(leg.Source, leg.Target) : null;
            var settings = new CascadeSettings(
                leg.Source, languages.Find(leg.Source)!.Name, leg.Target, languages.Find(leg.Target)!.Name,
                Voice: opts.Voices.GetValueOrDefault(leg.Target),
                Keyterms: terms?.Keys.ToList(),
                Glossary: terms,
                History: history.TakeLast(CascadeProtocol.MaxHistoryPairs).ToList(),
                FirstUtterance: nextUtterance);
            try
            {
                await foreach (var e in pipeline.RunAsync(leg.Audio.Reader.ReadAllAsync(leg.Stop.Token), settings, leg.Stop.Token, clock))
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
                return false;
            }
            catch (OperationCanceledException) when (leg.Stop.IsCancellationRequested && !stop.IsCancellationRequested)
            {
                // The client switched speaker: this direction's utterance in flight is dropped (D12).
                return true;
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
                        leg.Audio.Writer.TryWrite(new AudioFrame(msg.Data.ToArray(), 16000));
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
                        var next = new Leg(s, t, stop.Token, limit.Token);
                        all.Add(next);
                        legs.Writer.TryWrite(next);
                        // The old leg's queued audio goes with its pipeline; the next leg starts clean.
                        leg.Audio.Writer.TryComplete();
                        await leg.Stop.CancelAsync();
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
