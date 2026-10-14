namespace Interpreter.Providers.OpenAI;

/// <summary>Cascade STT settings for the OpenAI Realtime transcription session (Deepgram fallback).</summary>
public sealed class OpenAITranscriptionOptions
{
    public const string Section = "OpenAI:Transcription";

    /// <summary>Read from the OPENAI_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("wss://api.openai.com/v1/");

    public string Model { get; set; } = "gpt-4o-transcribe";

    /// <summary>Server VAD silence before end of turn; same default as Realtime mode so endpointing compares.</summary>
    public int SilenceDurationMs { get; set; } = 500;

    /// <summary>After the audio ends, how long to wait for outstanding transcripts before closing.</summary>
    public int DrainTimeoutMs { get; set; } = 5000;
}
