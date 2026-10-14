using System.Runtime.InteropServices;
using Interpreter.Core.Cascade;

namespace Interpreter.Tests.Core;

public class Pcm16Tests
{
    private static byte[] Bytes(params short[] samples) => MemoryMarshal.AsBytes(samples.AsSpan()).ToArray();
    private static short[] Samples(byte[] pcm) => MemoryMarshal.Cast<byte, short>(pcm).ToArray();

    [Fact]
    public void Upsampling_16k_to_24k_interpolates_and_keeps_duration()
    {
        var output = Samples(Pcm16.Resample(Bytes(0, 300, 600, 900), 16000, 24000));

        Assert.Equal([0, 200, 400, 600, 800, 900], output);
    }

    [Fact]
    public void Downsampling_24k_to_16k_keeps_duration()
    {
        var input = Enumerable.Range(0, 480).Select(i => (short)(i * 10)).ToArray();
        Assert.Equal(320, Samples(Pcm16.Resample(Bytes(input), 24000, 16000)).Length);
    }

    [Fact]
    public void Same_rate_copies_and_odd_trailing_byte_is_dropped()
    {
        Assert.Equal(Bytes(1, 2), Pcm16.Resample([.. Bytes(1, 2), 7], 16000, 16000));
        Assert.Empty(Pcm16.Resample([], 16000, 24000));
    }

    [Fact]
    public void Extremes_do_not_overflow()
    {
        Assert.Equal([short.MinValue, 0, short.MaxValue, short.MaxValue],
            Samples(Pcm16.Resample(Bytes(short.MinValue, short.MaxValue), 16000, 32000)));
    }
}
