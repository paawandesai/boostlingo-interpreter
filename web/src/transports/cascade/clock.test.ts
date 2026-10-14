import { describe, expect, it } from 'vitest'
import { ClockSync } from './clock'

describe('ClockSync', () => {
  it('keeps the offset from the fastest round trip', () => {
    const clock = new ClockSync()
    // Server clock = client clock - 1000. A slow sample (rtt 80) then a fast one (rtt 10).
    clock.onPong(100, 100 - 1000 + 60, 180)
    clock.onPong(200, 200 - 1000 + 5, 210)
    clock.onPong(300, 300 - 1000 + 40, 400) // slower: ignored

    expect(clock.rttMs).toBe(10)
    expect(clock.toClient(5000, 0)).toBe(6000)
  })

  it('falls back to now before the first pong', () => {
    const clock = new ClockSync()
    expect(clock.synced).toBe(false)
    expect(clock.toClient(5000, 42)).toBe(42)
  })

  it('decay lets a slightly slower path replace a stale sample', () => {
    const clock = new ClockSync()
    clock.onPong(0, -1000 + 5, 10)
    clock.decay()
    clock.onPong(100, 100 - 1500 + 6, 112) // clock moved; rtt 12 < 15 after decay
    expect(clock.toClient(0, 0)).toBe(1500)
  })
})
