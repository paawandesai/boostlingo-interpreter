import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../types'

let onFrame: ((pcm: Int16Array) => void) | undefined
const capture = {
  stream: {} as MediaStream,
  context: { getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 5000 }) } as unknown as AudioContext,
  setGated: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../audio/capture', () => ({
  MicDeniedError: class MicDeniedError extends Error {},
  startCapture: vi.fn(async (opts: { onFrame?: (pcm: Int16Array) => void }) => {
    onFrame = opts.onFrame
    return capture
  }),
  contextMsToPerf: (_ctx: unknown, ms: number) => 4000 + ms,
}))
const enqueue = vi.fn<(samples: Float32Array, rate: number) => number | null>(() => 2.5)
vi.mock('../../audio/playback', () => ({
  PlaybackScheduler: class {
    enqueue = enqueue
    stop = vi.fn()
  },
}))
vi.mock('../../session/access', () => ({ currentAccessToken: () => 'demo-token' }))

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3
  })
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(d: unknown) {
    this.sent.push(d)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  server(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  json() {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

describe('CascadeTransport', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function started() {
    const { CascadeTransport } = await import('./CascadeTransport')
    CascadeTransport.url = () => 'ws://test/ws/cascade'
    const t = new CascadeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })
    const ws = FakeSocket.all[0]
    ws.open()
    return { t, ws, events }
  }

  it('authenticates in the first message and only streams audio once ready', async () => {
    const { ws, events } = await started()

    expect(ws.json()[0]).toEqual({ type: 'start', token: 'demo-token', source: 'en', target: 'es', glossary: false })
    onFrame!(new Int16Array(320))
    expect(ws.sent).toHaveLength(1)

    ws.server({ type: 'ready', t: 0 })
    onFrame!(new Int16Array(320))
    expect(ws.sent[1]).toBeInstanceOf(Int16Array)
    expect(events).toContainEqual({ type: 'state', state: 'live' })

    vi.advanceTimersByTime(500)
    expect(ws.json().filter((m) => m.type === 'ping')).toHaveLength(5)
  })

  it('plays audio and marks first audio out at its scheduled start', async () => {
    const { ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })
    ws.server({ type: 'latency.mark', u: 1, name: 'tts.first_byte', t: 10 })

    ws.onmessage!({ data: new Int16Array([16384, -16384]).buffer })
    ws.onmessage!({ data: new Int16Array([1]).buffer })

    expect(Array.from(enqueue.mock.calls[0][0])).toEqual([0.5, -0.5])
    expect(enqueue.mock.calls[0][1]).toBe(24000)
    const firstOut = events.filter((e) => e.type === 'mark' && e.name === 'audio.first_out')
    expect(firstOut).toEqual([{ type: 'mark', name: 'audio.first_out', t: 6500, utteranceId: 'c1-1' }])
  })

  it('opens a new socket for the other direction on a speaker switch', async () => {
    const { t, ws } = await started()
    t.setSpeaker('B')

    expect(ws.close).toHaveBeenCalled()
    const next = FakeSocket.all[1]
    next.open()
    expect(next.json()[0]).toMatchObject({ type: 'start', source: 'es', target: 'en' })
  })

  it('re-measures the clock offset on each new socket', async () => {
    const { t, ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })
    const c1 = performance.now()
    ws.server({ type: 'pong', c: c1 - 10, t: 100_000 })

    t.setSpeaker('B')
    const next = FakeSocket.all[1]
    next.open()
    next.server({ type: 'ready', t: 0 })
    const c2 = performance.now()
    // Slower round trip than the first socket's best: it must still be used, the server clock restarted.
    next.server({ type: 'pong', c: c2 - 40, t: 5 })
    next.server({ type: 'latency.mark', u: 1, name: 'tts.first_byte', t: 50 })

    const mark = events.find((e) => e.type === 'mark' && e.utteranceId === 'c2-1')
    expect(mark).toMatchObject({ name: 'tts.first_byte' })
    expect((mark as { t: number }).t).toBeCloseTo(c2 - 40 + 20 - 5 + 50, 5)
  })

  it('sends the latest finished turns as context on every new socket (G9)', async () => {
    const { CascadeTransport } = await import('./CascadeTransport')
    CascadeTransport.url = () => 'ws://test/ws/cascade'
    const t = new CascadeTransport()
    const pairs = Array.from({ length: 8 }, (_, i) => ({ source: `s${i}`, target: `t${i}` }))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A', history: () => pairs })
    FakeSocket.all[0].open()
    expect(FakeSocket.all[0].json()[0].history).toEqual(pairs.slice(-6))

    pairs.push({ source: 'new', target: 'nuevo' })
    t.setSpeaker('B')
    FakeSocket.all[1].open()
    expect((FakeSocket.all[1].json()[0].history as unknown[]).at(-1)).toEqual({ source: 'new', target: 'nuevo' })
  })

  it('stop closes the socket and the mic', async () => {
    const { t, ws, events } = await started()
    await t.stop()

    expect(ws.close).toHaveBeenCalled()
    expect(capture.stop).toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
  })

  it('reports an abnormal close', async () => {
    const { ws, events } = await started()
    ws.onclose!({ code: 1011 })
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'unavailable' })
  })

  it("keeps the server's refusal reason instead of a generic close error", async () => {
    const { ws, events } = await started()
    ws.server({
      type: 'error',
      stage: 'session',
      provider: 'workbench',
      kind: 'Auth',
      message: 'Missing or wrong access token.',
      t: 1,
    })
    ws.onclose!({ code: 1008, reason: 'Missing or wrong access token.' })
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'Missing or wrong access token.' })
  })

  it('shows the close reason when no error message arrived', async () => {
    const { ws, events } = await started()
    ws.onclose!({ code: 1008, reason: 'Unsupported language direction' })
    expect(events.at(-1)).toMatchObject({ message: 'Cascade connection closed (1008): Unsupported language direction' })
  })
})
