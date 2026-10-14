using System.Text.Json;

namespace Interpreter.Core.Languages;

/// <summary>
/// Fixed term translations from config/glossary.json (T3.7). Entries are keyed by language code, so a
/// direction is just a lookup: the source terms bias STT (keyterms) and the source → target pairs go into
/// the interpreter instructions, identically for cascade and Realtime.
/// </summary>
public sealed class Glossary(string name, IReadOnlyList<IReadOnlyDictionary<string, string>> entries)
{
    public static readonly Glossary Empty = new("none", []);

    public string Name { get; } = name;
    public int Count => entries.Count;

    /// <summary>Source → target terms for one direction; entries missing either language are skipped.</summary>
    public IReadOnlyDictionary<string, string> For(string source, string target)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in entries)
            if (e.TryGetValue(source, out var s) && e.TryGetValue(target, out var t)) map[s] = t;
        return map;
    }

    public static Glossary Load(string path)
    {
        if (!File.Exists(path)) return Empty;
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var entries = root.GetProperty("entries").EnumerateArray()
            .Select(e => (IReadOnlyDictionary<string, string>)e.EnumerateObject()
                .ToDictionary(p => p.Name, p => p.Value.GetString() ?? "", StringComparer.OrdinalIgnoreCase))
            .ToList();
        return new Glossary(root.TryGetProperty("name", out var n) ? n.GetString() ?? "glossary" : "glossary", entries);
    }
}
