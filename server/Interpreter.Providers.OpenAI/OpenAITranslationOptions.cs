namespace Interpreter.Providers.OpenAI;

/// <summary>Cascade translator settings (Chat Completions, streaming).</summary>
public sealed class OpenAITranslationOptions
{
    public const string Section = "OpenAI:Translation";

    /// <summary>Read from the OPENAI_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.openai.com/v1/");

    /// <summary>A small, fast model (D7). Listed by GET /v1/models on 2026-10-14.</summary>
    public string Model { get; set; } = "gpt-5.4-mini";

    /// <summary>"none" keeps time to first token low for a reasoning model; set null to omit for models without it.</summary>
    public string? ReasoningEffort { get; set; } = "none";

    /// <summary>Ceiling; each request is capped lower from the segment length (G16, <see cref="Interpreter.Core.Cascade.TranslationPrompt.OutputTokenCap"/>).</summary>
    public int MaxOutputTokens { get; set; } = 400;

    /// <summary>0 for translation (G16); set null for a model that rejects the parameter.</summary>
    public double? Temperature { get; set; } = 0;
}
