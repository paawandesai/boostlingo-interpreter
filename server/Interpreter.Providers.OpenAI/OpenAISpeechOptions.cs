using Interpreter.Core.Errors;

namespace Interpreter.Providers.OpenAI;

/// <summary>
/// Cascade TTS over OpenAI's speech endpoint (POST /v1/audio/speech). It exists so a cascade session can run
/// on endpoints OpenAI lists as HIPAA-eligible (BAA mode, README "Known constraints"); ElevenLabs stays the default.
/// </summary>
public sealed class OpenAISpeechOptions
{
    public const string Section = "OpenAI:Speech";

    /// <summary>Read from the OPENAI_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.openai.com/v1/");

    /// <summary>Longest wait for the next piece of the streamed body before the call fails as a timeout.</summary>
    public TimeSpan StreamIdleTimeout { get; set; } = ProviderBodyStream.DefaultIdleTimeout;

    /// <summary>The model the live tests and eval/replay/synth.py already call with response_format "pcm".</summary>
    public string Model { get; set; } = "gpt-4o-mini-tts";

    public string DefaultVoice { get; set; } = "alloy";

    /// <summary>
    /// Built-in OpenAI voices this app may use. Guardrail G5: stock voices only, never a voice made from the
    /// live speaker. A voice not on this list is refused.
    /// </summary>
    public List<string> StockVoices { get; set; } = ["alloy"];
}
