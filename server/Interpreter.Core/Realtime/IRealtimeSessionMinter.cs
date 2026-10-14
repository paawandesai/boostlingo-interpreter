namespace Interpreter.Core.Realtime;

/// <param name="Model">A model from <see cref="IRealtimeSessionMinter.AllowedModels"/>; null means the default.</param>
public sealed record RealtimeSessionRequest(
    string SourceLanguage,
    string TargetLanguage,
    string Instructions,
    string? Model = null);

/// <summary>A short-lived secret the browser uses to open its own WebRTC session.</summary>
/// <param name="TranscriptionModel">Echoed so the client can keep it when it updates the transcription language.</param>
public sealed record RealtimeClientSecret(string Value, DateTimeOffset ExpiresAt, string Model, string TranscriptionModel);

/// <summary>
/// Creates a Realtime session credential server-side, so the provider API key never reaches
/// the browser (D4). Implementations throw only <see cref="Errors.ProviderException"/>.
/// </summary>
public interface IRealtimeSessionMinter
{
    /// <summary>Model used when the request names none. Configuration, never a constant (docs/GUARDRAILS.md).</summary>
    string DefaultModel { get; }

    IReadOnlyList<string> AllowedModels { get; }

    Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct);
}
