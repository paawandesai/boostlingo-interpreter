import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientEndpointer, commitDelayMs, DEFAULT_COMMIT_DELAY_MS } from './endpointing'

describe('ClientEndpointer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('commits once, the delay after speech ends', () => {
    const commit = vi.fn()
    const e = new ClientEndpointer(commit, 150)
    e.onVad('speech.start')
    e.onVad('speech.end')
    vi.advanceTimersByTime(149)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('does not commit when speech resumes within the delay', () => {
    const commit = vi.fn()
    const e = new ClientEndpointer(commit, 150)
    e.onVad('speech.start')
    e.onVad('speech.end')
    vi.advanceTimersByTime(100)
    e.onVad('speech.start')
    vi.advanceTimersByTime(500)
    expect(commit).not.toHaveBeenCalled()
    e.onVad('speech.end')
    vi.advanceTimersByTime(150)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('commits an open turn at once when the mic gate closes, and only an open one', () => {
    const commit = vi.fn()
    const e = new ClientEndpointer(commit, 150)
    e.onGated(true)
    expect(commit).not.toHaveBeenCalled()
    e.onVad('speech.start')
    e.onGated(true)
    expect(commit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('ignores a speech.end with no open turn, and stops after dispose', () => {
    const commit = vi.fn()
    const e = new ClientEndpointer(commit, 150)
    e.onVad('speech.end')
    vi.advanceTimersByTime(500)
    e.onVad('speech.start')
    e.onVad('speech.end')
    e.dispose()
    vi.advanceTimersByTime(500)
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('commitDelayMs', () => {
  it('reads ?commitDelay= and falls back to the default', () => {
    expect(commitDelayMs('?commitDelay=300')).toBe(300)
    expect(commitDelayMs('?commitDelay=0')).toBe(0)
    expect(commitDelayMs('')).toBe(DEFAULT_COMMIT_DELAY_MS)
    expect(commitDelayMs('?commitDelay=abc')).toBe(DEFAULT_COMMIT_DELAY_MS)
  })
})
