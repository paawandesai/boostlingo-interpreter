namespace Interpreter.Core.Cascade;

/// <summary>Streaming text translation (D8). Yields target-language text deltas as they arrive.</summary>
public interface IStreamingTranslator
{
    string Name { get; }

    IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, CancellationToken ct);
}

/// <param name="SourceLanguage">Language name, e.g. "English" (prompts read better with names than codes).</param>
/// <param name="Context">Recent source/target pairs from this conversation, oldest first, for pronouns and register.</param>
/// <param name="Glossary">Optional fixed term translations (T3.7).</param>
public sealed record TranslationRequest(
    string SourceLanguage,
    string TargetLanguage,
    string Text,
    IReadOnlyList<(string Source, string Target)>? Context = null,
    IReadOnlyDictionary<string, string>? Glossary = null);
