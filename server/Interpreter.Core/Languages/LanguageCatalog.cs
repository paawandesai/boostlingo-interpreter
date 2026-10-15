using System.Text.Json;
using System.Text.Json.Serialization;

namespace Interpreter.Core.Languages;

/// <summary>The AI-use notice shown on screen and read aloud before capture starts (G7).</summary>
public sealed record Disclosure(string Notice, string Spoken);

/// <summary>
/// Deterministic output checks for text in this language (G15): common function words for the language
/// check, and lower-case substrings that mark an output as an assistant reply or a refusal.
/// </summary>
public sealed record OutputChecks(string[] Markers, string[] AssistantPatterns, string[] RefusalPatterns);

public sealed record Language(string Code, string Name, Disclosure? Disclosure = null, OutputChecks? OutputChecks = null);

/// <summary>
/// Languages and pairs from config/languages.json (D16). Adding a pair is a config change;
/// vendor-specific blocks in the file are read by the adapters that need them.
/// </summary>
public sealed class LanguageCatalog
{
    private readonly Dictionary<string, Language> _languages;
    private readonly HashSet<(string, string)> _pairs;
    private readonly List<(string A, string B)> _configuredPairs;

    public LanguageCatalog(IEnumerable<Language> languages, IEnumerable<(string A, string B)> pairs)
    {
        _languages = languages.ToDictionary(l => l.Code, StringComparer.OrdinalIgnoreCase);
        _pairs = [];
        _configuredPairs = [];
        foreach (var (a, b) in pairs)
        {
            if (!_languages.ContainsKey(a) || !_languages.ContainsKey(b))
                throw new InvalidOperationException($"Pair {a}-{b} references an unknown language");
            // A configured pair is usable in both directions.
            _pairs.Add((a.ToLowerInvariant(), b.ToLowerInvariant()));
            _pairs.Add((b.ToLowerInvariant(), a.ToLowerInvariant()));
            _configuredPairs.Add((a, b));
        }
    }

    public IReadOnlyCollection<Language> Languages => _languages.Values;

    /// <summary>Pairs as configured (each usable in both directions).</summary>
    public IReadOnlyList<(string A, string B)> Pairs => _configuredPairs;

    public Language? Find(string code) => _languages.GetValueOrDefault(code);

    public bool IsSupportedDirection(string source, string target) =>
        _pairs.Contains((source.ToLowerInvariant(), target.ToLowerInvariant()));

    public static LanguageCatalog Load(string path)
    {
        using var stream = File.OpenRead(path);
        var file = JsonSerializer.Deserialize<LanguagesFile>(stream, JsonOptions)
            ?? throw new InvalidOperationException($"Empty language config: {path}");
        return new LanguageCatalog(
            file.Languages.Select(l => new Language(l.Code, l.Name, l.Disclosure, l.OutputChecks)),
            file.Pairs.Select(p => p.Length == 2
                ? (p[0], p[1])
                : throw new InvalidOperationException("Each pair must have exactly two codes")));
    }

    /// <summary>Walks up from <paramref name="startDir"/> to find config/languages.json (dev and tests).</summary>
    public static string? FindConfigFile(string startDir)
    {
        for (var dir = new DirectoryInfo(startDir); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "config", "languages.json");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private sealed record LanguagesFile(
        [property: JsonPropertyName("languages")] List<LanguageEntry> Languages,
        [property: JsonPropertyName("pairs")] List<string[]> Pairs);

    private sealed record LanguageEntry(string Code, string Name, Disclosure? Disclosure, OutputChecks? OutputChecks);
}
