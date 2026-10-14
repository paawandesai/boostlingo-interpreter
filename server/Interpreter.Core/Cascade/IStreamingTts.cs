namespace Interpreter.Core.Cascade;

/// <summary>
/// Streaming text-to-speech (D8). Takes text chunks as the flush policy releases them and yields
/// audio as soon as the provider sends it, so speech starts before the translation is finished.
/// </summary>
public interface IStreamingTts
{
    string Name { get; }

    IAsyncEnumerable<AudioChunk> SynthesizeAsync(IAsyncEnumerable<string> textChunks, TtsOptions options, CancellationToken ct);
}

/// <param name="Voice">Provider voice id; a stock voice, never a clone of the live speaker (docs/GUARDRAILS.md).</param>
public sealed record TtsOptions(string Language, string? Voice = null, int SampleRate = 24000);
