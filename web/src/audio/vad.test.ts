import { describe, expect, it } from 'vitest'
import { rms } from './resample'
import { EnergyVad, type VadEvent } from './vad'

const RATE = 16000
const FRAME = 320 // 20 ms

/** Synthetic signal: tone for `toneMs`, then silence for `silenceMs`, in 20 ms frames. */
function run(vad: EnergyVad, segments: Array<{ ms: number; amp: number }>): VadEvent[] {
  const events: VadEvent[] = []
  let t = 0
  for (const seg of segments) {
    for (let f = 0; f < seg.ms / 20; f++) {
      const frame = Float32Array.from({ length: FRAME }, (_, i) => seg.amp * Math.sin((2 * Math.PI * 220 * i) / RATE))
      const e = vad.process(rms(frame), t, t + 20)
      if (e) events.push(e)
      t += 20
    }
  }
  return events
}

describe('EnergyVad', () => {
  it('emits start and a back-dated end for tone then silence', () => {
    const events = run(new EnergyVad(), [
      { ms: 200, amp: 0 },
      { ms: 600, amp: 0.3 },
      { ms: 400, amp: 0 },
    ])
    expect(events).toEqual([
      { kind: 'speech.start', t: 200 },
      // speech ends at 800 ms (last voiced frame end), reported after the 200 ms hangover
      { kind: 'speech.end', t: 800 },
    ])
  })

  it('ignores a click shorter than minSpeechMs', () => {
    const events = run(new EnergyVad(), [
      { ms: 40, amp: 0.5 },
      { ms: 400, amp: 0 },
    ])
    expect(events).toEqual([])
  })

  it('does not end on a pause shorter than the hangover', () => {
    const events = run(new EnergyVad(), [
      { ms: 300, amp: 0.3 },
      { ms: 100, amp: 0 },
      { ms: 300, amp: 0.3 },
      { ms: 300, amp: 0 },
    ])
    expect(events.map((e) => e.kind)).toEqual(['speech.start', 'speech.end'])
    expect(events[1].t).toBe(700)
  })

  it('treats low-level noise as silence', () => {
    const events = run(new EnergyVad(), [{ ms: 1000, amp: 0.005 }])
    expect(events).toEqual([])
  })
})
