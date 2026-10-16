import { describe, expect, it } from 'vitest'
import { computeCost, type PriceList } from './cost'

const prices: PriceList = {
  currency: 'USD',
  entries: [
    { key: 'stt:openai', model: 'x', perMinute: 0.006, source: 'https://example.test/stt', checkedOn: '2026-10-14' },
    {
      key: 'translator:anthropic',
      model: 'h',
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      source: 's',
      checkedOn: '2026-10-14',
    },
    { key: 'tts:elevenlabs', model: 'f', perThousandCharacters: null, source: 's', checkedOn: null },
    {
      key: 'realtime:openai',
      model: 'm',
      audioInputPerMTok: 32,
      audioOutputPerMTok: 64,
      textInputPerMTok: 4,
      cachedInputPerMTok: 0.4,
      source: 's',
      checkedOn: 'd',
    },
  ],
}

describe('computeCost', () => {
  it('prices cascade usage and shows the arithmetic per line', () => {
    const r = computeCost(
      {
        mode: 'cascade',
        minutes: 2,
        usage: [
          { inputTokens: 600_000, outputTokens: 200_000 },
          { inputTokens: 400_000, outputTokens: 0 },
        ],
        sttAudioSeconds: 120,
        providers: { stt: 'openai', translator: 'anthropic' },
      },
      prices,
    )
    expect(r.lines.map((l) => [l.component, l.quantity, l.unitPrice, l.cost])).toEqual([
      ['STT (openai)', 2, 0.006, 0.012],
      ['Translation input (anthropic)', 1, 0.1, 0.1],
      ['Translation output (anthropic)', 0.2, 0.5, 0.1],
    ])
    expect(r.pricedTotal).toBeCloseTo(0.212)
    expect(r.perMinute).toBeCloseTo(0.106)
    expect(r.unpriced).toEqual([])
  })

  it('reports an unchecked price as unpriced and gives no per-minute figure', () => {
    const r = computeCost(
      {
        mode: 'cascade',
        minutes: 1,
        usage: [{ ttsCharacters: 2000 }],
        sttAudioSeconds: 0,
        providers: { tts: 'elevenlabs' },
      },
      prices,
    )
    expect(r.lines[0]).toMatchObject({ component: 'TTS (elevenlabs)', quantity: 2, cost: null })
    expect(r.unpriced).toEqual(['TTS (elevenlabs)'])
    expect(r.perMinute).toBeNull()
  })

  it('prices Realtime audio tokens for the session model only', () => {
    const r = computeCost(
      {
        mode: 'realtime',
        minutes: 1,
        usage: [{ inputAudioTokens: 1000, outputAudioTokens: 2000 }],
        sttAudioSeconds: 0,
        providers: { realtimeModel: 'm' },
      },
      prices,
    )
    expect(r.pricedTotal).toBeCloseTo(0.032 + 0.128)
    const other = computeCost(
      { ...r, usage: [{ inputAudioTokens: 1000 }], sttAudioSeconds: 0, providers: { realtimeModel: 'other' } },
      prices,
    )
    expect(other.unpriced).toEqual(['Realtime audio input (other)'])
  })

  it('prices cached Realtime input at the cached rate, taken off text input first and audio second', () => {
    const r = computeCost(
      {
        mode: 'realtime',
        minutes: 1,
        usage: [
          { inputAudioTokens: 1000, inputTextTokens: 300, cachedTokens: 0 },
          { inputAudioTokens: 1000, inputTextTokens: 300, cachedTokens: 800 },
        ],
        sttAudioSeconds: 0,
        providers: { realtimeModel: 'm' },
      },
      prices,
    )
    // 800 cached of 600 text + 2000 audio input tokens: all the text and 200 audio tokens were cached.
    expect(r.lines.map((l) => [l.component, l.quantity, l.unitPrice])).toEqual([
      ['Realtime audio input (m)', 0.0018, 32],
      ['Realtime text input (m)', 0, 4],
      ['Realtime cached input (m)', 0.0008, 0.4],
    ])
    expect(r.lines[0].cost).toBeCloseTo(0.0576, 8)
    expect(r.lines[2].cost).toBeCloseTo(0.00032, 8)
    expect(r.pricedTotal).toBeCloseTo(0.05792, 8)
    expect(r.unpriced).toEqual([])
  })

  it('adds no cached line when usage reports no cached tokens', () => {
    const r = computeCost(
      {
        mode: 'realtime',
        minutes: 1,
        usage: [{ inputAudioTokens: 1000 }],
        sttAudioSeconds: 0,
        providers: { realtimeModel: 'm' },
      },
      prices,
    )
    expect(r.lines.map((l) => l.component)).toEqual(['Realtime audio input (m)'])
    expect(r.pricedTotal).toBeCloseTo(0.032)
  })

  it('bills Realtime translate per session minute and leaves it unpriced until checked', () => {
    const r = computeCost({ mode: 'translate', minutes: 2, usage: [], sttAudioSeconds: 0, providers: {} }, prices)
    expect(r.lines).toEqual([
      expect.objectContaining({ component: 'Realtime translate (session time)', quantity: 2, cost: null }),
    ])
    expect(r.perMinute).toBeNull()
  })
})
