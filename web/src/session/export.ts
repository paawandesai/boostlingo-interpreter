/**
 * Session log export (T3.5): everything the write-up needs from one run, as JSON the eval
 * scripts can read. Built by a pure function; download() is the only browser-specific part.
 * Transcripts are included because the replay set is synthetic; never export a real conversation.
 */
import type { Mode } from '../transports/types'
import { computeCost, type CostReport, type PriceList } from './cost'
import { computeLatency, summarize, type Breakdown, type StageSummary } from './latency'
import type { CascadeProviders } from './providers'
import type { SessionState, Utterance } from './store'

export const EXPORT_SCHEMA = 'workbench.session-log/1'

export interface ExportContext {
  exportedAt: string
  appVersion: string | null
  cascadeProviders: CascadeProviders | null
  defaultRealtimeModel: string | null
  prices: PriceList | null
  userAgent: string
}

export interface SessionLog {
  schema: string
  exportedAt: string
  appVersion: string | null
  userAgent: string
  languages: { a: string; b: string }
  glossary: boolean
  providers: { cascade: CascadeProviders | null; realtimeModel: string | null }
  modes: Array<{
    mode: Mode
    minutes: number
    utterances: number
    latency: StageSummary[]
    cost: CostReport | null
  }>
  utterances: Array<{
    id: string
    mode: Mode
    side: string
    source: Utterance['source']
    target: Utterance['target']
    audioFailed: boolean
    marks: Utterance['marks']
    breakdown: Breakdown
    usage: Utterance['usage'] | null
  }>
  markers: string[]
  notes: string[]
}

function minutesIn(state: SessionState, mode: Mode, now: number): number {
  return state.segments
    .filter((s) => s.mode === mode)
    .reduce((sum, s) => sum + ((s.endedAt ?? now) - s.startedAt) / 60000, 0)
}

export function buildSessionLog(state: SessionState, ctx: ExportContext, now = Date.parse(ctx.exportedAt)): SessionLog {
  const utterances = state.timeline.filter((x): x is Utterance => x.kind === 'utterance')
  const realtimeModel = state.realtimeModel ?? ctx.defaultRealtimeModel
  const modes = (['realtime', 'cascade'] as const).filter(
    (m) => utterances.some((u) => u.mode === m) || state.segments.some((s) => s.mode === m),
  )
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: ctx.exportedAt,
    appVersion: ctx.appVersion,
    userAgent: ctx.userAgent,
    languages: { a: state.langA, b: state.langB },
    glossary: state.glossary,
    providers: { cascade: ctx.cascadeProviders, realtimeModel },
    modes: modes.map((mode) => {
      const mine = utterances.filter((u) => u.mode === mode)
      const minutes = minutesIn(state, mode, now)
      return {
        mode,
        minutes,
        utterances: mine.length,
        latency: summarize(mine.map((u) => computeLatency(mode, u.marks))),
        cost: ctx.prices
          ? computeCost(
              {
                mode,
                minutes,
                usage: mine.flatMap((u) => (u.usage ? [u.usage] : [])),
                sttAudioSeconds: mode === 'cascade' ? state.sessionUsage.sttAudioSeconds : 0,
                providers: { ...(ctx.cascadeProviders ?? {}), realtimeModel: realtimeModel ?? undefined },
              },
              ctx.prices,
            )
          : null,
      }
    }),
    utterances: utterances.map((u) => ({
      id: u.id,
      mode: u.mode,
      side: u.side,
      source: u.source,
      target: u.target,
      audioFailed: u.audioFailed ?? false,
      marks: u.marks,
      breakdown: computeLatency(u.mode, u.marks),
      usage: u.usage ?? null,
    })),
    markers: state.timeline.flatMap((x) => (x.kind === 'marker' ? [x.text] : [])),
    notes: [
      'Marks are performance.now() ms on the client clock; cascade server marks were offset-corrected with ping/pong.',
      'Realtime source text comes from a separate transcription model; do not compute WER on it as if it were what gpt-realtime heard.',
      'Realtime input-transcription usage is billed separately and is not captured here.',
      'Cascade STT usage is audio seconds streamed by this browser, which includes silence between turns.',
      'A cost line with unitPrice null has no checked price in config/prices.json; the total excludes it.',
    ],
  }
}

/** Triggers a download of the log; the object URL is revoked right after. */
export function download(log: SessionLog): void {
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = `session-${log.exportedAt.replace(/[:.]/g, '-')}.json`
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
