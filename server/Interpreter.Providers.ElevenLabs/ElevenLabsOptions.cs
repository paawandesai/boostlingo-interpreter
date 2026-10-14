namespace Interpreter.Providers.ElevenLabs;

/// <summary>
/// ElevenLabs streaming TTS settings (WebSocket stream-input). Requires a paid plan: the free plan is
/// non-commercial and needs attribution (docs/GUARDRAILS.md). Checked by a live call on 2026-10-14.
/// </summary>
public sealed class ElevenLabsOptions
{
    public const string Section = "ElevenLabs";

    /// <summary>Read from the ELEVENLABS_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("wss://api.elevenlabs.io/v1/");

    /// <summary>Flash v2.5: the low-latency multilingual model (D7).</summary>
    public string Model { get; set; } = "eleven_flash_v2_5";

    public string DefaultVoice { get; set; } = "JBFqnCBsd6RMkjVDRZzb";

    /// <summary>
    /// Stock (premade) ElevenLabs voices this app may use. Guardrail G5: never a cloned voice, and never a
    /// voice made from the live speaker. A voice not on this list is refused.
    /// </summary>
    public List<string> StockVoices { get; set; } = ["JBFqnCBsd6RMkjVDRZzb", "EXAVITQu4vr4xnSDxMaL", "21m00Tcm4TlvDq8ikWAM"];

    /// <summary>Seconds without text before ElevenLabs closes the stream (its default is 20).</summary>
    public int InactivityTimeoutSeconds { get; set; } = 60;
}
