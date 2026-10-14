import { describe, expect, it } from 'vitest'
import { floatToPcm16, pcm16ToFloat, Resampler, rms } from './resample'

function sine(freq: number, rate: number, samples: number, amp = 0.5): Float32Array {
  return Float32Array.from({ length: samples }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate))
}

describe('Resampler', () => {
  it('produces 16 kHz output of the right length from 48 kHz input', () => {
    const r = new Resampler(48000, 16000)
    const out = r.process(new Float32Array(48000))
    expect(out).toBeInstanceOf(Int16Array)
    expect(out.length).toBe(16000)
  })

  it('keeps total length exact across odd-sized chunks (44.1 kHz)', () => {
    const r = new Resampler(44100, 16000)
    let total = 0
    for (let i = 0; i < 100; i++) total += r.process(new Float32Array(128)).length
    // 12800 input samples -> 12800 * 16000 / 44100 = 4643.99
    expect(Math.abs(total - (12800 * 16000) / 44100)).toBeLessThanOrEqual(1)
  })

  it('preserves a low-frequency tone across chunk boundaries', () => {
    const rate = 48000
    const input = sine(440, rate, 4800)
    const r = new Resampler(rate, 16000)
    const chunked = [...r.process(input.subarray(0, 1000)), ...r.process(input.subarray(1000))]
    const expected = sine(440, 16000, chunked.length)
    const maxErr = Math.max(...chunked.map((s, i) => Math.abs(s / 0x7fff - expected[i])))
    expect(maxErr).toBeLessThan(0.01)
  })

  it('rejects upsampling', () => {
    expect(() => new Resampler(16000, 24000)).toThrow()
  })
})

describe('PCM16 conversion', () => {
  it('clamps and round-trips', () => {
    expect(floatToPcm16(2)).toBe(32767)
    expect(floatToPcm16(-2)).toBe(-32768)
    const back = pcm16ToFloat(Int16Array.from([0, 32767, -32768]))
    expect([...back]).toEqual([0, 1, -1])
  })

  it('computes RMS', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})
