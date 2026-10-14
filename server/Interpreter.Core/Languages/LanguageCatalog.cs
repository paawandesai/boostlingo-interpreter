using System.Text.Json;
using System.Text.Json.Serialization;

namespace Interpreter.Core.Languages;

public sealed record Language(string Code, string Name);

/// <summary>
/// Languages and pairs from config/languages.json (D16). Adding a pair is a config change;
/// vendor-specific blocks in the file are read by the adapters that need them.
/// </summary>
public sealed class LanguageCatalog
{
    private readonly Dictionary<string, Language> _languages;
    private readonly HashSet<(string, string)> _pairs;

    public LanguageCatalog(IEnumerable<Language> languages, IEnumerable<(string A, string B)> pairs)
    {
        _languages = languages.ToDictionary(l => l.Code, StringComparer.OrdinalIgnoreCase);
        _pairs = [];
        foreach (var (a, b) in pairs)
        {
            if (!_languages.ContainsKey(a) || !_languages.ContainsKey(b))
                throw new InvalidOperationException($"Pair {a}-{b} references an unknown language");
            // A configured pair is usable in both directions.
            _pairs.Add((a.ToLowerInvariant(), b.ToLowerInvariant()));
            _pairs.Add((b.ToLowerInvariant(), a.ToLowerInvariant()));
        }
    }

    public IReadOnlyCollection<Language> Languages => _languages.Values;

    public Language? Find(string code) => _languages.GetValueOrDefault(code);

    public bool IsSupportedDirection(string source, string target) =>
        _pairs.Contains((source.ToLowerInvariant(), target.ToLowerInvariant()));

    public static LanguageCatalog Load(string path)
    {
        using var stream = File.OpenRead(path);
        var file = JsonSerializer.Deserialize<LanguagesFile>(stream, JsonOptions)
            ?? throw new InvalidOperationException($"Empty language config: {path}");
        return new LanguageCatalog(
            file.Languages.Select(l => new Language(l.Code, l.Name)),
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

    private sealed record LanguageEntry(string Code, string Name);
}
