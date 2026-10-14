/**
 * Latency breakdown per utterance (D9), pure so it can be unit-tested. All marks are client
 * performance.now() ms; server marks were already offset-corrected by the transport.
 *
 * Cascade stages run in pipeline order from client speech end to first audio scheduled, so they
 * add up to the total. A stage can be negative: with clause flushing, the first STT final of a
 * long turn can arrive before the speaker stops, which is the point of streaming.
 * Realtime exposes three observable points only; time inside the model is opaque.
 */
import type { MarkName, Mode } from '../transports/types'

export interface Stage {
  key: string
  label: string
  from: MarkName
  to: MarkName
  /** null when either mark is missing. */
  ms: number | null
  /** Stage start and end relative to client speech end, for the waterfall; null when unknown. */
  start: number | null
  end: number | null
  /** Shown for context but not part of the chain that sums to the total. */
  parallel?: boolean
  /** The stage hides vendor-internal time the client can't split further. */
  opaque?: boolean
}

export interface Breakdown {
  mode: Mode
  /** Speech end to first audio out; null until both marks exist. */
  totalMs: number | null
  stages: Stage[]
}

type StageDef = Omit<Stage, 'ms' | 'start' | 'end'>

const cascadeStages: StageDef[] = [
  { key: 'endpointing', label: 'Endpointing', from: 'speech.end', to: 'endpoint', parallel: true },
  { key: 'stt', label: 'STT final', from: 'speech.end', to: 'stt.final' },
  { key: 'ttft', label: 'Translation TTFT', from: 'stt.final', to: 'translation.first_token' },
  { key: 'flush', label: 'First flush', from: 'translation.first_token', to: 'tts.first_flush' },
  { key: 'ttfb', label: 'TTS TTFB', from: 'tts.first_flush', to: 'tts.first_byte' },
  { key: 'network', label: 'Network', from: 'tts.first_byte', to: 'audio.first_received' },
  { key: 'playback', label: 'Playback buffer', from: 'audio.first_received', to: 'audio.first_out' },
]

const realtimeStages: StageDef[] = [
  { key: 'endpointing', label: 'Endpointing', from: 'speech.end', to: 'endpoint' },
  { key: 'response', label: 'Response created', from: 'endpoint', to: 'response.created' },
  { key: 'model', label: 'Model + audio (opaque)', from: 'response.created', to: 'audio.first_out', opaque: true },
]

/**
 * gpt-realtime-translate speaks while the speaker is still talking (G17), so the headline (speech end
 * to first audio) is often negative. Start lag is the comparable number: how far behind the speaker
 * the interpretation starts. There are no server marks in between.
 */
const translateStages: StageDef[] = [
  {
    key: 'start_lag',
    label: 'Start lag (speech start → first audio)',
    from: 'speech.start',
    to: 'audio.first_out',
    opaque: true,
  },
]

const stagesFor: Record<Mode, StageDef[]> = {
  cascade: cascadeStages,
  realtime: realtimeStages,
  translate: translateStages,
}

export function computeLatency(mode: Mode, marks: Partial<Record<MarkName, number>>): Breakdown {
  const defs = stagesFor[mode]
  const start = marks['speech.end']
  const end = marks['audio.first_out']
  const rel = (t: number | undefined) => (t === undefined || start === undefined ? null : t - start)
  const stages = defs.map((d) => {
    const a = marks[d.from]
    const b = marks[d.to]
    return { ...d, ms: a === undefined || b === undefined ? null : b - a, start: rel(a), end: rel(b) }
  })
  return { mode, totalMs: start === undefined || end === undefined ? null : end - start, stages }
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export interface StageSummary {
  key: string
  label: string
  n: number
  p50: number | null
  p95: number | null
}

/** Running p50/p95 of the total and each stage, over the utterances of one mode. */
export function summarize(breakdowns: Breakdown[]): StageSummary[] {
  if (breakdowns.length === 0) return []
  const rows: StageSummary[] = []
  const totals = breakdowns.flatMap((b) => (b.totalMs === null ? [] : [b.totalMs]))
  rows.push({
    key: 'total',
    label: 'Total',
    n: totals.length,
    p50: percentile(totals, 50),
    p95: percentile(totals, 95),
  })
  for (const s of breakdowns[0].stages) {
    const values = breakdowns.flatMap((b) => {
      const ms = b.stages.find((x) => x.key === s.key)?.ms
      return ms === null || ms === undefined ? [] : [ms]
    })
    rows.push({
      key: s.key,
      label: s.label,
      n: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
    })
  }
  return rows
}
