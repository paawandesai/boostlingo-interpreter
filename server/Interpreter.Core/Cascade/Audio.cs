namespace Interpreter.Core.Cascade;

/// <summary>Mono PCM16 little-endian audio from the client mic (16 kHz in cascade mode, D6).</summary>
public readonly record struct AudioFrame(ReadOnlyMemory<byte> Pcm16, int SampleRate);

/// <summary>Mono PCM16 little-endian audio from a TTS provider (24 kHz requested, D6).</summary>
public readonly record struct AudioChunk(ReadOnlyMemory<byte> Pcm16, int SampleRate);
