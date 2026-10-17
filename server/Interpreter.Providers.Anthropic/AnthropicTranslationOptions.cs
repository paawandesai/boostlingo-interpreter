using Interpreter.Core.Configuration;
using Interpreter.Core.Errors;
using Microsoft.Extensions.Configuration;

namespace Interpreter.Providers.Anthropic;

/// <summary>Cascade translator settings for the Anthropic Messages API (streaming).</summary>
public sealed class AnthropicTranslationOptions
{
    public const string Section = "Anthropic:Translation";

    /// <summary>
    /// Preferred env var. Claude Code cloud environments reserve ANTHROPIC_API_KEY for their own sign-in,
    /// so a key saved there never reaches the app or the live tests.
    /// </summary>
    public const string ApiKeyEnv = "CLAUDE_TRANSLATOR_API_KEY";

    /// <summary>Fallback env var for local runs.</summary>
    public const string FallbackApiKeyEnv = "ANTHROPIC_API_KEY";

    /// <summary>Read from <see cref="ApiKeyEnv"/>, else <see cref="FallbackApiKeyEnv"/>; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public static string? ApiKeyFrom(IConfiguration config) =>
        NonEmpty(config[ApiKeyEnv]) ?? NonEmpty(config[FallbackApiKeyEnv]);

    private static string? NonEmpty(string? v) => ConfigValue.IsSet(v) ? v : null;

    public Uri BaseUrl { get; set; } = new("https://api.anthropic.com/v1/");

    /// <summary>Longest wait for the next piece of the streamed body before the call fails as a timeout.</summary>
    public TimeSpan StreamIdleTimeout { get; set; } = ProviderBodyStream.DefaultIdleTimeout;

    /// <summary>The small, fast Claude tier (D7). Checked live 2026-10-14 by the fidelity smoke tests.</summary>
    public string Model { get; set; } = "claude-haiku-5-5";

    public string ApiVersion { get; set; } = "2023-06-01";

    public int MaxTokens { get; set; } = 400;

    /// <summary>
    /// Null by default: claude-haiku-5-5 rejects the parameter ("`temperature` is deprecated for this model",
    /// HTTP 400, checked 2026-10-14), so G16's temperature 0 can't be applied here. Set it for a model that
    /// accepts it. Known constraint in README.md.
    /// </summary>
    public double? Temperature { get; set; }
}
