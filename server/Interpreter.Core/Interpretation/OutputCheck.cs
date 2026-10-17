using System.Text.RegularExpressions;
using Interpreter.Core.Languages;

namespace Interpreter.Core.Interpretation;

/// <summary>
/// The deterministic output checks (G15) on the server, a port of <c>checkSegment</c> in
/// web/src/session/outputChecks.ts with the same word lists (config/languages.json), thresholds and canary.
/// The client still marks lines in the UI; the server uses this only to keep a translation that failed a
/// check out of the translator's context, so an answer, refusal or prompt leak never becomes a precedent
/// for later turns on the same socket. Keep the two in step.
/// </summary>
public static partial class OutputCheck
{
    private const double RatioMin = 0.4;
    private const double RatioMax = 2.5;
    private const int RatioMinSourceChars = 15;
    private const int LangMinWords = 4;

    /// <summary>Names of the checks a finished segment fails; empty when it passes.</summary>
    public static IReadOnlyList<string> Flags(
        string source, string target, OutputChecks? sourceChecks, OutputChecks? targetChecks, string? canary = InterpreterInstructions.Canary)
    {
        var flags = new List<string>();
        var sourceWords = Words(source);
        var targetWords = Words(target);

        if (target.Trim().Length == 0)
        {
            if (sourceWords.Count >= 3) flags.Add("omission");
            return flags;
        }
        // A refusal the speaker said ("No puedo ayudarle con eso") translates to one; that is not the model declining.
        if ((HasAny(target, targetChecks?.RefusalPatterns) || HasAny(target, sourceChecks?.RefusalPatterns))
            && !HasAny(source, sourceChecks?.RefusalPatterns) && !HasAny(source, targetChecks?.RefusalPatterns))
            flags.Add("refusal");
        if (!string.IsNullOrEmpty(canary) && Squash(target).Contains(Squash(canary), StringComparison.Ordinal)) flags.Add("prompt_leak");
        // Same for assistant phrasing the speaker said ("Sure, here's my insurance card").
        if ((HasAny(target, targetChecks?.AssistantPatterns) || HasAny(target, sourceChecks?.AssistantPatterns))
            && !HasAny(source, sourceChecks?.AssistantPatterns) && !HasAny(source, targetChecks?.AssistantPatterns))
            flags.Add("assistant_reply");
        if (targetWords.Count >= LangMinWords && targetChecks is not null && sourceChecks is not null)
        {
            // Distinct words, as on the client: one short word both languages share can't flag a correct line.
            var distinct = targetWords.Distinct().ToList();
            var asTarget = distinct.Count(w => targetChecks.Markers.Contains(w));
            var asSource = distinct.Count(w => sourceChecks.Markers.Contains(w));
            if (asSource >= 2 && asSource > asTarget) flags.Add("wrong_language");
        }
        if (source.Trim().Length >= RatioMinSourceChars)
        {
            var ratio = (double)target.Trim().Length / source.Trim().Length;
            if (ratio < RatioMin || ratio > RatioMax) flags.Add("length_ratio");
        }
        return flags;
    }

    /// <summary>True when a finished pair may serve as context for later turns: non-empty and no check failed.</summary>
    public static bool FitForContext(string source, string target, OutputChecks? sourceChecks, OutputChecks? targetChecks) =>
        target.Trim().Length > 0 && Flags(source, target, sourceChecks, targetChecks).Count == 0;

    private static List<string> Words(string text) =>
        WordPattern().Matches(text.ToLowerInvariant()).Select(m => m.Value).ToList();

    private static string Squash(string text) => NonWordPattern().Replace(text.ToLowerInvariant(), "");

    /// <summary>
    /// True when a clause starts with one of the patterns (after leading punctuation such as quotes or ¿, an
    /// apology or filler such as "I'm afraid" or "lo siento", and a leading "but"/"and"). Only clause starts
    /// count: a model's refusal or assistant preamble opens a clause ("I'm sorry I can't help", "Okay here's a
    /// joke"), while the same words inside a faithful line ("I won't be able to...") do not. Text and patterns
    /// are compared with contractions expanded, so "I'm unable" matches "i am unable".
    /// </summary>
    private static bool HasAny(string text, string[]? patterns)
    {
        if (patterns is null) return false;
        var normalized = patterns.Select(Normalize).ToList();
        var clauses = ClausePattern().Split(Normalize(text));
        // Each start is matched against the rest of the text, so a pattern with a comma ("sure, here's") still matches.
        return Enumerable.Range(0, clauses.Length)
            .Select(i => string.Join(" ", clauses[i..]))
            .Select(rest => LeadingConjunctionPattern().Replace(
                LeadingHedgePattern().Replace(LeadingPunctuationPattern().Replace(rest, ""), ""), ""))
            .Any(rest => normalized.Any(p => rest.StartsWith(p, StringComparison.Ordinal)));
    }

    private static string Normalize(string text)
    {
        var lower = text.ToLowerInvariant().Replace('’', '\'');
        return ContractionPattern().Replace(lower, m => m.Value switch
        {
            "i'm" => "i am",
            "here's" => "here is",
            "can't" => "cannot",
            _ => "will not",
        });
    }

    [GeneratedRegex(@"\b(?:i'm|here's|can't|won't)\b")]
    private static partial Regex ContractionPattern();

    [GeneratedRegex(@"^(?:i am afraid|i am sorry|sorry|unfortunately|okay|ok|lo siento|desafortunadamente|lamentablemente|tôi xin lỗi|xin lỗi|rất tiếc)[\s,]+")]
    private static partial Regex LeadingHedgePattern();

    [GeneratedRegex(@"[\p{L}\p{N}']+")]
    private static partial Regex WordPattern();

    [GeneratedRegex(@"[^\p{L}\p{N}]")]
    private static partial Regex NonWordPattern();

    /// <summary>A clause ends at . ! ? … , ; or : followed by whitespace, or at a line break.</summary>
    [GeneratedRegex(@"(?<=[.!?…,;:])\s+|\n+")]
    private static partial Regex ClausePattern();

    [GeneratedRegex(@"^[^\p{L}\p{N}]+")]
    private static partial Regex LeadingPunctuationPattern();

    [GeneratedRegex(@"^(?:but|and|pero|y|nhưng|và)\s+")]
    private static partial Regex LeadingConjunctionPattern();
}
