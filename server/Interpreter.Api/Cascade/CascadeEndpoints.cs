using System.Net.WebSockets;
using System.Text.Json;
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
/// limit applies to the upgrade, and the demo token must arrive in the first message.
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

    private static async Task Handle(
        HttpContext http,
        IServiceProvider services,
        IOptions<CascadeOptions> cascade,
        IOptions<AccessOptions> access,
        LanguageCatalog languages,
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

        async Task Refuse(string reason, ProviderErrorKind kind)
        {
            await SendJson(new { type = "error", stage = "session", provider = "workbench", kind = kind.ToString(), message = reason, t = Now() });
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None);
        }

        // 1. Start message: token, direction, optional translator.
        CascadeProtocol.Start? start;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(cascade.Value.StartTimeoutSeconds));
            var first = await WebSocketText.ReceiveAsync(ws, timeout.Token, maxBytes: 4096);
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

        var settings = new CascadeSettings(
            source, languages.Find(source)!.Name, target, languages.Find(target)!.Name,
            Voice: opts.Voices.GetValueOrDefault(target));
        await SendJson(new { type = "ready", stt = stt.Name, translator = translator.Name, tts = tts.Name, t = Now() });
        log.LogInformation("Cascade session started: {Source}>{Target} stt={Stt} translator={Translator} tts={Tts}",
            source, target, stt.Name, translator.Name, tts.Name);

        // 2. Audio and control in, pipeline events out.
        // About 5 s of 20 ms frames. If STT falls that far behind, the oldest audio is dropped rather than
        // stalling this socket (and its pings); a stalled STT is already reported as an error.
        var audio = System.Threading.Channels.Channel.CreateBounded<AudioFrame>(
            new System.Threading.Channels.BoundedChannelOptions(256) { FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var receive = ReceiveAsync();
        var pipeline = new CascadePipeline(stt, translator, tts, time);
        try
        {
            await foreach (var e in pipeline.RunAsync(audio.Reader.ReadAllAsync(stop.Token), settings, stop.Token, clock))
            {
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
            log.LogInformation("Cascade session ended normally");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
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
            await WebSocketText.CloseQuietlyAsync(ws);
        }

        async Task ReceiveAsync()
        {
            try
            {
                while (true)
                {
                    var msg = await WebSocketText.ReceiveAsync(ws, stop.Token, maxBytes: 64 * 1024);
                    if (msg.Close is not null) break;
                    if (msg.Type == WebSocketMessageType.Binary)
                    {
                        // Copy: the next receive reuses nothing, but the frame outlives this loop iteration.
                        await audio.Writer.WriteAsync(new AudioFrame(msg.Data.ToArray(), 16000), stop.Token);
                        continue;
                    }
                    var control = JsonSerializer.Deserialize<CascadeProtocol.ClientMessage>(msg.Data.Span, CascadeProtocol.Json);
                    if (control?.Type == "ping") await SendJson(new { type = "pong", c = control.C, t = Now() });
                    else if (control?.Type == "stop") break;
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or JsonException)
            {
            }
            finally
            {
                // End of audio: the pipeline finishes the queued utterances, then the socket closes.
                audio.Writer.TryComplete();
            }
        }
    }
}
