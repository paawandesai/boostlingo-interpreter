import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../types'

const capture = {
  stream: { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream,
  context: {} as AudioContext,
  setGated: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../audio/capture', () => ({
  MicDeniedError: class MicDeniedError extends Error {},
  startCapture: vi.fn(async () => capture),
}))

class FakeDataChannel {
  readyState = 'connecting'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  close = vi.fn()
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
  remote: unknown = null
  localDescription: { sdp: string } | null = null
  ontrack: unknown = null
  onconnectionstatechange: (() => void) | null = null
  close = vi.fn()
  constructor() {
    FakePeer.last = this
  }
  addTrack(t: unknown) {
    this.tracks.push(t)
  }
  createDataChannel() {
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
  clientSecret: 'ek_tr',
  expiresAt: '',
  model: 'gpt-realtime-translate',
  callsUrl: 'https://api.openai.com/v1/realtime/translations/calls',
  target: 'es',
  maxSessionSeconds: 1800,
}

describe('TranslateTransport', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response('v=0 answer', { status: 201 }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function started() {
    const { TranslateTransport } = await import('./TranslateTransport')
    const t = new TranslateTransport()
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.start({ langA: 'en', langB: 'es', speaker: 'A' })
    return { t, events, pc: FakePeer.last }
  }

  it('asks our backend for a session with only the target language, then exchanges SDP', async () => {
    const { pc } = await started()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/realtime/translation-session')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ target: 'es' })
    expect(fetchMock.mock.calls[1][0]).toBe(session.callsUrl)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer ek_tr')
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' })
  })

  it('turns the transcript streams into lines and never gates the mic', async () => {
    vi.useFakeTimers()
    const { pc, events } = await started()
    pc.dc.open()
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }) })
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Hola' }) })
    vi.advanceTimersByTime(5000)
    const lines = events.flatMap((e) => (e.type === 'transcript' && e.final ? [[e.role, e.text]] : []))
    expect(lines).toEqual([
      ['source', 'Hello'],
      ['target', 'Hola'],
    ])
    expect(capture.setGated).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'gated')).toBe(false)
  })

  it('changes only the output language on a speaker flip', async () => {
    const { t, pc } = await started()
    pc.dc.open()
    t.setSpeaker('B')
    expect(JSON.parse(pc.dc.sent[0])).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'en' } } },
    })
  })

  it('ends the session at the duration limit and says why', async () => {
    vi.useFakeTimers()
    const { pc, events } = await started()
    pc.dc.open()
    await vi.advanceTimersByTimeAsync(1800 * 1000)
    expect(pc.close).toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      kind: 'unavailable',
      message: expect.stringContaining('30-minute'),
    })
  })

  it('stop() finishes open lines and releases everything', async () => {
    const { t, pc, events } = await started()
    pc.dc.open()
    pc.dc.onmessage?.({ data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Half a sen' }) })
    await t.stop()
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcript', role: 'source', final: true }))
    expect(pc.close).toHaveBeenCalled()
    expect(capture.stop).toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' })
  })
})
