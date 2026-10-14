namespace Interpreter.Core.Realtime;

public sealed record RealtimeSessionRequest(
    string SourceLanguage,
    string TargetLanguage,
    string Instructions);

/// <summary>A short-lived secret the browser uses to open its own WebRTC session.</summary>
/// <param name="TranscriptionModel">Echoed so the client can keep it when it updates the transcription language.</param>
public sealed record RealtimeClientSecret(string Value, DateTimeOffset ExpiresAt, string Model, string TranscriptionModel);

/// <summary>
/// Creates a Realtime session credential server-side, so the provider API key never reaches
/// the browser (D4). Implementations throw only <see cref="Errors.ProviderException"/>.
/// </summary>
public interface IRealtimeSessionMinter
{
    Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct);
}
