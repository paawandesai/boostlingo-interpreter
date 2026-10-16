using System.Diagnostics;
using Interpreter.Core.Cascade;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Live;

[Trait("Category", "Live")]
public class LiveOpenAITtsTests
{
    // Synthetic, invented phrases only (docs/GUARDRAILS.md).
    public static TheoryData<string, string> Phrases => new()
    {
        { "en", "Good morning, how are you feeling today?" },
        { "en", "Please take this medicine twice a day." },
        { "es", "Hola, buenos días. ¿Dónde le duele?" },
    };

    private static async IAsyncEnumerable<string> One(string text)
    {
        await Task.Yield();
        yield return text;
    }

    [Theory]
    [MemberData(nameof(Phrases))]
    public async Task OpenAI_speech_streams_whole_sample_pcm(string language, string text)
    {
        Assert.SkipWhen(SyntheticSpeech.Env("OPENAI_API_KEY") is null, "needs OPENAI_API_KEY");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var tts = new OpenAISpeechTts(http, Options.Create(new OpenAISpeechOptions { ApiKey = SyntheticSpeech.Env("OPENAI_API_KEY") }));

        var bytes = 0;
        TimeSpan? firstAudio = null;
        var clock = Stopwatch.StartNew();
        await foreach (var c in tts.SynthesizeAsync(One(text), new TtsOptions(language, "alloy", 24000), TestContext.Current.CancellationToken))
        {
            firstAudio ??= clock.Elapsed;
            Assert.Equal(24000, c.SampleRate);
            Assert.True(c.Pcm16.Length % 2 == 0, "every chunk should hold whole PCM16 samples");
            bytes += c.Pcm16.Length;
        }

        var line = $"openai-tts [{language}] first audio byte {firstAudio?.TotalMilliseconds:F0} ms, total {clock.Elapsed.TotalMilliseconds:F0} ms, {bytes} bytes";
        TestContext.Current.TestOutputHelper?.WriteLine(line);
        Console.Error.WriteLine(line);

        Assert.True(bytes > 0, "no audio returned");
        Assert.True(bytes % 2 == 0, "audio should be whole PCM16 samples");
    }
}
