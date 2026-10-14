import { describe, expect, it, vi } from 'vitest'
import { PlaybackScheduler, type PlaybackContext } from './playback'

/** Minimal fake AudioContext with a manually advanced clock. */
function fakeContext() {
  const sources: Array<{ start: number; stopped: boolean; duration: number; onended: (() => void) | null }> = []
  const ctx = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createBuffer: (_ch: number, length: number, rate: number) => {
      const data = new Float32Array(length)
      return { duration: length / rate, getChannelData: () => data } as unknown as AudioBuffer
    },
    createBufferSource: () => {
      const rec = { start: NaN, stopped: false, duration: 0, onended: null as (() => void) | null }
      sources.push(rec)
      const node = {
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: (when: number) => {
          rec.start = when
          rec.duration = node.buffer!.duration
        },
        stop: () => {
          rec.stopped = true
        },
        set onended(fn: (() => void) | null) {
          rec.onended = fn
        },
      }
      return node as unknown as AudioBufferSourceNode
    },
  }
  return { ctx: ctx as PlaybackContext & { currentTime: number }, sources }
}

const chunk = (sec: number, rate = 24000) => new Float32Array(Math.round(sec * rate))

describe('PlaybackScheduler', () => {
  it('schedules chunks back to back and reports the first one', () => {
    const { ctx, sources } = fakeContext()
    const onFirstAudio = vi.fn()
    const p = new PlaybackScheduler(ctx, { onFirstAudio })
    p.enqueue(chunk(0.5), 24000)
    p.enqueue(chunk(0.5), 24000)
    expect(sources.map((s) => s.start)).toEqual([0.02, 0.52])
    expect(onFirstAudio).toHaveBeenCalledOnce()
    expect(onFirstAudio).toHaveBeenCalledWith(0.02)
  })

  it('caps queued audio at maxAheadSec and reports a drift skip', () => {
    const { ctx } = fakeContext()
    const onDriftSkip = vi.fn()
    const p = new PlaybackScheduler(ctx, { onDriftSkip }, 3)
    for (let i = 0; i < 10; i++) p.enqueue(chunk(0.5), 24000)
    expect(p.queuedAheadSec).toBeLessThanOrEqual(3)
    expect(onDriftSkip).toHaveBeenCalled()
    const dropped = onDriftSkip.mock.calls.reduce((s, c) => s + (c[1] as number), 0)
    // 10 x 0.5 s offered; 20 ms lead + 5 chunks = 2.52 s fits under 3 s, a 6th would not
    expect(dropped).toBe(5)
  })

  it('never drops the chunk that is currently playing', () => {
    const { ctx, sources } = fakeContext()
    const p = new PlaybackScheduler(ctx, {}, 1)
    p.enqueue(chunk(0.8), 24000)
    ctx.currentTime = 0.1 // first chunk is playing
    p.enqueue(chunk(0.8), 24000)
    p.enqueue(chunk(0.8), 24000)
    expect(sources[0].stopped).toBe(false)
  })

  it('reports active on first audio and inactive when drained', () => {
    const { ctx, sources } = fakeContext()
    const onActiveChange = vi.fn()
    const p = new PlaybackScheduler(ctx, { onActiveChange })
    p.enqueue(chunk(0.2), 24000)
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    sources[0].onended?.()
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('stop() stops every source and resets the burst', () => {
    const { ctx, sources } = fakeContext()
    const onFirstAudio = vi.fn()
    const p = new PlaybackScheduler(ctx, { onFirstAudio })
    p.enqueue(chunk(0.5), 24000)
    p.enqueue(chunk(0.5), 24000)
    p.stop()
    expect(sources.every((s) => s.stopped)).toBe(true)
    p.enqueue(chunk(0.5), 24000)
    expect(onFirstAudio).toHaveBeenCalledTimes(2)
  })
})
