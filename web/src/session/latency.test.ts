import { describe, expect, it } from 'vitest'
import { computeLatency, percentile, summarize } from './latency'

describe('computeLatency', () => {
  it('splits a cascade turn into stages that add up to the total', () => {
    const b = computeLatency('cascade', {
      'speech.end': 1000,
      endpoint: 1300,
      'stt.final': 1250,
      'translation.first_token': 1500,
      'tts.first_flush': 1700,
      'tts.first_byte': 1950,
      'audio.first_received': 1980,
      'audio.first_out': 2100,
    })
    expect(b.totalMs).toBe(1100)
    const ms = Object.fromEntries(b.stages.map((s) => [s.key, s.ms]))
    expect(ms).toEqual({ endpointing: 300, stt: 250, ttft: 250, flush: 200, ttfb: 250, network: 30, playback: 120 })
    const chain = b.stages.filter((s) => !s.parallel).reduce((sum, s) => sum + (s.ms ?? 0), 0)
    expect(chain).toBe(b.totalMs)
  })

  it('allows a negative STT stage when the first final lands before the speaker stops', () => {
    const b = computeLatency('cascade', { 'speech.end': 5000, 'stt.final': 3200, 'audio.first_out': 4800 })
    expect(b.stages.find((s) => s.key === 'stt')?.ms).toBe(-1800)
    expect(b.totalMs).toBe(-200)
  })

  it('reports missing marks as null, not zero', () => {
    const b = computeLatency('cascade', { 'speech.end': 1000, 'stt.final': 1200 })
    expect(b.totalMs).toBeNull()
    expect(b.stages.find((s) => s.key === 'stt')?.ms).toBe(200)
    expect(b.stages.find((s) => s.key === 'ttft')?.ms).toBeNull()
  })

  it('gives Realtime three observable stages, the last one opaque', () => {
    const b = computeLatency('realtime', {
      'speech.end': 1000,
      endpoint: 1500,
      'response.created': 1550,
      'audio.first_out': 2200,
    })
    expect(b.totalMs).toBe(1200)
    expect(b.stages.map((s) => [s.key, s.ms, Boolean(s.opaque)])).toEqual([
      ['endpointing', 500, false],
      ['response', 50, false],
      ['model', 650, true],
    ])
  })

  it('measures Realtime translate from speech start, and lets the total go negative while it speaks along', () => {
    const b = computeLatency('translate', { 'speech.start': 1000, 'audio.first_out': 2400, 'speech.end': 4000 })
    expect(b.stages.map((s) => [s.key, s.ms])).toEqual([['start_lag', 1400]])
    expect(b.totalMs).toBe(-1600)
  })

  it('uses offset-corrected server marks as given (the transport converts them)', () => {
    // Server clock is 1000 ms behind; the transport already added the offset to the marks.
    const b = computeLatency('cascade', { 'speech.end': 2000, 'stt.final': 2400, 'audio.first_out': 3000 })
    expect(b.stages.find((s) => s.key === 'stt')?.ms).toBe(400)
  })
})

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(percentile(v, 50)).toBe(500)
    expect(percentile(v, 95)).toBe(1000)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('summarize', () => {
  it('computes p50/p95 of the total and each stage, skipping missing values', () => {
    const rows = summarize([
      computeLatency('realtime', { 'speech.end': 0, endpoint: 400, 'response.created': 450, 'audio.first_out': 1000 }),
      computeLatency('realtime', { 'speech.end': 0, endpoint: 600, 'response.created': 700, 'audio.first_out': 1400 }),
      computeLatency('realtime', { 'speech.end': 0, endpoint: 500 }),
    ])
    expect(rows[0]).toEqual({ key: 'total', label: 'Total', n: 2, p50: 1000, p95: 1400 })
    expect(rows.find((r) => r.key === 'endpointing')).toMatchObject({ n: 3, p50: 500, p95: 600 })
  })
})
