using System.Runtime.InteropServices;

namespace Interpreter.Core.Cascade;

/// <summary>Mono PCM16 little-endian audio from the client mic (16 kHz in cascade mode, D6).</summary>
/// <param name="EndOfSpeech">
/// No audio: the client's VAD says the speaker stopped. An adapter with client endpointing ends the turn here
/// instead of waiting for its own VAD; every other adapter skips the frame.
/// </param>
public readonly record struct AudioFrame(ReadOnlyMemory<byte> Pcm16, int SampleRate, bool EndOfSpeech = false)
{
    public static AudioFrame SpeechEnded(int sampleRate) => new(ReadOnlyMemory<byte>.Empty, sampleRate, true);
}

/// <summary>Mono PCM16 little-endian audio from a TTS provider (24 kHz requested, D6).</summary>
public readonly record struct AudioChunk(ReadOnlyMemory<byte> Pcm16, int SampleRate);

/// <summary>PCM16 helpers for adapters whose provider wants a different sample rate (D6).</summary>
public static class Pcm16
{
    /// <summary>
    /// Linear-interpolation resampling of mono PCM16 little-endian audio. Each call is independent, so frame
    /// edges are not smoothed; D6 accepts that for speech.
    /// </summary>
    public static byte[] Resample(ReadOnlySpan<byte> pcm, int fromRate, int toRate)
    {
        if (fromRate <= 0 || toRate <= 0) throw new ArgumentOutOfRangeException(nameof(fromRate));
        var input = MemoryMarshal.Cast<byte, short>(pcm[..(pcm.Length & ~1)]);
        if (fromRate == toRate || input.Length == 0) return pcm[..(input.Length * 2)].ToArray();

        var outCount = (int)((long)input.Length * toRate / fromRate);
        var output = new byte[outCount * 2];
        var samples = MemoryMarshal.Cast<byte, short>(output.AsSpan());
        var step = (double)fromRate / toRate;
        for (var i = 0; i < outCount; i++)
        {
            var pos = i * step;
            var j = (int)pos;
            var next = Math.Min(j + 1, input.Length - 1);
            var frac = pos - j;
            samples[i] = (short)Math.Round(input[j] + (input[next] - input[j]) * frac);
        }
        return output;
    }
}
