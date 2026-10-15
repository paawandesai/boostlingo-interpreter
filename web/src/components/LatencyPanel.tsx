import { defaultVadOptions } from '../audio/vad'
import { computeLatency, summarize, type Breakdown } from '../session/latency'
import type { Utterance } from '../session/store'
import type { Mode } from '../transports/types'

/** Brief benchmarks: speech end to first audio out. */
const budgetMs: Record<Mode, number> = { realtime: 1500, cascade: 3000 }

/** A turn the STT split without a client VAD pause has no speech end of its own to measure from. */
function totalLabel(u: Utterance, b: Breakdown): string {
  if (b.totalMs !== null) return `${Math.round(b.totalMs)} ms`
  if (u.marks['speech.end'] === undefined && u.marks['audio.first_out'] !== undefined) {
    return 'no speech end (no client VAD pause before this segment)'
  }
  return 'pending'
}

const fmt = (ms: number | null) => (ms === null ? '–' : `${Math.round(ms)}`)

function Waterfall({ b, domain }: { b: Breakdown; domain: [number, number] }) {
  const [lo, hi] = domain
  const pct = (ms: number) => `${((ms - lo) / (hi - lo)) * 100}%`
  return (
    <div className="waterfall" aria-hidden="true">
      <span className="budget" style={{ left: pct(budgetMs[b.mode]) }} />
      <span className="zero" style={{ left: pct(0) }} />
      {b.stages.map((s, i) =>
        s.start === null || s.end === null ? null : (
          <span
            key={s.key}
            className={`bar stage-${i}${s.parallel ? ' parallel' : ''}${s.opaque ? ' opaque' : ''}`}
            title={`${s.label}: ${fmt(s.ms)} ms`}
            style={{ left: pct(Math.min(s.start, s.end)), width: pct(lo + Math.abs(s.end - s.start)) }}
          />
        ),
      )}
    </div>
  )
}

function SummaryTable({ mode, rows }: { mode: Mode; rows: ReturnType<typeof summarize> }) {
  if (rows.length === 0) return null
  return (
    <table className="summary">
      <caption>
        {mode === 'realtime' ? 'Realtime' : 'Cascade'} · n = {rows[0].n} · ms
      </caption>
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">p50</th>
          <th scope="col">p95</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td>{fmt(r.p50)}</td>
            <td>{fmt(r.p95)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const WATERFALL_ROWS = 20

/** Per-utterance waterfall plus running p50/p95 per mode (T3.2, D9). */
export function LatencyPanel({ utterances }: { utterances: Utterance[] }) {
  const rows = utterances.map((u, i) => ({ u, n: i + 1, b: computeLatency(u.mode, u.marks) }))
  // The summaries use every utterance; the waterfall draws only the latest ones so a long session's
  // page stays the same size (T3.6 soak).
  const shown = rows.slice(-WATERFALL_ROWS)
  const offsets = shown.flatMap(({ b }) => b.stages.flatMap((s) => [s.start ?? 0, s.end ?? 0]))
  const modes = [...new Set(rows.map((r) => r.b.mode))]
  const domain: [number, number] = [
    Math.min(0, ...offsets),
    Math.max(...modes.map((m) => budgetMs[m]), ...offsets, 1000) * 1.05,
  ]
  const legend = rows.at(-1)?.b.stages ?? []
  return (
    <section aria-labelledby="lat-h" className="panel">
      <h2 id="lat-h">Latency: speech end → first audio out</h2>
      <div className="summaries">
        {modes.map((m) => (
          <SummaryTable key={m} mode={m} rows={summarize(rows.filter((r) => r.b.mode === m).map((r) => r.b))} />
        ))}
      </div>
      {legend.length > 0 && (
        <ul className="legend">
          {legend.map((s, i) => (
            <li key={s.key}>
              <span className={`swatch stage-${i}${s.opaque ? ' opaque' : ''}`} aria-hidden="true" />
              {s.label}
              {s.parallel ? ' (in parallel)' : ''}
            </li>
          ))}
        </ul>
      )}
      <ol className="latency">
        {shown.map(({ u, n, b }) => (
          <li key={u.id}>
            <span className="row-label">
              #{n} · {u.mode} · {totalLabel(u, b)}
              {b.totalMs !== null && b.totalMs > budgetMs[b.mode] ? ' · over budget' : ''}
            </span>
            <Waterfall b={b} domain={domain} />
            <span className="meta">{b.stages.map((s) => `${s.label} ${fmt(s.ms)}`).join(' · ')}</span>
          </li>
        ))}
      </ol>
      {rows.length > shown.length && (
        <p className="meta">
          Showing the latest {shown.length} of {rows.length}; p50/p95 above use all of them, and the export has every
          row.
        </p>
      )}
      <p className="hint">
        Speech end is this browser's VAD (RMS below {defaultVadOptions.threshold} for {defaultVadOptions.hangoverMs} ms,
        back-dated to the last voiced frame) in both modes, so the vendors' own silence timeouts show up as endpointing.
        Server marks are offset-corrected with ping/pong. Cascade measures audio scheduled; Realtime measures audio
        heard on the WebRTC track, and its model time is opaque. The dashed line is the brief&apos;s budget (
        {budgetMs.realtime} ms Realtime, {budgetMs.cascade} ms cascade).
      </p>
    </section>
  )
}
