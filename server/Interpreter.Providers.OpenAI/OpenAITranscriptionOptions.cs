namespace Interpreter.Providers.OpenAI;

/// <summary>Cascade STT settings for the OpenAI Realtime transcription session (Deepgram fallback).</summary>
public sealed class OpenAITranscriptionOptions
{
    public const string Section = "OpenAI:Transcription";

    /// <summary>Read from the OPENAI_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("wss://api.openai.com/v1/");

    /// <summary>
    /// gpt-realtime-whisper streams words while the speaker talks; gpt-4o-transcribe returns the text only
    /// after the turn is committed. Checked live 2026-10-16 (one clip: whisper had all but the last word before
    /// the speech ended, its final 0.9 s after; gpt-4o-transcribe's final came 1.3 s after).
    /// </summary>
    public string Model { get; set; } = "gpt-realtime-whisper";

    /// <summary>
    /// "server": OpenAI's VAD ends each turn after <see cref="SilenceDurationMs"/>. "client": the browser's VAD
    /// ends it (an end-of-speech frame commits the buffer), which skips the server's silence wait.
    /// gpt-realtime-whisper supports only "client" (the API refuses turn detection for it).
    /// </summary>
    public string Endpointing { get; set; } = "client";

    /// <summary>Server VAD silence before end of turn; same default as Realtime mode so endpointing compares.</summary>
    public int SilenceDurationMs { get; set; } = 500;

    /// <summary>gpt-realtime-whisper only: how long it holds text back for accuracy (minimal, low, medium, high, xhigh).</summary>
    public string? Delay { get; set; }

    public bool ClientEndpointing =>
        string.Equals(Endpointing, "client", StringComparison.OrdinalIgnoreCase) || IsRealtimeWhisper;

    public bool IsRealtimeWhisper => Model.StartsWith("gpt-realtime-whisper", StringComparison.Ordinal);

    /// <summary>After the audio ends, how long to wait for outstanding transcripts before closing.</summary>
    public int DrainTimeoutMs { get; set; } = 5000;
}
