using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.OpenAI;

/// <summary>Streaming translation through Chat Completions, using the shared <see cref="TranslationPrompt"/>.</summary>
public sealed class OpenAITranslator(HttpClient http, IOptions<OpenAITranslationOptions> options) : IStreamingTranslator
{
    private const string Provider = "openai-translate";
    private readonly OpenAITranslationOptions _opts = options.Value;

    public string Name => Provider;

    public JsonObject Body(TranslationRequest r)
    {
        var messages = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = TranslationPrompt.System(r) } };
        foreach (var turn in TranslationPrompt.Turns(r))
            messages.Add(new JsonObject { ["role"] = turn.FromSpeaker ? "user" : "assistant", ["content"] = turn.Text });

        var body = new JsonObject
        {
            ["model"] = _opts.Model,
            ["stream"] = true,
            ["max_completion_tokens"] = _opts.MaxOutputTokens,
            ["messages"] = messages,
        };
        if (_opts.ReasoningEffort is { } effort) body["reasoning_effort"] = effort;
        return body;
    }

    public async IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "OPENAI_API_KEY is not configured on the server");

        using var msg = new HttpRequestMessage(HttpMethod.Post, new Uri(_opts.BaseUrl, "chat/completions"))
        {
            Content = JsonContent.Create(Body(request)),
        };
        msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _opts.ApiKey);
        using var res = await HttpErrors.SendAsync(http, msg, Provider, "OpenAI translation", ct);
        await using var stream = await res.Content.ReadAsStreamAsync(ct);

        await foreach (var e in ServerSentEvents.ReadAsync(stream, ct))
        {
            if (e.Data == "[DONE]") yield break;
            using var doc = JsonDocument.Parse(e.Data);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var error))
            {
                var type = error.TryGetProperty("type", out var ty) ? ty.GetString() : null;
                throw new ProviderException(
                    type == "rate_limit_error" ? ProviderErrorKind.RateLimited : ProviderErrorKind.Unavailable,
                    Provider, $"OpenAI translation stream error ({type ?? "unknown"})");
            }
            if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0
                && choices[0].GetProperty("delta").TryGetProperty("content", out var content)
                && content.GetString() is { Length: > 0 } text)
                yield return text;
        }
    }
}
