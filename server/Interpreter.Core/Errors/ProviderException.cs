namespace Interpreter.Core.Errors;

/// <summary>What went wrong at a provider, in terms the pipeline and UI can act on (D8).</summary>
public enum ProviderErrorKind
{
    RateLimited,
    Timeout,
    Empty,
    Unavailable,
    Auth,
}

/// <summary>
/// The only exception provider adapters throw. Vendor-specific errors are mapped to a
/// <see cref="ProviderErrorKind"/> inside the adapter, so nothing outside Providers.* sees vendor types.
/// </summary>
public sealed class ProviderException(
    ProviderErrorKind kind,
    string provider,
    string message,
    TimeSpan? retryAfter = null,
    Exception? inner = null) : Exception(message, inner)
{
    public ProviderErrorKind Kind { get; } = kind;
    public string Provider { get; } = provider;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
