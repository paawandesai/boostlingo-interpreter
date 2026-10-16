import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplay, langFromName, type ReplayClip } from './replay'

describe('langFromName', () => {
  it('reads the language from the file-name prefix', () => {
    expect(langFromName('en-01.wav')).toBe('en')
    expect(langFromName('ES_medical_3.webm')).toBe('es')
  })

  it('returns null when there is no prefix', () => {
    expect(langFromName('clip.wav')).toBeNull()
    expect(langFromName('english-01.wav')).toBeNull()
  })
})

/** Just enough AudioContext for createReplay: buffer sources end on a timer of their duration. */
class FakeAudioContext {
  createMediaStreamDestination() {
    return { stream: { getTracks: () => [], getAudioTracks: () => [] } }
  }
  createBufferSource() {
    const src = {
      buffer: null as { duration: number } | null,
      onended: null as (() => void) | null,
      connect() {},
      disconnect() {},
      start() {
        setTimeout(() => src.onended?.(), (src.buffer?.duration ?? 0) * 1000)
      },
      stop() {},
    }
    return src
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}

const clip = (name: string, seconds: number) =>
  ({ name, lang: 'en', buffer: { duration: seconds } }) as unknown as ReplayClip

describe('createReplay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for the interpretation of a clip to start and finish before the next clip', async () => {
    const started: Array<[string, number]> = []
    let busy = false
    const r = createReplay([clip('en-1', 1), clip('en-2', 1)], {
      gapMs: 100,
      loop: false,
      replyWaitMs: () => 5000,
      isBusy: () => busy,
      onClip: (c) => started.push([c.name, Date.now()]),
    })
    const t0 = Date.now()
    void r.run()
    await vi.advanceTimersByTimeAsync(100 + 1000) // gap, then clip 1 plays
    expect(started.map(([n]) => n)).toEqual(['en-1'])
    // The interpretation starts 2 s after the clip ends and plays for 1.5 s.
    await vi.advanceTimersByTimeAsync(2000)
    expect(started).toHaveLength(1)
    busy = true
    await vi.advanceTimersByTimeAsync(1500)
    expect(started).toHaveLength(1)
    busy = false
    await vi.advanceTimersByTimeAsync(400)
    expect(started.map(([n]) => n)).toEqual(['en-1', 'en-2'])
    expect(started[1][1] - t0).toBeGreaterThanOrEqual(100 + 1000 + 2000 + 1500 + 100)
    await r.stop()
  })

  it('moves on after replyWaitMs when no interpretation starts', async () => {
    const started: string[] = []
    const r = createReplay([clip('en-1', 1), clip('en-2', 1)], {
      gapMs: 100,
      loop: false,
      replyWaitMs: () => 3000,
      isBusy: () => false,
      onClip: (c) => started.push(c.name),
    })
    void r.run()
    await vi.advanceTimersByTimeAsync(100 + 1000 + 2900)
    expect(started).toEqual(['en-1'])
    await vi.advanceTimersByTimeAsync(300)
    expect(started).toEqual(['en-1', 'en-2'])
    await r.stop()
  })

  it('does not wait for a reply when replyWaitMs is 0', async () => {
    const started: string[] = []
    const r = createReplay([clip('en-1', 1), clip('en-2', 1)], {
      gapMs: 100,
      loop: false,
      replyWaitMs: () => 0,
      onClip: (c) => started.push(c.name),
    })
    void r.run()
    await vi.advanceTimersByTimeAsync(100 + 1000 + 150)
    expect(started).toEqual(['en-1', 'en-2'])
    await r.stop()
  })
})
