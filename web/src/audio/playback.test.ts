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

  it('plays one long turn in full even when it arrives faster than real time', () => {
    const { ctx } = fakeContext()
    const onDriftSkip = vi.fn()
    const p = new PlaybackScheduler(ctx, { onDriftSkip }, 3)
    // A 6 s interpretation streamed at 5x real time: 60 chunks of 0.1 s, one every 20 ms.
    for (let i = 0; i < 60; i++) {
      ctx.currentTime = i * 0.02
      p.enqueue(chunk(0.1), 24000, 'u1')
    }
    expect(onDriftSkip).not.toHaveBeenCalled()
    expect(p.queuedAheadSec).toBeCloseTo(6 + 0.02 - 59 * 0.02, 5)
  })

  it('drops the backlog of earlier turns, never the arriving one, and names the turns', () => {
    const { ctx } = fakeContext()
    const onDriftSkip = vi.fn()
    const p = new PlaybackScheduler(ctx, { onDriftSkip }, 3)
    for (let i = 0; i < 8; i++) p.enqueue(chunk(0.5), 24000, 'u1') // 4 s of u1, nothing played yet
    onDriftSkip.mockClear()
    for (let i = 0; i < 4; i++) p.enqueue(chunk(0.5), 24000, 'u2')
    expect(onDriftSkip).toHaveBeenCalled()
    const turns = new Set(onDriftSkip.mock.calls.flatMap((c) => c[2] as string[]))
    expect([...turns]).toEqual(['u1'])
    const dropped = onDriftSkip.mock.calls.reduce((s, c) => s + (c[0] as number), 0)
    // u2's 2 s all kept; u1 trimmed to what fits beside it under 3 s (20 ms lead + 0.5 s of u1)
    expect(dropped).toBeCloseTo(3.5, 5)
  })

  it('trims the arriving turn only past the memory ceiling', () => {
    const { ctx } = fakeContext()
    const onDriftSkip = vi.fn()
    const p = new PlaybackScheduler(ctx, { onDriftSkip }, 3, ctx.destination, 10)
    for (let i = 0; i < 30; i++) p.enqueue(chunk(0.5), 24000, 'u1')
    expect(p.queuedAheadSec).toBeLessThanOrEqual(10)
    expect(onDriftSkip).toHaveBeenCalled()
    expect(onDriftSkip.mock.calls[0][2]).toEqual(['u1'])
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
