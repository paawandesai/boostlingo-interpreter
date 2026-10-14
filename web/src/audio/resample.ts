/**
 * Streaming linear-interpolation downsampler: Float32 at the AudioContext rate in,
 * PCM16 at the target rate (16 kHz for cascade STT) out.
 *
 * Stateful so frame boundaries don't click: the fractional read position and the last
 * input sample carry over between calls. Linear interpolation without a low-pass filter
 * is fine for speech at 16 kHz (D6); revisit only if WER looks off.
 */
export class Resampler {
  private readonly step: number
  /** Position of the next output sample, in input samples, relative to the start of the next chunk. */
  private pos = 0
  /** Last sample of the previous chunk, so interpolation can straddle the boundary (index -1). */
  private prev = 0

  readonly inRate: number
  readonly outRate: number

  constructor(inRate: number, outRate: number) {
    this.inRate = inRate
    this.outRate = outRate
    if (inRate <= 0 || outRate <= 0) throw new Error('Sample rates must be positive')
    if (outRate > inRate) throw new Error('Resampler only downsamples')
    this.step = inRate / outRate
  }

  process(input: Float32Array): Int16Array {
    const n = input.length
    if (n === 0) return new Int16Array(0)
    const out: number[] = []
    let pos = this.pos
    while (pos <= n - 1) {
      const i = Math.floor(pos)
      const frac = pos - i
      const a = i < 0 ? this.prev : input[i]
      const b = i + 1 < n ? input[i + 1] : a
      out.push(floatToPcm16(a + (b - a) * frac))
      pos += this.step
    }
    this.pos = pos - n
    this.prev = input[n - 1]
    return Int16Array.from(out)
  }

  reset(): void {
    this.pos = 0
    this.prev = 0
  }
}

export function floatToPcm16(x: number): number {
  const s = Math.max(-1, Math.min(1, x))
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff)
  return out
}

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}
