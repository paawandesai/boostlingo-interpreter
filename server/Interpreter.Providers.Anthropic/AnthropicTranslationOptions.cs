namespace Interpreter.Providers.Anthropic;

/// <summary>Cascade translator settings for the Anthropic Messages API (streaming).</summary>
public sealed class AnthropicTranslationOptions
{
    public const string Section = "Anthropic:Translation";

    /// <summary>Read from the ANTHROPIC_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.anthropic.com/v1/");

    /// <summary>The small, fast Claude tier (D7). Not yet checked live: no key in the build environment.</summary>
    public string Model { get; set; } = "claude-haiku-5-5";

    public string ApiVersion { get; set; } = "2023-06-01";

    public int MaxTokens { get; set; } = 400;
}
