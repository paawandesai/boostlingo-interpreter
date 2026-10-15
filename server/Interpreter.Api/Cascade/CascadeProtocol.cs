using System.Text.Json;
using System.Text.Json.Serialization;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;

namespace Interpreter.Api.Cascade;

/// <summary>
/// Wire format of the cascade WebSocket (D5). Binary frames carry PCM16 mono audio: 16 kHz up, 24 kHz down.
/// Text frames carry the JSON messages below. Every server message has <c>t</c>, milliseconds on the session's
/// server clock; the client maps it to its own clock with the ping/pong offset (D9).
/// </summary>
public static class CascadeProtocol
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>First client message. The token goes here because browsers can't set WebSocket headers.</summary>
    public sealed record Start(
        string Type, string? Token, string? Source, string? Target, string? Translator, bool Glossary = false,
        IReadOnlyList<HistoryPair>? History = null);

    /// <summary>An earlier finished turn the client carries across a reconnect (G9). Untrusted text, used as context data.</summary>
    public sealed record HistoryPair(string? Source, string? Target);

    /// <summary>At most this many pairs, each side cut to this many characters: the start message stays small.</summary>
    public const int MaxHistoryPairs = 6;
    public const int MaxHistoryChars = 600;

    public static IReadOnlyList<(string Source, string Target)> History(Start start) =>
        (start.History ?? [])
            .Where(p => !string.IsNullOrWhiteSpace(p.Source) && !string.IsNullOrWhiteSpace(p.Target))
            .TakeLast(MaxHistoryPairs)
            .Select(p => (Cut(p.Source!), Cut(p.Target!)))
            .ToList();

    private static string Cut(string s) => s.Length <= MaxHistoryChars ? s : s[..MaxHistoryChars];

    public sealed record ClientMessage(string Type, double? C);

    /// <summary>Maps a pipeline event to its wire message, or null for audio (sent as a binary frame).</summary>
    public static object? ToWire(CascadeEvent e) => e switch
    {
        SourcePartial p => new { type = "transcript.partial", u = p.Utterance, text = p.Text, t = p.AtMs },
        SourceFinal f => new { type = "transcript.final", u = f.Utterance, text = f.Text, confidence = f.Confidence, t = f.AtMs },
        TranslationDelta d => new { type = "translation.delta", u = d.Utterance, text = d.Text, t = d.AtMs },
        TranslationFinal f => new { type = "translation.final", u = f.Utterance, text = f.Text, t = f.AtMs },
        LatencyMark m => new { type = "latency.mark", u = m.Utterance, name = m.Name, t = m.AtMs },
        UtteranceDone d => new { type = "utterance.done", u = d.Utterance, t = d.AtMs },
        UtteranceUsage x => new { type = "usage", u = x.Utterance, inputTokens = x.InputTokens, outputTokens = x.OutputTokens, ttsCharacters = x.TtsCharacters, t = x.AtMs },
        CascadeError err => Error(err.Utterance, err.Stage, err.Provider, err.Kind, err.AtMs, err.RetryAfterMs),
        CascadeRetry r => new { type = "retry", u = r.Utterance, stage = r.Stage, provider = r.Provider, kind = r.Kind.ToString(), attempt = r.Attempt, delayMs = r.DelayMs, t = r.AtMs },
        _ => null,
    };

    public static object Error(int? utterance, string stage, string provider, ProviderErrorKind kind, double t, double? retryAfterMs = null) =>
        new { type = "error", u = utterance, stage, provider, kind = kind.ToString(), retryAfterMs, t };
}
