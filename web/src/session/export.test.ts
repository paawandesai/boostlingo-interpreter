import { describe, expect, it } from 'vitest'
import { browserSummary, buildSessionLog, EXPORT_SCHEMA } from './export'
import { initialState, sessionReducer, type SessionState } from './store'

function sessionWithOneCascadeTurn(): SessionState {
  let s = sessionReducer(
    { ...initialState, mode: 'cascade' },
    { type: 'started', at: Date.parse('2026-10-14T20:00:00Z') },
  )
  const events = [
    { type: 'mark', name: 'speech.end', t: 1000 },
    { type: 'mark', name: 'endpoint', t: 1300, utteranceId: 'c1-1' },
    { type: 'transcript', role: 'source', utteranceId: 'c1-1', text: 'Hello.', final: true, confidence: 0.92 },
    { type: 'transcript', role: 'target', utteranceId: 'c1-1', text: 'Hola.', final: true },
    { type: 'mark', name: 'audio.first_out', t: 2500, utteranceId: 'c1-1' },
    { type: 'usage', utteranceId: 'c1-1', usage: { inputTokens: 100, outputTokens: 5, ttsCharacters: 5 } },
    { type: 'usage', usage: { sttAudioSeconds: 60 } },
  ] as const
  for (const event of events) s = sessionReducer(s, { type: 'transport', event })
  return sessionReducer(s, { type: 'segmentEnded', at: Date.parse('2026-10-14T20:02:00Z') })
}

describe('buildSessionLog', () => {
  it('collects transcripts, marks, latency, usage and cost per mode', () => {
    const log = buildSessionLog(sessionWithOneCascadeTurn(), {
      exportedAt: '2026-10-14T20:03:00Z',
      appVersion: '1.0.0',
      cascadeProviders: { stt: 'openai', translator: 'anthropic', tts: 'elevenlabs' },
      defaultRealtimeModel: 'gpt-realtime-2.1',
      prices: {
        currency: 'USD',
        entries: [
          { key: 'stt:openai', model: 'x', perMinute: 0.01, source: 's', checkedOn: 'd' },
          {
            key: 'translator:anthropic',
            model: 'h',
            inputPerMTok: 0.1,
            outputPerMTok: 0.5,
            source: 's',
            checkedOn: 'd',
          },
        ],
      },
      userAgent: 'test',
    })

    expect(log.schema).toBe(EXPORT_SCHEMA)
    expect(log.modes).toHaveLength(1)
    const cascade = log.modes[0]
    expect(cascade).toMatchObject({ mode: 'cascade', minutes: 2, utterances: 1 })
    expect(cascade.latency[0]).toMatchObject({ key: 'total', p50: 1500 })
    expect(cascade.cost?.unpriced).toEqual(['TTS (elevenlabs)'])
    expect(cascade.cost?.perMinute).toBeNull()
    expect(log.utterances[0]).toMatchObject({
      source: { text: 'Hello.', confidence: 0.92 },
      target: { text: 'Hola.' },
      usage: { inputTokens: 100, ttsCharacters: 5 },
      breakdown: { totalMs: 1500 },
    })
  })

  it('exports without prices and says no cost was computed', () => {
    const log = buildSessionLog(sessionWithOneCascadeTurn(), {
      exportedAt: '2026-10-14T20:03:00Z',
      appVersion: null,
      cascadeProviders: null,
      defaultRealtimeModel: null,
      prices: null,
      userAgent: 'test',
    })
    expect(log.modes[0].cost).toBeNull()
  })
})

describe('browserSummary', () => {
  it('keeps the browser name and version, not the whole user-agent string', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7390.37 Safari/537.36'
    expect(browserSummary(chrome)).toBe('Chrome/142.0')
    expect(browserSummary(`${chrome} Edg/142.0.3595.53`)).toBe('Edge/142.0')
    expect(
      browserSummary(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      ),
    ).toBe('Safari/17.4')
    expect(browserSummary('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe(
      'Firefox/128.0',
    )
    expect(browserSummary('curl/8.4.0')).toBe('unknown')
  })
})
