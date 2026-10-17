using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.Anthropic;

/// <summary>Streaming translation through the Messages API, using the shared <see cref="TranslationPrompt"/>.</summary>
public sealed class AnthropicTranslator(HttpClient http, IOptions<AnthropicTranslationOptions> options) : IStreamingTranslator
{
    private const string Provider = "anthropic-translate";
    private readonly AnthropicTranslationOptions _opts = options.Value;

    public string Name => Provider;

    public JsonObject Body(TranslationRequest r)
    {
        var messages = new JsonArray();
        foreach (var turn in TranslationPrompt.Turns(r))
            messages.Add(new JsonObject { ["role"] = turn.FromSpeaker ? "user" : "assistant", ["content"] = turn.Text });

        var body = new JsonObject
        {
            ["model"] = _opts.Model,
            ["max_tokens"] = TranslationPrompt.OutputTokenCap(r.Text, _opts.MaxTokens),
            ["stream"] = true,
            ["system"] = TranslationPrompt.System(r),
            ["messages"] = messages,
        };
        if (_opts.Temperature is { } temperature) body["temperature"] = temperature;
        return body;
    }

    public async IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, $"{AnthropicTranslationOptions.ApiKeyEnv} (or {AnthropicTranslationOptions.FallbackApiKeyEnv}) is not configured on the server");

        using var msg = new HttpRequestMessage(HttpMethod.Post, new Uri(_opts.BaseUrl, "messages"))
        {
            Content = JsonContent.Create(Body(request)),
        };
        msg.Headers.Add("x-api-key", _opts.ApiKey);
        msg.Headers.Add("anthropic-version", _opts.ApiVersion);
        using var res = await HttpErrors.SendAsync(http, msg, Provider, "Anthropic translation", ct);
        await using var stream = new ProviderBodyStream(await res.Content.ReadAsStreamAsync(ct), Provider, "Anthropic translation");

        var tokens = new Tokens();
        await foreach (var e in ServerSentEvents.ReadAsync(stream, ct))
        {
            var (text, stop) = Read(e.Data, tokens);
            if (text is { Length: > 0 }) yield return text;
            if (stop)
            {
                if (tokens.Input is { } i && tokens.Output is { } o) request.OnUsage?.Invoke(new TokenUsage(i, o));
                yield break;
            }
        }
    }

    private sealed class Tokens
    {
        public int? Input;
        public int? Output;
    }

    /// <summary>
    /// Reads one stream event: records usage and returns its text delta and whether the message ended.
    /// A truncated or malformed event (a connection dropped mid-line) is a provider error, not an exception
    /// that ends the session.
    /// </summary>
    private static (string? Text, bool Stop) Read(string data, Tokens tokens)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "message_start" when root.GetProperty("message").TryGetProperty("usage", out var startUsage):
                    if (startUsage.TryGetProperty("input_tokens", out var it)) tokens.Input = it.GetInt32();
                    if (startUsage.TryGetProperty("output_tokens", out var ot0)) tokens.Output = ot0.GetInt32();
                    break;
                case "message_delta" when root.TryGetProperty("usage", out var deltaUsage):
                    // Output tokens here are cumulative for the message.
                    if (deltaUsage.TryGetProperty("output_tokens", out var ot)) tokens.Output = ot.GetInt32();
                    break;
                case "content_block_delta":
                    var delta = root.GetProperty("delta");
                    if (delta.GetProperty("type").GetString() == "text_delta") return (delta.GetProperty("text").GetString(), false);
                    break;
                case "message_stop":
                    return (null, true);
                case "error":
                    var type = root.GetProperty("error").GetProperty("type").GetString();
                    throw new ProviderException(
                        type switch
                        {
                            "rate_limit_error" => ProviderErrorKind.RateLimited,
                            "authentication_error" or "permission_error" => ProviderErrorKind.Auth,
                            _ => ProviderErrorKind.Unavailable,
                        },
                        Provider, $"Anthropic translation stream error ({type})");
            }
            return (null, false);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            throw new ProviderException(ProviderErrorKind.Unavailable, Provider, "Anthropic translation sent an unreadable stream event", inner: e);
        }
    }
}
