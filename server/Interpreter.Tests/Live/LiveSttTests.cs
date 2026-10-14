using Interpreter.Core.Cascade;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Live;

/// <summary>
/// Functional checks against the real providers with synthetic speech. Excluded from CI
/// (--filter-not-trait Category=Live). They assert behaviour only and record no latency or accuracy
/// numbers: Deepgram's terms forbid benchmarking without consent (README "Known constraints").
/// </summary>
[Trait("Category", "Live")]
public class LiveSttTests
{
    private const string Sentence = "I have had a headache since Monday. It gets worse at night.";

    private static async Task<List<SttEvent>> Run(IStreamingStt stt, CancellationToken ct)
    {
        var pcm16k = Pcm16.Resample(await SyntheticSpeech.Pcm24Async(Sentence, ct), 24000, 16000);
        var events = new List<SttEvent>();
        await foreach (var e in stt.TranscribeAsync(SyntheticSpeech.Frames(pcm16k, 16000, ct), new SttOptions("en"), ct))
            events.Add(e);
        return events;
    }

    [Fact]
    public async Task Deepgram_transcribes_synthetic_speech()
    {
        Assert.SkipWhen(SyntheticSpeech.Env("DEEPGRAM_API_KEY") is null || SyntheticSpeech.Env("OPENAI_API_KEY") is null,
            "needs DEEPGRAM_API_KEY and OPENAI_API_KEY");
        var stt = new DeepgramStt(Options.Create(new DeepgramOptions { ApiKey = SyntheticSpeech.Env("DEEPGRAM_API_KEY") }));

        var events = await Run(stt, TestContext.Current.CancellationToken);

        var text = string.Join(" ", events.OfType<SttFinal>().Select(f => f.Text));
        Assert.Contains("headache", text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(events, e => e is SttFinal { EndsUtterance: true } or SttUtteranceEnd);
        Assert.All(events.OfType<SttFinal>().Where(f => f.Text.Length > 0), f => Assert.NotNull(f.Confidence));
    }

    [Fact]
    public async Task OpenAI_transcribes_synthetic_speech()
    {
        Assert.SkipWhen(SyntheticSpeech.Env("OPENAI_API_KEY") is null, "needs OPENAI_API_KEY");
        var stt = new OpenAIRealtimeStt(Options.Create(new OpenAITranscriptionOptions { ApiKey = SyntheticSpeech.Env("OPENAI_API_KEY") }));

        var events = await Run(stt, TestContext.Current.CancellationToken);

        var text = string.Join(" ", events.OfType<SttFinal>().Select(f => f.Text));
        Assert.Contains("headache", text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(events, e => e is SttEndpoint);
        Assert.True(events.IndexOf(events.First(e => e is SttEndpoint)) < events.IndexOf(events.First(e => e is SttFinal)));
    }
}
