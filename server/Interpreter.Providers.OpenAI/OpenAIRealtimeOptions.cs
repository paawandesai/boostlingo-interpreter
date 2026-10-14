namespace Interpreter.Providers.OpenAI;

/// <summary>
/// Realtime session settings. Field names follow the GA client-secret API
/// (POST /v1/realtime/client_secrets), checked against the openai npm package v7.32.0 types
/// and a live call on 2026-10-14.
/// </summary>
public sealed class OpenAIRealtimeOptions
{
    public const string Section = "OpenAI:Realtime";

    /// <summary>Read from the OPENAI_API_KEY environment variable; never sent to the browser.</summary>
    public string? ApiKey { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.openai.com/v1/");

    /// <summary>The brief requires gpt-realtime.</summary>
    public string Model { get; set; } = "gpt-realtime";

    public string Voice { get; set; } = "marin";

    /// <summary>Input transcription runs on a separate model, which is why its WER carries a caveat.</summary>
    public string TranscriptionModel { get; set; } = "gpt-4o-mini-transcribe";

    /// <summary>Server VAD silence before end of turn. Kept explicit so both modes' endpointing is documented.</summary>
    public int SilenceDurationMs { get; set; } = 500;

    public int SecretTtlSeconds { get; set; } = 600;
}
