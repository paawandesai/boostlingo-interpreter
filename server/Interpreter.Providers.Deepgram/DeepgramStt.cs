using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.Deepgram;

/// <summary>
/// Streaming STT over Deepgram's live WebSocket. Every connection sets <c>mip_opt_out=true</c>, which opts
/// this audio out of Deepgram's Model Improvement Program (docs/GUARDRAILS.md, task G4). It is not
/// configurable on purpose.
/// </summary>
public sealed class DeepgramStt(IOptions<DeepgramOptions> options) : IStreamingStt
{
    private const string Provider = "deepgram";
    private static readonly TimeSpan KeepAliveEvery = TimeSpan.FromSeconds(5);
    private readonly DeepgramOptions _opts = options.Value;

    public string Name => Provider;

    /// <summary>The listen URL for these options. Public so the G4 contract test can check it without a socket.</summary>
    public Uri ListenUri(SttOptions o)
    {
        var query = new List<string>
        {
            $"model={Uri.EscapeDataString(_opts.Model)}",
            $"language={Uri.EscapeDataString(o.Language)}",
            "encoding=linear16",
            $"sample_rate={o.SampleRate}",
            "channels=1",
            "interim_results=true",
            "punctuate=true",
            $"smart_format={(_opts.SmartFormat ? "true" : "false")}",
            $"endpointing={_opts.EndpointingMs}",
            $"utterance_end_ms={_opts.UtteranceEndMs}",
            "vad_events=true",
            "mip_opt_out=true",
        };
        foreach (var term in o.Keyterms ?? []) query.Add($"keyterm={Uri.EscapeDataString(term)}");
        return new Uri(_opts.BaseUrl, "listen?" + string.Join('&', query));
    }

    public async IAsyncEnumerable<SttEvent> TranscribeAsync(
        IAsyncEnumerable<AudioFrame> audio, SttOptions sttOptions, [EnumeratorCancellation] CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "DEEPGRAM_API_KEY is not configured on the server");

        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Token {_opts.ApiKey}");
        ws.Options.CollectHttpResponseDetails = true;
        await ConnectAsync(ws, ListenUri(sttOptions), ct);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var events = Channel.CreateUnbounded<SttEvent>(new UnboundedChannelOptions { SingleWriter = true });
        var sendLock = new SemaphoreSlim(1, 1);
        var send = SendAsync(ws, audio, sendLock, events.Writer, stop.Token);
        var receive = ReceiveAsync(ws, events.Writer, stop.Token);

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

    private static async Task ConnectAsync(ClientWebSocket ws, Uri uri, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            await ws.ConnectAsync(uri, timeout.Token);
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new ProviderException(ProviderErrorKind.Timeout, Provider, "Timed out connecting to Deepgram", inner: e);
        }
        catch (WebSocketException e)
        {
            throw ws.HttpStatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ProviderException(
                    ProviderErrorKind.Auth, Provider, $"Deepgram rejected the server key (HTTP {(int)ws.HttpStatusCode})", inner: e),
                HttpStatusCode.TooManyRequests => new ProviderException(
                    ProviderErrorKind.RateLimited, Provider, "Deepgram rate limited the connection", inner: e),
                _ => new ProviderException(ProviderErrorKind.Unavailable, Provider,
                    $"Could not open the Deepgram stream (HTTP {(int)ws.HttpStatusCode})", inner: e),
            };
        }
    }

    /// <summary>Sends audio as binary frames, a KeepAlive during silence, then CloseStream so Deepgram flushes.</summary>
    private static async Task SendAsync(
        WebSocket ws, IAsyncEnumerable<AudioFrame> audio, SemaphoreSlim sendLock, ChannelWriter<SttEvent> events, CancellationToken ct)
    {
        var lastSend = Environment.TickCount64;
        using var keepAliveStop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var keepAlive = KeepAliveAsync(keepAliveStop.Token);
        try
        {
            await foreach (var frame in audio.WithCancellation(ct))
            {
                // Deepgram endpoints on its own (utterance_end); a client end-of-speech marker carries no audio.
                if (frame.Pcm16.IsEmpty) continue;
                await Locked(() => ws.SendAsync(frame.Pcm16, WebSocketMessageType.Binary, true, ct).AsTask());
                lastSend = Environment.TickCount64;
            }
            await keepAliveStop.CancelAsync();
            await keepAlive.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            await Locked(() => WebSocketText.SendTextAsync(ws, """{"type":"CloseStream"}""", ct));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (WebSocketException e)
        {
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "Deepgram stream closed while sending audio", inner: e));
        }
        catch (Exception e)
        {
            // The audio source failed (for example the client disconnected); end the stream with its error.
            events.TryComplete(e);
        }
        finally
        {
            await keepAliveStop.CancelAsync();
            await keepAlive.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        async Task Locked(Func<Task> send)
        {
            await sendLock.WaitAsync(ct);
            try { await send(); }
            finally { sendLock.Release(); }
        }

        // Deepgram closes a stream after about 10 s without data; the half-duplex mic gate can be that long.
        async Task KeepAliveAsync(CancellationToken stopToken)
        {
            while (!stopToken.IsCancellationRequested)
            {
                await Task.Delay(KeepAliveEvery, stopToken);
                if (TimeSpan.FromMilliseconds(Environment.TickCount64 - lastSend) >= KeepAliveEvery)
                    await Locked(() => WebSocketText.SendTextAsync(ws, """{"type":"KeepAlive"}""", stopToken));
            }
        }
    }

    private static async Task ReceiveAsync(WebSocket ws, ChannelWriter<SttEvent> events, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                var msg = await WebSocketText.ReceiveAsync(ws, ct);
                if (msg.Close is { } status)
                {
                    events.TryComplete(status is WebSocketCloseStatus.NormalClosure or WebSocketCloseStatus.Empty
                        ? null
                        : new ProviderException(ProviderErrorKind.Unavailable, Provider,
                            $"Deepgram closed the stream ({(int)status} {msg.CloseReason})"));
                    return;
                }
                if (msg.Type == WebSocketMessageType.Text && Parse(msg.Data.Span) is { } e)
                    await events.WriteAsync(e, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            events.TryComplete();
        }
        catch (WebSocketException e)
        {
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "Deepgram stream dropped", inner: e));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // A message Parse could not read: end the stream with an error instead of faulting silently.
            events.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "Unreadable message from Deepgram", inner: e));
        }
    }

    /// <summary>Maps one Deepgram message to an event, or null for messages the pipeline doesn't use.</summary>
    public static SttEvent? Parse(ReadOnlySpan<byte> json)
    {
        using var doc = JsonDocument.Parse(json.ToArray());
        var root = doc.RootElement;
        switch (root.TryGetProperty("type", out var type) ? type.GetString() : null)
        {
            case "Results":
                var alt = root.GetProperty("channel").GetProperty("alternatives")[0];
                var text = alt.GetProperty("transcript").GetString() ?? "";
                var isFinal = root.TryGetProperty("is_final", out var f) && f.GetBoolean();
                var speechFinal = root.TryGetProperty("speech_final", out var s) && s.GetBoolean();
                if (!isFinal) return text.Length > 0 ? new SttPartial(text) : null;
                double? confidence = alt.TryGetProperty("confidence", out var c) && c.ValueKind == JsonValueKind.Number
                    ? c.GetDouble()
                    : null;
                return new SttFinal(text, speechFinal, confidence);
            case "UtteranceEnd":
                return new SttUtteranceEnd();
            default:
                // Metadata, SpeechStarted: not used by the pipeline.
                return null;
        }
    }
}
