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

namespace Interpreter.Providers.ElevenLabs;

/// <summary>
/// Streaming TTS over ElevenLabs' stream-input WebSocket: one socket per utterance, text sent as the flush
/// policy releases it, 24 kHz PCM back as soon as it is generated. <c>auto_mode</c> is on because the flush
/// policy already sends whole phrases.
/// </summary>
public sealed class ElevenLabsTts(IOptions<ElevenLabsOptions> options) : IStreamingTts
{
    private const string Provider = "elevenlabs";
    private const int Rate = 24000;
    private readonly ElevenLabsOptions _opts = options.Value;

    public string Name => Provider;

    public Uri StreamUri(TtsOptions o)
    {
        var voice = o.Voice ?? _opts.DefaultVoice;
        if (!_opts.StockVoices.Contains(voice))
            throw new ArgumentException($"Voice {voice} is not in ElevenLabs:StockVoices (stock voices only, guardrail G5)", nameof(o));
        if (o.SampleRate != Rate)
            throw new ArgumentException($"Only {Rate} Hz output is configured (D6)", nameof(o));
        var query = string.Join('&',
            $"model_id={Uri.EscapeDataString(_opts.Model)}",
            $"output_format=pcm_{Rate}",
            "auto_mode=true",
            $"inactivity_timeout={_opts.InactivityTimeoutSeconds}",
            $"language_code={Uri.EscapeDataString(o.Language)}");
        return new Uri(_opts.BaseUrl, $"text-to-speech/{Uri.EscapeDataString(voice)}/stream-input?{query}");
    }

    public async IAsyncEnumerable<AudioChunk> SynthesizeAsync(
        IAsyncEnumerable<string> textChunks, TtsOptions ttsOptions, [EnumeratorCancellation] CancellationToken ct)
    {
        var uri = StreamUri(ttsOptions);
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "ELEVENLABS_API_KEY is not configured on the server");

        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("xi-api-key", _opts.ApiKey);
        ws.Options.CollectHttpResponseDetails = true;
        await ConnectAsync(ws, uri, ct);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var audio = Channel.CreateUnbounded<AudioChunk>(new UnboundedChannelOptions { SingleWriter = true });
        var send = SendAsync(ws, textChunks, audio.Writer, stop.Token);
        var receive = ReceiveAsync(ws, audio.Writer, stop.Token);

        try
        {
            await foreach (var chunk in audio.Reader.ReadAllAsync(ct))
                yield return chunk;
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
            throw new ProviderException(ProviderErrorKind.Timeout, Provider, "Timed out connecting to ElevenLabs", inner: e);
        }
        catch (WebSocketException e)
        {
            throw ws.HttpStatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ProviderException(
                    ProviderErrorKind.Auth, Provider, $"ElevenLabs rejected the server key (HTTP {(int)ws.HttpStatusCode})", inner: e),
                HttpStatusCode.TooManyRequests => new ProviderException(
                    ProviderErrorKind.RateLimited, Provider, "ElevenLabs rate limited the connection", inner: e),
                _ => new ProviderException(ProviderErrorKind.Unavailable, Provider,
                    $"Could not open the ElevenLabs stream (HTTP {(int)ws.HttpStatusCode})", inner: e),
            };
        }
    }

    /// <summary>Opens with a single space (the protocol's start message), sends each chunk, then "" to finish.</summary>
    private static async Task SendAsync(WebSocket ws, IAsyncEnumerable<string> text, ChannelWriter<AudioChunk> audio, CancellationToken ct)
    {
        try
        {
            await WebSocketText.SendTextAsync(ws, """{"text":" "}""", ct);
            await foreach (var chunk in text.WithCancellation(ct))
            {
                if (chunk.Trim().Length == 0) continue;
                // Each chunk ends with a space so words across chunks don't run together.
                await WebSocketText.SendTextAsync(ws, new JsonObject { ["text"] = chunk.Trim() + " " }.ToJsonString(), ct);
            }
            await WebSocketText.SendTextAsync(ws, """{"text":""}""", ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (WebSocketException e)
        {
            audio.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "ElevenLabs stream closed while sending text", inner: e));
        }
        catch (Exception e)
        {
            audio.TryComplete(e);
        }
    }

    private static async Task ReceiveAsync(WebSocket ws, ChannelWriter<AudioChunk> audio, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                var msg = await WebSocketText.ReceiveAsync(ws, ct);
                if (msg.Close is { } status)
                {
                    audio.TryComplete(status is WebSocketCloseStatus.NormalClosure or WebSocketCloseStatus.Empty
                        ? null
                        : new ProviderException(
                            status == WebSocketCloseStatus.PolicyViolation ? ProviderErrorKind.Auth : ProviderErrorKind.Unavailable,
                            Provider, $"ElevenLabs closed the stream ({(int)status})"));
                    return;
                }
                if (msg.Type != WebSocketMessageType.Text) continue;

                using var doc = JsonDocument.Parse(msg.Data);
                var root = doc.RootElement;
                if (root.TryGetProperty("audio", out var b64) && b64.ValueKind == JsonValueKind.String
                    && b64.GetString() is { Length: > 0 } data)
                    await audio.WriteAsync(new AudioChunk(Convert.FromBase64String(data), Rate), ct);
                if (root.TryGetProperty("isFinal", out var final) && final.ValueKind == JsonValueKind.True)
                {
                    audio.TryComplete();
                    return;
                }
                if (root.TryGetProperty("error", out var error))
                {
                    audio.TryComplete(MapError(error.ToString()));
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            audio.TryComplete();
        }
        catch (WebSocketException e)
        {
            audio.TryComplete(new ProviderException(ProviderErrorKind.Unavailable, Provider, "ElevenLabs stream dropped", inner: e));
        }
    }

    private static ProviderException MapError(string error)
    {
        bool Has(string s) => error.Contains(s, StringComparison.OrdinalIgnoreCase);
        var kind = true switch
        {
            _ when Has("quota_exceeded") || Has("rate_limit") || Has("too_many_concurrent") => ProviderErrorKind.RateLimited,
            _ when Has("invalid_api_key") || Has("unauthorized") || Has("authentication") => ProviderErrorKind.Auth,
            _ => ProviderErrorKind.Unavailable,
        };
        return new ProviderException(kind, Provider, $"ElevenLabs stream error ({kind})");
    }
}
