import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../types'

const capture = {
  stream: { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream,
  context: {} as AudioContext,
  setGated: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
}
const captureOpts: { onVad?: (kind: 'speech.start' | 'speech.end', t: number) => void } = {}
vi.mock('../../audio/capture', () => ({
  MicDeniedError: class MicDeniedError extends Error {},
  startCapture: vi.fn(async (opts: typeof captureOpts) => {
    captureOpts.onVad = opts.onVad
    return capture
  }),
}))
vi.mock('./firstAudioProbe', () => ({ createFirstAudioProbe: () => ({ arm: vi.fn(), stop: vi.fn() }) }))

class FakeDataChannel {
  readyState = 'connecting'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  close = vi.fn(() => {
    this.readyState = 'closed'
  })
  send(s: string) {
    this.sent.push(s)
  }
  open() {
    this.readyState = 'open'
    this.onopen?.()
  }
}

class FakePeer {
  static last: FakePeer
  dc = new FakeDataChannel()
  tracks: unknown[] = []
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  remote: unknown = null
  ontrack: unknown = null
  onconnectionstatechange: (() => void) | null = null
  close = vi.fn()
  constructor() {
    FakePeer.last = this
  }
  addTrack(t: unknown) {
    this.tracks.push(t)
  }
  createDataChannel(name: string) {
    expect(name).toBe('oai-events')
    return this.dc
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' }
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d
  }
  async setRemoteDescription(d: unknown) {
    this.remote = d
  }
}

const session = {
  clientSecret: 'ek_test',
  expiresAt: '',
  model: 'gpt-realtime',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  callsUrl: 'https://api.openai.com/v1/realtime/calls',
  instructions: { 'en>es': 'EN to ES', 'es>en': 'ES to EN' },
}

describe('RealtimeTransport', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response('v=0 answer', { status: 201 }))
    capture.stop.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function started(info: object = session) {
    if (info !== session) {
      fetchMock.mockReset()
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(info)))
        .mockResolvedValueOnce(new Response('v=0 answer', { status: 201 }))
    }
    const { RealtimeTransport } = await import('./RealtimeTransport')
    const t = new RealtimeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })
    return { t, events, pc: FakePeer.last }
  }

  it('gets the secret from our backend and exchanges SDP with it', async () => {
    const { pc } = await started()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/realtime/session')
    expect(fetchMock.mock.calls[1][0]).toBe(session.callsUrl)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer ek_test')
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' })
    expect(pc.tracks).toHaveLength(1)
  })

  it('mints the session while the spoken notice plays and opens the mic only after it (G7)', async () => {
    const { startCapture } = await import('../../audio/capture')
    vi.mocked(startCapture).mockClear()
    let finishNotice!: () => void
    const notice = new Promise<void>((r) => (finishNotice = r))
    const { RealtimeTransport } = await import('./RealtimeTransport')
    const t = new RealtimeTransport()
    const starting = t.start({ langA: 'en', langB: 'es', speaker: 'A', beforeCapture: notice })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/realtime/session')
    expect(startCapture).not.toHaveBeenCalled()
    finishNotice()
    await starting
    expect(startCapture).toHaveBeenCalledTimes(1)
  })

  it('re-mints a secret that expired before the SDP exchange instead of failing', async () => {
    const expired = { ...session, clientSecret: 'ek_old', expiresAt: '2000-01-01T00:00:00Z' }
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(expired)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, clientSecret: 'ek_new' })))
      .mockResolvedValueOnce(new Response('v=0 answer', { status: 201 }))
    const { RealtimeTransport } = await import('./RealtimeTransport')
    const t = new RealtimeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))

    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/realtime/session',
      '/api/realtime/session',
      session.callsUrl,
    ])
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer ek_new')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(FakePeer.last.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' })
  })

  it('reports live when the data channel opens and forwards parsed events', async () => {
    const { pc, events } = await started()
    pc.dc.open()
    pc.dc.onmessage?.({
      data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1 }),
    })
    expect(events).toContainEqual({ type: 'state', state: 'live' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'mark', name: 'endpoint', utteranceId: 'u1' }))
  })

  it('gates the mic while OpenAI plays audio', async () => {
    vi.useFakeTimers()
    const { pc } = await started()
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'output_audio_buffer.started', response_id: 'r' }) })
    expect(capture.setGated).toHaveBeenLastCalledWith(true)
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'r' }) })
    vi.advanceTimersByTime(200)
    expect(capture.setGated).toHaveBeenLastCalledWith(false)
    vi.useRealTimers()
  })

  it('switches direction with session.update on a speaker flip', async () => {
    const { t, pc } = await started()
    pc.dc.open()
    t.setSpeaker('B')
    const update = JSON.parse(pc.dc.sent[0])
    expect(update.type).toBe('session.update')
    expect(update.session.instructions).toBe('ES to EN')
    expect(update.session.audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe', language: 'es' })
  })

  it('defers a speaker flip made during a turn in flight until its response is done', async () => {
    const { t, pc } = await started()
    pc.dc.open()
    pc.dc.onmessage?.({
      data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1 }),
    })

    t.setSpeaker('B')

    // The turn that just ended is interpreted in its own direction, not the new one.
    expect(pc.dc.sent).toEqual([])
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }) })
    expect(pc.dc.sent).toEqual([])
    pc.dc.onmessage?.({
      data: JSON.stringify({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }),
    })
    const sent = pc.dc.sent.map((m) => JSON.parse(m))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'session.update', session: { instructions: 'ES to EN' } })
    // Nothing in flight now: the next flip goes out at once.
    t.setSpeaker('A')
    expect(pc.dc.sent).toHaveLength(2)
    expect(JSON.parse(pc.dc.sent[1]).session.instructions).toBe('EN to ES')
  })

  it('keeps the side of a turn that finishes after a speaker flip', async () => {
    const { t, pc, events } = await started()
    pc.dc.open()
    const server = (e: object) => pc.dc.onmessage?.({ data: JSON.stringify(e) })
    server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1 })

    t.setSpeaker('B')
    server({ type: 'response.created', response: { id: 'resp_1' } })
    server({ type: 'response.output_audio_transcript.done', response_id: 'resp_1', transcript: 'Hola.' })
    server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Hello.' })
    server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
    // The flip's update is sent now; the next turn is B's.
    server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2', audio_end_ms: 2 })
    server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Hola.' })

    const sides = events.flatMap((e) => (e.type === 'transcript' ? [[e.utteranceId, e.role, e.side]] : []))
    expect(sides).toEqual([
      ['u1', 'target', 'A'],
      ['u1', 'source', 'A'],
      ['u2', 'source', 'B'],
    ])
  })

  it('queues a turn that ended during an active response instead of dropping it', async () => {
    const { t, pc, events } = await started()
    pc.dc.open()
    const busy = {
      code: 'conversation_already_has_active_response',
      message: 'Conversation already has an active response in progress: resp_1.',
    }
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'error', error: busy }) })
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(pc.dc.sent).toEqual([])
    pc.dc.onmessage?.({
      data: JSON.stringify({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }),
    })
    expect(pc.dc.sent.map((m) => JSON.parse(m))).toEqual([{ type: 'response.create' }])
    // The queued turn was spoken before this flip, so the flip waits for its response too.
    t.setSpeaker('B')
    expect(pc.dc.sent).toHaveLength(1)
    pc.dc.onmessage?.({
      data: JSON.stringify({ type: 'response.done', response: { id: 'resp_2', status: 'completed' } }),
    })
    expect(pc.dc.sent.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
      'response.create',
      'session.update',
    ])
  })

  it('with client endpointing, commits the turn and asks for a response after speech ends', async () => {
    const { pc } = await started({ ...session, endpointing: 'client' })
    pc.dc.open()
    vi.useFakeTimers()
    try {
      captureOpts.onVad?.('speech.start', 0)
      captureOpts.onVad?.('speech.end', 1000)
      expect(pc.dc.sent).toEqual([])
      vi.advanceTimersByTime(1000)
      expect(pc.dc.sent.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
        'input_audio_buffer.commit',
        'response.create',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('with client endpointing, holds a turn that ends during a response until that response is done', async () => {
    const { pc } = await started({ ...session, endpointing: 'client' })
    pc.dc.open()
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }) })
    vi.useFakeTimers()
    try {
      captureOpts.onVad?.('speech.start', 0)
      captureOpts.onVad?.('speech.end', 1000)
      vi.advanceTimersByTime(1000)
      expect(pc.dc.sent).toEqual([])
      pc.dc.onmessage?.({ data: JSON.stringify({ type: 'response.done', response: { id: 'resp_1' } }) })
      expect(pc.dc.sent.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
        'input_audio_buffer.commit',
        'response.create',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('with server endpointing, the client VAD sends nothing', async () => {
    const { pc } = await started()
    pc.dc.open()
    vi.useFakeTimers()
    try {
      captureOpts.onVad?.('speech.start', 0)
      captureOpts.onVad?.('speech.end', 1000)
      vi.advanceTimersByTime(1000)
      expect(pc.dc.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() closes the data channel, peer and capture', async () => {
    const { t, pc, events } = await started()
    await t.stop()
    expect(pc.dc.close).toHaveBeenCalled()
    expect(pc.close).toHaveBeenCalled()
    expect(capture.stop).toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
    await t.stop() // idempotent
  })

  it('reports a denied microphone, opens no peer connection and can still be stopped', async () => {
    const { MicDeniedError, startCapture } = await import('../../audio/capture')
    vi.mocked(startCapture).mockRejectedValueOnce(new MicDeniedError('Microphone access was denied'))
    const peerBefore = FakePeer.last
    const { RealtimeTransport } = await import('./RealtimeTransport')
    const t = new RealtimeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))

    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })

    expect(events.at(-1)).toEqual({ type: 'error', kind: 'mic_denied', message: 'Microphone access was denied' })
    expect(FakePeer.last).toBe(peerBefore)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the secret was minted, no SDP exchange followed
    await t.stop()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
  })

  it('ends the session at the duration limit: mic closed, closed reported (G19)', async () => {
    vi.useFakeTimers()
    try {
      const { pc, events } = await started({ ...session, maxSessionSeconds: 60 })
      pc.dc.open()
      await vi.advanceTimersByTimeAsync(60 * 1000)

      expect(pc.close).toHaveBeenCalled()
      expect(capture.stop).toHaveBeenCalled()
      expect(events.at(-2)).toMatchObject({ type: 'error', message: expect.stringContaining('1-minute limit') })
      expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed or disconnected peer connection as webrtc_dropped', async () => {
    const { pc, events } = await started()
    pc.dc.open()

    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(events.at(-1)).toEqual({ type: 'error', kind: 'webrtc_dropped', message: 'WebRTC connection failed' })
    pc.connectionState = 'disconnected'
    pc.onconnectionstatechange?.()
    expect(events.at(-1)).toEqual({ type: 'error', kind: 'webrtc_dropped', message: 'WebRTC connection disconnected' })
  })

  it('surfaces a backend rate limit as a typed error and releases resources', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'RateLimited', detail: 'slow', retryAfterMs: 1500 }), { status: 429 }),
    )
    const { RealtimeTransport } = await import('./RealtimeTransport')
    const t = new RealtimeTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })
    expect(events.at(-1)).toEqual({ type: 'error', kind: 'rate_limited', message: 'slow', retryAfterMs: 1500 })
  })
})
