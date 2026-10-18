import { describe, expect, it } from 'vitest'
import { firstAudibleOffsetSec, isAudible } from './firstAudioProbe'

describe('isAudible', () => {
  it('treats digital silence and low noise as silent', () => {
    expect(isAudible(new Float32Array(256))).toBe(false)
    expect(isAudible(Float32Array.from({ length: 256 }, () => (Math.random() - 0.5) * 0.004))).toBe(false)
  })

  it('detects speech-level audio', () => {
    expect(isAudible(Float32Array.from({ length: 256 }, (_, i) => 0.1 * Math.sin(i / 3)))).toBe(true)
  })
})

describe('firstAudibleOffsetSec', () => {
  it('finds the first audible 5 ms frame, by the same test as the Realtime probe', () => {
    const samples = new Float32Array(2400) // 100 ms at 24 kHz
    samples.fill(0.2, 1200)
    expect(firstAudibleOffsetSec(samples, 24000)).toBeCloseTo(0.05, 5)
  })

  it('is null for a silent chunk', () => {
    expect(firstAudibleOffsetSec(new Float32Array(2400), 24000)).toBeNull()
  })
})
