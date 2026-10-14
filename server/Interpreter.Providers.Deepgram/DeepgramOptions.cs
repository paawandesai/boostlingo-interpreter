namespace Interpreter.Providers.Deepgram;

/// <summary>
/// Deepgram live transcription settings (WebSocket /v1/listen). Parameter names follow Deepgram's
/// streaming API; checked by a live call on 2026-10-14.
/// </summary>
public sealed class DeepgramOptions
{
    public const string Section = "Deepgram";

    /// <summary>Read from the DEEPGRAM_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("wss://api.deepgram.com/v1/");

    public string Model { get; set; } = "nova-3";

    /// <summary>Silence (ms) before Deepgram marks a final as speech_final. Tuned on Day 3.</summary>
    public int EndpointingMs { get; set; } = 300;

    /// <summary>Gap between words (ms) before Deepgram sends UtteranceEnd, the fallback when endpointing misses.</summary>
    public int UtteranceEndMs { get; set; } = 1000;

    /// <summary>Formats numbers, dates and currency, which helps translation of doses and times.</summary>
    public bool SmartFormat { get; set; } = true;
}
