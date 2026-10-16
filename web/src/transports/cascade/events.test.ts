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
      {
        type: 'transcript',
        role: 'source',
        utteranceId: 'c1-1',
        text: 'I have a headache.',
        final: true,
        confidence: 0.9,
      },
      { type: 'mark', name: 'endpoint', t: 1021, utteranceId: 'c1-1' },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo ', final: false },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo dolor.', final: false },
      { type: 'mark', name: 'tts.first_byte', t: 1040, utteranceId: 'c1-1' },
      { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Tengo dolor.', final: true },
    ])
    expect(p.speaking).toBe('c1-1')
  })

  it('keeps every source segment and spaces translation segments in a two-sentence utterance', () => {
    const p = parser()
    const msgs = [
      { type: 'transcript.final', u: 1, text: 'Take 2.5 milligrams of warfarin twice a day.', t: 1 },
      { type: 'translation.delta', u: 1, text: 'Tome 2,5 mg dos veces al día.', t: 2 },
      { type: 'translation.final', u: 1, text: 'Tome 2,5 mg dos veces al día.', t: 3 },
      { type: 'transcript.partial', u: 1, text: 'Can you', t: 4 },
      { type: 'transcript.final', u: 1, text: 'Can you summarize what I just said?', t: 5 },
      { type: 'translation.delta', u: 1, text: '¿Puedes resumir', t: 6 },
      { type: 'translation.delta', u: 1, text: ' lo que acabo de decir?', t: 7 },
      { type: 'utterance.done', u: 1, t: 8 },
    ]
    const out = msgs.flatMap((m) => p.parse(m)).filter((e) => e.type === 'transcript')
    const source = out.filter((e) => e.role === 'source').map((e) => e.text)
    expect(source).toEqual([
      'Take 2.5 milligrams of warfarin twice a day.',
      'Take 2.5 milligrams of warfarin twice a day. Can you',
      'Take 2.5 milligrams of warfarin twice a day. Can you summarize what I just said?',
    ])
    expect(out.at(-1)).toMatchObject({
      role: 'target',
      final: true,
      text: 'Tome 2,5 mg dos veces al día. ¿Puedes resumir lo que acabo de decir?',
    })
  })

  it('reports the lowest STT confidence across segments, and none when the provider gives none', () => {
    const p = parser()
    const a = p.parse({ type: 'transcript.final', u: 1, text: 'One.', confidence: 0.95, t: 1 })[0]
    const b = p.parse({ type: 'transcript.final', u: 1, text: 'Two.', confidence: 0.6, t: 2 })[0]
    const c = p.parse({ type: 'transcript.final', u: 2, text: 'Three.', t: 3 })[0]
    expect(a).toMatchObject({ confidence: 0.95 })
    expect(b).toMatchObject({ confidence: 0.6 })
    expect(c).not.toHaveProperty('confidence')
  })

  it('maps provider errors to error kinds, with TTS outages as tts_failed', () => {
    const p = parser()
    expect(p.parse({ type: 'error', u: 2, stage: 'translation', provider: 'x', kind: 'RateLimited', t: 1 })).toEqual([
      { type: 'error', kind: 'rate_limited', message: 'Cascade translation failed (x)', utteranceId: 'c1-2' },
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
    // A provider's own message (say, which key is missing on the server) beats the generic one.
    expect(
      p.parse({
        type: 'error',
        u: 1,
        stage: 'stt',
        provider: 'deepgram',
        kind: 'Auth',
        message: 'DEEPGRAM_API_KEY is not configured on the server',
        t: 1,
      })[0],
    ).toEqual({
      type: 'error',
      kind: 'auth',
      message: 'DEEPGRAM_API_KEY is not configured on the server',
      utteranceId: 'c1-1',
    })
  })

  it('maps per-utterance usage, leaving unreported token counts undefined', () => {
    const p = parser()
    expect(p.parse({ type: 'usage', u: 1, inputTokens: 120, outputTokens: 9, ttsCharacters: 30, t: 1 })).toEqual([
      { type: 'usage', utteranceId: 'c1-1', usage: { inputTokens: 120, outputTokens: 9, ttsCharacters: 30 } },
    ])
    expect(p.parse({ type: 'usage', u: 2, ttsCharacters: 4, t: 1 })[0]).toMatchObject({
      usage: { inputTokens: undefined, ttsCharacters: 4 },
    })
  })

  it('turns a retry into a notice and keeps Retry-After on errors', () => {
    const p = parser()
    expect(
      p.parse({
        type: 'retry',
        u: 3,
        stage: 'translation',
        provider: 'openai',
        kind: 'RateLimited',
        attempt: 1,
        delayMs: 250,
        t: 1,
      }),
    ).toEqual([
      {
        type: 'notice',
        message: 'openai rate limited the request; retrying translation in 250 ms (attempt 1)',
        utteranceId: 'c1-3',
      },
    ])
    expect(
      p.parse({
        type: 'error',
        u: 3,
        stage: 'translation',
        provider: 'openai',
        kind: 'RateLimited',
        retryAfterMs: 30000,
      })[0],
    ).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30000 })
  })

  it('ignores unknown messages and mark names', () => {
    const p = parser()
    expect(p.parse({ type: 'something.new' })).toEqual([])
    expect(p.parse({ type: 'latency.mark', u: 1, name: 'not.a.mark', t: 1 })).toEqual([])
  })
})
