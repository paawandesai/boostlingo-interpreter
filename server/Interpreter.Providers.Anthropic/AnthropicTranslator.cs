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

        return new JsonObject
        {
            ["model"] = _opts.Model,
            ["max_tokens"] = _opts.MaxTokens,
            ["stream"] = true,
            ["system"] = TranslationPrompt.System(r),
            ["messages"] = messages,
        };
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
        await using var stream = await res.Content.ReadAsStreamAsync(ct);

        int? inputTokens = null, outputTokens = null;
        await foreach (var e in ServerSentEvents.ReadAsync(stream, ct))
        {
            using var doc = JsonDocument.Parse(e.Data);
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "message_start" when root.GetProperty("message").TryGetProperty("usage", out var startUsage):
                    if (startUsage.TryGetProperty("input_tokens", out var it)) inputTokens = it.GetInt32();
                    if (startUsage.TryGetProperty("output_tokens", out var ot0)) outputTokens = ot0.GetInt32();
                    break;
                case "message_delta" when root.TryGetProperty("usage", out var deltaUsage):
                    // Output tokens here are cumulative for the message.
                    if (deltaUsage.TryGetProperty("output_tokens", out var ot)) outputTokens = ot.GetInt32();
                    break;
                case "content_block_delta":
                    var delta = root.GetProperty("delta");
                    if (delta.GetProperty("type").GetString() == "text_delta" && delta.GetProperty("text").GetString() is { Length: > 0 } text)
                        yield return text;
                    break;
                case "message_stop":
                    if (inputTokens is { } i && outputTokens is { } o) request.OnUsage?.Invoke(new TokenUsage(i, o));
                    yield break;
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
        }
    }
}
