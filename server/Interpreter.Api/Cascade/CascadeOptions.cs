namespace Interpreter.Api.Cascade;

/// <summary>Which adapter serves each cascade stage. Swapping a vendor is a change here, not in code (D7).</summary>
public sealed class CascadeOptions
{
    public const string Section = "Cascade";

    /// <summary>"deepgram" or "openai". See README "Known constraints" before publishing numbers from Deepgram.</summary>
    public string Stt { get; set; } = "deepgram";

    /// <summary>"openai" or "anthropic"; a client may pick either per session.</summary>
    public string Translator { get; set; } = "openai";

    /// <summary>"elevenlabs" or "openai".</summary>
    public string Tts { get; set; } = "elevenlabs";

    /// <summary>Adapter names each stage accepts; anything else stops startup with the setting's name.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Adapters = new Dictionary<string, string[]>
    {
        ["Stt"] = ["deepgram", "openai"],
        ["Translator"] = ["openai", "anthropic"],
        ["Tts"] = ["elevenlabs", "openai"],
    };

    /// <summary>
    /// When streamed translation text is released to TTS (D11, <see cref="Interpreter.Core.Cascade.FlushPolicy"/>).
    /// Tunable per deployment (env <c>Cascade__Flush__MaxWaitMs</c> and so on) without a code change.
    /// </summary>
    public FlushSettings Flush { get; set; } = new();

    /// <summary>Optional stock voice per target language code; the TTS adapter's default otherwise.</summary>
    public Dictionary<string, string> Voices { get; set; } = [];

    /// <summary>How long a new socket may wait before sending its start message.</summary>
    public int StartTimeoutSeconds { get; set; } = 10;

    /// <summary>
    /// Hard cap on one session (G19): after this the server stops taking audio, finishes the turns in flight
    /// and closes, so a forgotten or looping session can't run up the bill.
    /// </summary>
    public int MaxSessionSeconds { get; set; } = 1800;

    /// <summary>
    /// Abuse limit: a session may send audio at most this many times faster than real time, plus
    /// <see cref="AudioBurstSeconds"/>, before it is closed as a policy violation. A real mic sends 1x.
    /// </summary>
    public double AudioRateFactor { get; set; } = 1.25;

    /// <summary>Seconds of audio a session may send ahead of real time (network bursts) before the rate limit applies.</summary>
    public double AudioBurstSeconds { get; set; } = 5;
}

/// <summary>Configuration form of <see cref="Interpreter.Core.Cascade.FlushOptions"/>; the defaults are the same.</summary>
public sealed class FlushSettings
{
    private static readonly Interpreter.Core.Cascade.FlushOptions Defaults = new();

    /// <summary>A clause boundary (, ; :) releases text only once this many characters are buffered.</summary>
    public int MinClauseChars { get; set; } = Defaults.MinClauseChars;

    /// <summary>With no boundary for this long, release up to the last word break.</summary>
    public int MaxWaitMs { get; set; } = Defaults.MaxWaitMs;

    /// <summary>...if at least this many characters are buffered.</summary>
    public int MinCharsOnTimeout { get; set; } = Defaults.MinCharsOnTimeout;

    public Interpreter.Core.Cascade.FlushOptions ToOptions() => new(MinClauseChars, MaxWaitMs, MinCharsOnTimeout);
}
