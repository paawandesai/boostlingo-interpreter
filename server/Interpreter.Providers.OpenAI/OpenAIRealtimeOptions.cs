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

    /// <summary>
    /// Default Realtime model. The brief names gpt-realtime; docs/GUARDRAILS.md (v2) says it is deprecated
    /// and makes gpt-realtime-2.1 the default. Both were listed by GET /v1/models and minted a session
    /// on 2026-10-14. Never a *-preview model and never the OpenAI-Beta: realtime=v1 header.
    /// </summary>
    public string Model { get; set; } = "gpt-realtime-2.1";

    /// <summary>Models a client may ask for. gpt-realtime stays selectable so the brief's model can be measured.</summary>
    public List<string> AllowedModels { get; set; } = ["gpt-realtime-2.1", "gpt-realtime"];

    public string Voice { get; set; } = "marin";

    /// <summary>Input transcription runs on a separate model, which is why its WER carries a caveat.</summary>
    public string TranscriptionModel { get; set; } = "gpt-4o-mini-transcribe";

    /// <summary>Server VAD silence before end of turn. Kept explicit so both modes' endpointing is documented.</summary>
    public int SilenceDurationMs { get; set; } = 500;

    /// <summary>
    /// Shortest practical lifetime (G19): the browser uses the secret once, right after minting, for the SDP
    /// exchange. A leaked secret is worthless a minute later.
    /// </summary>
    public int SecretTtlSeconds { get; set; } = 60;

    /// <summary>
    /// Translation model (G17), on /v1/realtime/translations. Listed by GET /v1/models and probed live on
    /// 2026-10-14; event and session shapes match the openai npm package v7.34.0 types.
    /// </summary>
    public string TranslateModel { get; set; } = "gpt-realtime-translate";

    /// <summary>Source transcript for the translation session (optional in the API; the source column needs it).</summary>
    public string TranslateTranscriptionModel { get; set; } = "gpt-realtime-whisper";

    /// <summary>The client ends a Realtime session after this long (G19); cascade has the same cap server-side.</summary>
    public int MaxSessionSeconds { get; set; } = 1800;
}
