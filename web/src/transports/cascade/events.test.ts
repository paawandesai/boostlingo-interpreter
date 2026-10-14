import { describe, expect, it } from 'vitest'
import { ClockSync } from './clock'
import { CascadeEventParser } from './events'

function parser() {
  const clock = new ClockSync()
  clock.onPong(0, -1000, 0) // server = client - 1000, zero rtt
  return new CascadeEventParser(clock, 'c1', () => 99999)
}

describe('CascadeEventParser', () => {
  it('maps a turn to transcript and mark events on the client clock', () => {
    const p = parser()
    const events = [
      { type: 'ready', t: 1 },
      { type: 'transcript.partial', u: 1, text: 'I have', t: 10 },
      { type: 'latency.mark', u: 1, name: 'stt.final', t: 20 },
      { type: 'transcript.final', u: 1, text: 'I have a headache.', confidence: 0.9, t: 20 },
      { type: 'latency.mark', u: 1, name: 'endpoint', t: 21 },
      { type: 'translation.delta', u: 1, text: 'Tengo ', t: 30 },
      { type: 'translation.delta', u: 1, text: 'dolor.', t: 31 },
      { type: 'translation.final', u: 1, text: 'Tengo dolor.', t: 32 },
      { type: 'latency.mark', u: 1, name: 'tts.first_byte', t: 40 },
      { type: 'utterance.done', u: 1, t: 50 },
    ].flatMap((e) => p.parse(e))

    expect(events).toEqual([
      { type: 'state', state: 'live' },
      { type: 'transcript', role: 'source', utteranceId: 'c1-1', text: 'I have', final: false },
      { type: 'mark', name: 'stt.final', t: 1020, utteranceId: 'c1-1' },
      { type: 'transcript', role: 'source', utteranceId: 'c1-1', text: 'I have a headache.', final: true },
      { type: 'mark', name: 'endpoint', t: 1021, utteranceId: 'c1-1' },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo ', final: false },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo dolor.', final: false },
      { type: 'mark', name: 'tts.first_byte', t: 1040, utteranceId: 'c1-1' },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo dolor.', final: true },
    ])
    expect(p.speaking).toBe('c1-1')
  })

  it('maps provider errors to error kinds, with TTS outages as tts_failed', () => {
    const p = parser()
    expect(p.parse({ type: 'error', u: 2, stage: 'translation', provider: 'x', kind: 'RateLimited', t: 1 })).toEqual([
      { type: 'error', kind: 'rate_limited', message: 'Cascade translation failed (x)' },
    ])
    expect(
      p.parse({ type: 'error', stage: 'tts', provider: 'elevenlabs', kind: 'Unavailable', t: 1 })[0],
    ).toMatchObject({
      kind: 'tts_failed',
    })
    expect(
      p.parse({ type: 'error', stage: 'session', kind: 'Auth', message: 'Missing or wrong access token.' })[0],
    ).toEqual({
      type: 'error',
      kind: 'auth',
      message: 'Missing or wrong access token.',
    })
  })

  it('ignores unknown messages and mark names', () => {
    const p = parser()
    expect(p.parse({ type: 'something.new' })).toEqual([])
    expect(p.parse({ type: 'latency.mark', u: 1, name: 'not.a.mark', t: 1 })).toEqual([])
  })
})
