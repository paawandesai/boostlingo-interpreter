namespace Interpreter.Core.Realtime;

public sealed record RealtimeSessionRequest(
    string SourceLanguage,
    string TargetLanguage,
    string Instructions);

/// <summary>A short-lived secret the browser uses to open its own WebRTC session.</summary>
public sealed record RealtimeClientSecret(string Value, DateTimeOffset ExpiresAt, string Model);

/// <summary>
/// Creates a Realtime session credential server-side, so the provider API key never reaches
/// the browser (D4). Implementations throw only <see cref="Errors.ProviderException"/>.
/// </summary>
public interface IRealtimeSessionMinter
{
    Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct);
}
