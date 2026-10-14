using System.Collections.Concurrent;

namespace Interpreter.Api.Health;

/// <summary>
/// When each provider last did useful work in this process (G12), for /health. Recorded from real
/// sessions only: /health itself never calls a vendor. Nothing about the content is kept.
/// </summary>
public sealed class ProviderActivity(TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastSuccess = new(StringComparer.OrdinalIgnoreCase);

    /// <param name="key">Stage and adapter, e.g. "stt:deepgram" or "realtime:openai".</param>
    public void Success(string key) => _lastSuccess[key] = _time.GetUtcNow();

    public IReadOnlyDictionary<string, DateTimeOffset> Snapshot() => new SortedDictionary<string, DateTimeOffset>(_lastSuccess);
}
