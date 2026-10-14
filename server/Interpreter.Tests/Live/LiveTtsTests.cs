using Interpreter.Core.Cascade;
using Interpreter.Providers.ElevenLabs;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Live;

[Trait("Category", "Live")]
public class LiveTtsTests
{
    private static async IAsyncEnumerable<string> Chunks()
    {
        foreach (var c in new[] { "Hola, buenos días.", "¿Dónde le duele?" })
        {
            await Task.Delay(100);
            yield return c;
        }
    }

    [Fact]
    public async Task ElevenLabs_streams_audio_for_chunked_spanish_text()
    {
        Assert.SkipWhen(SyntheticSpeech.Env("ELEVENLABS_API_KEY") is null, "needs ELEVENLABS_API_KEY");
        var tts = new ElevenLabsTts(Options.Create(new ElevenLabsOptions { ApiKey = SyntheticSpeech.Env("ELEVENLABS_API_KEY") }));

        var bytes = 0;
        var chunks = 0;
        await foreach (var c in tts.SynthesizeAsync(Chunks(), new TtsOptions("es"), TestContext.Current.CancellationToken))
        {
            bytes += c.Pcm16.Length;
            chunks++;
        }

        // About 2 s of speech at 24 kHz PCM16 is roughly 96 kB; check it is plausibly speech-length audio.
        Assert.InRange(bytes, 48_000, 480_000);
        Assert.True(chunks > 1, "audio should stream in several chunks");
    }
}
