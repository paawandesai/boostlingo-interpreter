using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.OpenAI;

/// <summary>
/// Streaming TTS through POST /v1/audio/speech: one request per phrase the flush policy releases, with the
/// 24 kHz PCM16 body streamed back as it arrives. Requests run in order, so audio stays in phrase order.
/// Unlike ElevenLabs' socket the endpoint takes whole text, which is what the flush policy already sends.
/// </summary>
public sealed class OpenAISpeechTts(HttpClient http, IOptions<OpenAISpeechOptions> options) : IStreamingTts
{
    private const string Provider = "openai-tts";
    private const int Rate = 24000;
    private readonly OpenAISpeechOptions _opts = options.Value;

    public string Name => Provider;

    /// <summary>The request body for one phrase. Public so tests can check it without a request.</summary>
    public JsonObject Body(string text, TtsOptions o)
    {
        var voice = o.Voice ?? _opts.DefaultVoice;
        if (!_opts.StockVoices.Contains(voice))
            throw new ArgumentException($"Voice {voice} is not in OpenAI:Speech:StockVoices (stock voices only, guardrail G5)", nameof(o));
        if (o.SampleRate != Rate)
            throw new ArgumentException($"Only {Rate} Hz output is configured (D6)", nameof(o));
        return new JsonObject
        {
            ["model"] = _opts.Model,
            ["voice"] = voice,
            ["input"] = text,
            ["response_format"] = "pcm",
        };
    }

    public async IAsyncEnumerable<AudioChunk> SynthesizeAsync(
        IAsyncEnumerable<string> textChunks, TtsOptions ttsOptions, [EnumeratorCancellation] CancellationToken ct)
    {
        Body("", ttsOptions); // refuse a bad voice or rate before any text is sent
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "OPENAI_API_KEY is not configured on the server");

        await foreach (var text in textChunks.WithCancellation(ct))
        {
            if (string.IsNullOrWhiteSpace(text)) continue;
            using var msg = new HttpRequestMessage(HttpMethod.Post, new Uri(_opts.BaseUrl, "audio/speech"))
            {
                Content = JsonContent.Create(Body(text, ttsOptions)),
            };
            msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _opts.ApiKey);
            using var res = await HttpErrors.SendAsync(http, msg, Provider, "OpenAI speech", ct);
            await using var body = new ProviderBodyStream(await res.Content.ReadAsStreamAsync(ct), Provider, "OpenAI speech");

            // A read can end mid-sample; carry the odd byte into the next chunk so every chunk is whole PCM16.
            var buffer = new byte[8192];
            byte? carry = null;
            int read;
            while ((read = await body.ReadAsync(buffer.AsMemory(carry is null ? 0 : 1), ct)) > 0)
            {
                var length = read;
                if (carry is { } b)
                {
                    buffer[0] = b;
                    length++;
                    carry = null;
                }
                if (length % 2 == 1)
                {
                    carry = buffer[length - 1];
                    length--;
                }
                if (length > 0) yield return new AudioChunk(buffer.AsSpan(0, length).ToArray(), Rate);
            }
        }
    }
}
