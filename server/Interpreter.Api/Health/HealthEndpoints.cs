using Interpreter.Api.Cascade;
using Interpreter.Api.Security;
using Interpreter.Providers.Anthropic;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Health;

public sealed record HealthConfig(
    bool AccessTokenSet,
    IReadOnlyDictionary<string, bool> Keys,
    string CascadeStt,
    string CascadeTranslator,
    string CascadeTts,
    /// <summary>Unset keys that the configured adapters need; the SPA shows these and never carries key names itself.</summary>
    IReadOnlyList<string> Missing);

public sealed record HealthResponse(
    string Status,
    string Version,
    HealthConfig? Config = null,
    IReadOnlyDictionary<string, DateTimeOffset>? LastSuccess = null);

/// <summary>
/// GET /health (G12): process status, which keys are configured (true/false only, never values or
/// prefixes), the cascade adapters in use, and when each provider last succeeded in a real session.
/// It makes no live calls, so it is cheap to poll and spends no provider credit.
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/health", (IConfiguration config, IOptions<CascadeOptions> cascade, IOptions<AccessOptions> access,
            ProviderActivity activity) =>
        {
            static bool Set(string? v) => ConfigValue.IsSet(v);
            var keys = new SortedDictionary<string, bool>
            {
                ["OPENAI_API_KEY"] = Set(config["OPENAI_API_KEY"]),
                ["DEEPGRAM_API_KEY"] = Set(config["DEEPGRAM_API_KEY"]),
                ["ELEVENLABS_API_KEY"] = Set(config["ELEVENLABS_API_KEY"]),
                [AnthropicTranslationOptions.ApiKeyEnv] = Set(AnthropicTranslationOptions.ApiKeyFrom(config)),
            };
            var c = cascade.Value;
            // A key is missing only when an adapter in use needs it: OpenAI serves both Realtime modes and
            // the OpenAI cascade adapters; the other three matter only when their adapter is configured.
            var needed = new Dictionary<string, bool>
            {
                ["OPENAI_API_KEY"] = true,
                ["DEEPGRAM_API_KEY"] = c.Stt == "deepgram",
                ["ELEVENLABS_API_KEY"] = c.Tts == "elevenlabs",
                [AnthropicTranslationOptions.ApiKeyEnv] = c.Translator == "anthropic",
            };
            var missing = keys.Where(k => !k.Value && needed.GetValueOrDefault(k.Key, true)).Select(k => k.Key).ToList();
            return Results.Ok(new HealthResponse(
                "ok",
                typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
                new HealthConfig(Set(access.Value.Token), keys, c.Stt, c.Translator, c.Tts, missing),
                activity.Snapshot()));
        });
        return app;
    }
}
