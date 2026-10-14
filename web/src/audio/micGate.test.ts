import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMicGate } from './micGate'

describe('createMicGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gates immediately and releases after the tail', () => {
    const apply = vi.fn()
    const gate = createMicGate(apply, 150)
    gate.setPlaybackActive(true)
    expect(apply).toHaveBeenLastCalledWith(true)
    gate.setPlaybackActive(false)
    vi.advanceTimersByTime(149)
    expect(apply).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(apply).toHaveBeenLastCalledWith(false)
  })

  it('stays gated if playback resumes within the tail', () => {
    const apply = vi.fn()
    const gate = createMicGate(apply, 150)
    gate.setPlaybackActive(true)
    gate.setPlaybackActive(false)
    vi.advanceTimersByTime(100)
    gate.setPlaybackActive(true)
    vi.advanceTimersByTime(500)
    expect(apply.mock.calls).toEqual([[true]])
  })

  it('dispose releases the mic and cancels the timer', () => {
    const apply = vi.fn()
    const gate = createMicGate(apply)
    gate.setPlaybackActive(true)
    gate.dispose()
    expect(apply).toHaveBeenLastCalledWith(false)
  })
})
