using Interpreter.Providers.ElevenLabs;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Cascade;

/// <summary>
/// Startup checks for <see cref="CascadeOptions"/> (run with ValidateOnStart), so a misconfiguration stops the
/// server with a message naming the setting instead of failing inside a session: a <c>Cascade:Voices</c> entry
/// that is not a stock voice of the active TTS (guardrail G5), or a session cap that is not positive.
/// </summary>
public sealed class CascadeOptionsValidation(
    IOptions<ElevenLabsOptions> elevenLabs,
    IOptions<OpenAISpeechOptions> openAISpeech) : IValidateOptions<CascadeOptions>
{
    public ValidateOptionsResult Validate(string? name, CascadeOptions options)
    {
        var failures = new List<string>();
        if (options.MaxSessionSeconds <= 0)
            failures.Add($"Cascade:MaxSessionSeconds must be positive (got {options.MaxSessionSeconds}).");
        if (options.StartTimeoutSeconds <= 0)
            failures.Add($"Cascade:StartTimeoutSeconds must be positive (got {options.StartTimeoutSeconds}).");

        var (stock, setting) = options.Tts switch
        {
            "elevenlabs" => (elevenLabs.Value.StockVoices, "ElevenLabs:StockVoices"),
            "openai" => (openAISpeech.Value.StockVoices, "OpenAI:Speech:StockVoices"),
            _ => (null, ""),
        };
        if (stock is not null)
        {
            foreach (var (language, voice) in options.Voices)
                if (!stock.Contains(voice))
                    failures.Add($"Cascade:Voices:{language} is {voice}, which is not in {setting} for Cascade:Tts={options.Tts} (stock voices only, guardrail G5).");
        }
        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
