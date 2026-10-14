import { describe, expect, it } from 'vitest'
import { isAudible } from './firstAudioProbe'

describe('isAudible', () => {
  it('treats digital silence and low noise as silent', () => {
    expect(isAudible(new Float32Array(256))).toBe(false)
    expect(isAudible(Float32Array.from({ length: 256 }, () => (Math.random() - 0.5) * 0.004))).toBe(false)
  })

  it('detects speech-level audio', () => {
    expect(isAudible(Float32Array.from({ length: 256 }, (_, i) => 0.1 * Math.sin(i / 3)))).toBe(true)
  })
})
