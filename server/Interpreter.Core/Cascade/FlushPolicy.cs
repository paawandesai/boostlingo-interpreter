using System.Text;

namespace Interpreter.Core.Cascade;

/// <summary>Flush thresholds (D11). Tuned on Day 3 with the replay set; defaults are a starting point.</summary>
/// <param name="MinClauseChars">A clause boundary (, ; :) releases text only once this many characters are buffered.</param>
/// <param name="MaxWaitMs">With no boundary for this long, release up to the last word break...</param>
/// <param name="MinCharsOnTimeout">...if at least this many characters are buffered.</param>
public sealed record FlushOptions(int MinClauseChars = 30, int MaxWaitMs = 400, int MinCharsOnTimeout = 12);

/// <summary>
/// Decides when streamed translation text is released to TTS (D11): at sentence ends, at clause
/// boundaries once enough text is buffered, or on a timeout. Pure and clock-free: the caller passes
/// time in, so the rules are table-tested without timers.
/// </summary>
public sealed class FlushPolicy(FlushOptions? options = null)
{
    private static readonly HashSet<string> Abbreviations = new(StringComparer.OrdinalIgnoreCase)
    {
        // English
        "dr", "mr", "mrs", "ms", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "approx", "mt",
        // Spanish
        "sra", "srta", "dra", "ud", "uds", "av", "pág", "núm", "aprox",
    };

    private readonly FlushOptions _o = options ?? new FlushOptions();
    private readonly StringBuilder _buffer = new();
    private double _lastReleaseMs;
    private bool _started;

    public bool HasPending => _buffer.ToString().Trim().Length > 0;

    /// <summary>Adds a translation delta and returns any chunks that are now ready, in order.</summary>
    public IReadOnlyList<string> Push(string delta, double nowMs)
    {
        if (!_started)
        {
            _started = true;
            _lastReleaseMs = nowMs;
        }
        _buffer.Append(delta);
        var chunks = new List<string>();
        while (FindBoundary() is { } cut)
            Release(cut, nowMs, chunks);
        return chunks;
    }

    /// <summary>Called when no delta has arrived for a while. Releases up to the last word break after MaxWaitMs.</summary>
    public string? Tick(double nowMs)
    {
        if (!_started || nowMs - _lastReleaseMs < _o.MaxWaitMs) return null;
        var text = _buffer.ToString();
        if (text.Trim().Length < _o.MinCharsOnTimeout) return null;
        var cut = text.LastIndexOf(' ');
        if (cut <= 0) return null;
        var chunks = new List<string>(1);
        Release(cut + 1, nowMs, chunks);
        return chunks.FirstOrDefault();
    }

    /// <summary>The translation finished: release whatever is left.</summary>
    public string? Complete()
    {
        var rest = _buffer.ToString().Trim();
        _buffer.Clear();
        _started = false;
        return rest.Length > 0 ? rest : null;
    }

    private void Release(int cut, double nowMs, List<string> chunks)
    {
        var chunk = _buffer.ToString(0, cut).Trim();
        _buffer.Remove(0, cut);
        _lastReleaseMs = nowMs;
        if (chunk.Length > 0) chunks.Add(chunk);
    }

    /// <summary>Index just past the first flushable boundary (punctuation, closing quotes, then whitespace), or null.</summary>
    private int? FindBoundary()
    {
        var text = _buffer.ToString();
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            var sentence = c is '.' or '?' or '!' or '…';
            var clause = c is ',' or ';' or ':';
            if (!sentence && !clause) continue;

            // Skip closing quotes and brackets that belong to the sentence.
            var j = i + 1;
            while (j < text.Length && text[j] is '"' or '\'' or ')' or '»' or '”' or '’') j++;
            // A boundary needs following whitespace; "3.5" and "3,5" never flush, and text at the very end
            // waits, because the next delta may continue it.
            if (j >= text.Length || !char.IsWhiteSpace(text[j])) continue;

            if (c == '.' && IsAbbreviationOrInitial(text, i)) continue;
            if (clause && text[..i].Trim().Length < _o.MinClauseChars) continue;
            return j + 1;
        }
        return null;
    }

    private static bool IsAbbreviationOrInitial(string text, int dot)
    {
        var start = dot;
        while (start > 0 && (char.IsLetter(text[start - 1]) || text[start - 1] == '.')) start--;
        var word = text[start..dot];
        return word.Length == 1 && char.IsUpper(word[0]) || Abbreviations.Contains(word);
    }
}
