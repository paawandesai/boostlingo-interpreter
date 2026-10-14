namespace Interpreter.Core.Cascade;

/// <summary>Streaming speech-to-text (D8). Adapters live in Interpreter.Providers.* and throw only ProviderException.</summary>
public interface IStreamingStt
{
    /// <summary>Short provider id for logs, latency labels and LICENSES.md (e.g. "deepgram").</summary>
    string Name { get; }

    IAsyncEnumerable<SttEvent> TranscribeAsync(IAsyncEnumerable<AudioFrame> audio, SttOptions options, CancellationToken ct);
}

/// <param name="Language">BCP-47-ish code from config/languages.json, e.g. "en", "es".</param>
/// <param name="Keyterms">Optional glossary terms to bias recognition (T3.7); adapters may ignore it.</param>
public sealed record SttOptions(string Language, int SampleRate = 16000, IReadOnlyList<string>? Keyterms = null);

public abstract record SttEvent;

/// <summary>Interim text that may still change.</summary>
public sealed record SttPartial(string Text) : SttEvent;

/// <summary>A finalised segment. Translation starts on these (D11).</summary>
/// <param name="EndsUtterance">True when the provider also signalled end of speech with this segment.</param>
/// <param name="Confidence">0..1 when the provider reports it; null means unknown, never a made-up value.</param>
public sealed record SttFinal(string Text, bool EndsUtterance, double? Confidence = null) : SttEvent;

/// <summary>The provider's end-of-utterance signal, used as the "endpoint" latency mark (D9). Closes the utterance.</summary>
public sealed record SttUtteranceEnd : SttEvent;

/// <summary>
/// The provider detected end of speech but the final transcript comes later (OpenAI server VAD). Marks
/// "endpoint" (D9) without closing the utterance; the next final with <c>EndsUtterance</c> closes it.
/// </summary>
public sealed record SttEndpoint : SttEvent;
