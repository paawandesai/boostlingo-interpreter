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
const playbackStop = vi.fn()
vi.mock('../../audio/playback', () => ({
  PlaybackScheduler: class {
    enqueue = enqueue
    stop = playbackStop
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
  /** The socket dropped (the server went away, not a client close). */
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
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
    enqueue.mockClear()
    playbackStop.mockClear()
    capture.stop.mockClear()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function fresh() {
    const { CascadeTransport } = await import('./CascadeTransport')
    CascadeTransport.url = () => 'ws://test/ws/cascade'
    const t = new CascadeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    return { t, events }
  }

  async function started() {
    const { t, events } = await fresh()
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

  it('switches direction over the open socket and keeps playing the turn in flight', async () => {
    const { t, ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })

    t.setSpeaker('B')

    expect(FakeSocket.all).toHaveLength(1)
    expect(ws.close).not.toHaveBeenCalled()
    expect(ws.json().filter((m) => m.type === 'direction')).toEqual([{ type: 'direction', source: 'es', target: 'en' }])
    expect(playbackStop).not.toHaveBeenCalled()
    // The server finishes the old direction's turn first: what arrives before its ack is shown and played.
    ws.server({ type: 'transcript.final', u: 1, text: 'late', t: 5 })
    ws.server({ type: 'latency.mark', u: 1, name: 'tts.first_byte', t: 6 })
    ws.onmessage!({ data: new Int16Array([1]).buffer })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'transcript', role: 'source', utteranceId: 'c1-1', text: 'late', final: true }),
    )
    // Finished after the flip, but spoken before it: it keeps side A.
    expect(events.find((e) => e.type === 'transcript' && e.utteranceId === 'c1-1')).toMatchObject({ side: 'A' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'mark', name: 'audio.first_out', utteranceId: 'c1-1' }),
    )
    // Audio keeps flowing: the server queues it for the new direction.
    onFrame!(new Int16Array(320))
    expect(ws.sent.at(-1)).toBeInstanceOf(Int16Array)

    ws.server({ type: 'direction', source: 'es', target: 'en', t: 6 })
    ws.server({ type: 'transcript.final', u: 2, text: 'Hola.', t: 7 })
    expect(events.at(-1)).toMatchObject({
      type: 'transcript',
      role: 'source',
      utteranceId: 'c1-2',
      text: 'Hola.',
      side: 'B',
    })

    for (let i = 0; i < 10; i++) t.setSpeaker(i % 2 ? 'B' : 'A')
    expect(FakeSocket.all).toHaveLength(1)
    expect(ws.json().filter((m) => m.type === 'direction')).toHaveLength(11)
    expect(playbackStop).not.toHaveBeenCalled()
  })

  it('reopens the socket on a speaker switch only after it dropped, with a fresh clock', async () => {
    const { t, ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })
    const c1 = performance.now()
    ws.server({ type: 'pong', c: c1 - 10, t: 100_000 })
    ws.drop()
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'unavailable' })

    t.setSpeaker('B')
    const next = FakeSocket.all[1]
    next.open()
    expect(next.json()[0]).toMatchObject({ type: 'start', source: 'es', target: 'en' })
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
    const { t } = await fresh()
    const pairs = Array.from({ length: 8 }, (_, i) => ({ source: `s${i}`, target: `t${i}` }))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A', history: () => pairs })
    FakeSocket.all[0].open()
    expect(FakeSocket.all[0].json()[0].history).toEqual(pairs.slice(-6))

    pairs.push({ source: 'new', target: 'nuevo' })
    FakeSocket.all[0].drop()
    t.setSpeaker('B')
    FakeSocket.all[1].open()
    expect((FakeSocket.all[1].json()[0].history as unknown[]).at(-1)).toEqual({ source: 'new', target: 'nuevo' })
  })

  it('reports STT audio time every 5 s and the remainder on stop (T3.5)', async () => {
    const { t, ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })
    const reported = () => events.flatMap((e) => (e.type === 'usage' ? [e.usage.sttAudioSeconds] : []))

    for (let i = 0; i < 249; i++) onFrame!(new Int16Array(320)) // 4.98 s of 20 ms frames
    expect(reported()).toEqual([])
    onFrame!(new Int16Array(320))
    expect(reported()).toEqual([5])
    for (let i = 0; i < 100; i++) onFrame!(new Int16Array(320))
    expect(reported()).toEqual([5])

    await t.stop()
    expect(reported()).toEqual([5, 2])
  })

  it('reports a denied microphone, opens no socket and can still be stopped', async () => {
    const { MicDeniedError, startCapture } = await import('../../audio/capture')
    vi.mocked(startCapture).mockRejectedValueOnce(new MicDeniedError('Microphone access was denied'))
    const { t, events } = await fresh()

    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })

    expect(events.at(-1)).toEqual({ type: 'error', kind: 'mic_denied', message: 'Microphone access was denied' })
    expect(FakeSocket.all).toHaveLength(0)
    expect(capture.stop).not.toHaveBeenCalled()
    await t.stop()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
  })

  it('stop closes the socket and the mic', async () => {
    const { t, ws, events } = await started()
    await t.stop()

    expect(ws.close).toHaveBeenCalled()
    expect(capture.stop).toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
  })

  it('reports a server error close, ends the session and closes the mic', async () => {
    const { ws, events } = await started()
    ws.onclose!({ code: 1011 })
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' }))
    expect(events.at(-2)).toMatchObject({ type: 'error', kind: 'unavailable' })
    expect(capture.stop).toHaveBeenCalled()
  })

  it('treats a normal close the server sent without a message as an end the user sees', async () => {
    const { ws, events } = await started()
    ws.onclose!({ code: 1000 })
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('The server ended the cascade session (1000)'),
    })
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' }))
  })

  it('does not open a new server session on a speaker toggle after the server ended it (G19)', async () => {
    const { t, ws, events } = await started()
    ws.server({ type: 'ready', t: 0 })
    ws.server({
      type: 'error',
      stage: 'session',
      provider: 'workbench',
      kind: 'Unavailable',
      message: 'This session reached the 30-minute limit. Start a new session to continue.',
      t: 1,
    })
    ws.onclose!({ code: 1000 })
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' }))

    t.setSpeaker('B')

    expect(FakeSocket.all).toHaveLength(1)
    expect(capture.stop).toHaveBeenCalled()
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
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('(1008): Unsupported language direction'),
    })
  })
})
