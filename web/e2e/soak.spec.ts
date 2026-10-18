import { readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { backAndForth } from '../src/audio/clipOrder'
import { instrument, startSession } from './helpers'

/**
 * Soak (T3.6, G10): replays the clip set into one mode for SOAK_MINUTES (default 5) and reports
 * utterances, disconnects, drift skips, other incidents, per-stage p50/p95 and heap slope.
 * Opt-in: SOAK=1 SOAK_MODE=cascade|realtime REPLAY_DIR=<folder of en-*.wav / es-*.wav>.
 * Real provider calls; run cascade with Cascade__Stt=openai (Deepgram timing numbers are not
 * recorded, see docs/GUARDRAILS.md). Reports land in test-results/soak/.
 */
const enabled = process.env.SOAK === '1'
const modes = { realtime: 'Realtime', translate: 'Realtime translate', cascade: 'Cascade' } as const
const modeKey = (process.env.SOAK_MODE ?? 'cascade') as keyof typeof modes
const mode = modes[modeKey] ?? 'Cascade'
const minutes = Number(process.env.SOAK_MINUTES ?? 5)
const minUtterances = Number(process.env.SOAK_MIN_UTTERANCES ?? 50)
const gapMs = Number(process.env.SOAK_GAP_MS ?? 600)
/** Client endpointing only: extra wait after the VAD's speech end before committing (src/transports/endpointing.ts). */
const commitDelay = process.env.SOAK_COMMIT_DELAY_MS
const replayDir = resolve(process.env.REPLAY_DIR ?? '../eval/replay/audio')
const label = process.env.SOAK_LABEL ?? (replayDir.includes('synthetic') ? 'synthetic' : 'recorded')

interface HeapSample {
  t: number
  mb: number
}

/** Least-squares slope in MB per minute. */
function slope(samples: HeapSample[]): number {
  const n = samples.length
  if (n < 2) return 0
  const mx = samples.reduce((s, x) => s + x.t, 0) / n
  const my = samples.reduce((s, x) => s + x.mb, 0) / n
  const num = samples.reduce((s, x) => s + (x.t - mx) * (x.mb - my), 0)
  const den = samples.reduce((s, x) => s + (x.t - mx) ** 2, 0)
  return den === 0 ? 0 : (num / den) * 60_000
}

test.skip(!enabled, 'soak is opt-in: SOAK=1')

test(`soak: ${mode} for ${minutes} min`, async ({ page }) => {
  test.setTimeout((minutes + 3) * 60_000)
  // Alternating speakers, so a run is a back-and-forth in both directions, not every English clip first.
  const files = backAndForth(readdirSync(replayDir).filter((f) => /^(en|es)-.*\.(wav|webm|ogg|mp3)$/i.test(f))).map(
    (f) => join(replayDir, f),
  )
  expect(files.length, `replay clips in ${replayDir}`).toBeGreaterThan(0)

  await instrument(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage')
    const { metrics } = await cdp.send('Performance.getMetrics')
    return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1_048_576
  }

  await startSession(page, mode, {
    replayFiles: files,
    query: `?replayGap=${gapMs}${commitDelay ? `&commitDelay=${commitDelay}` : ''}`,
  })
  const t0 = Date.now()
  const samples: HeapSample[] = []
  while (Date.now() - t0 < minutes * 60_000) {
    samples.push({ t: Date.now() - t0, mb: await heap() })
    await page.waitForTimeout(10_000)
  }
  samples.push({ t: Date.now() - t0, mb: await heap() })
  const drops = await page.evaluate(() => window.__live.drops)

  // End discards the transcript (G20), so the log is exported first.
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export log', exact: true }).click()
  const logPath = await (await download).path()
  await page.getByRole('button', { name: 'End', exact: true }).click()
  const log = JSON.parse(readFileSync(logPath, 'utf8')) as {
    modes: Array<{ mode: string; minutes: number; utterances: number; latency: unknown[] }>
    utterances: Array<{ side: string; target: { text: string; final: boolean } | null; audioFailed: boolean }>
    incidents: Array<{ kind: string; message: string }>
  }

  const translated = log.utterances.filter((u) => u.target?.final && u.target.text.trim()).length
  const incidents = log.incidents.reduce<Record<string, number>>((acc, i) => {
    const key = i.kind === 'notice' && /late audio/.test(i.message) ? 'drift_skip' : i.kind
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const minuteOne = samples.find((s) => s.t >= 60_000) ?? samples[0]
  const last = samples[samples.length - 1]
  // Measured, not configured: the session can end before the wall clock does (a server close).
  const measuredMinutes = log.modes.find((m) => m.mode === modeKey)?.minutes ?? 0
  const report = {
    mode: modeKey,
    input: label,
    clips: files.length,
    minutes,
    measuredMinutes: +measuredMinutes.toFixed(2),
    sides: log.utterances.reduce<Record<string, number>>(
      (acc, u) => ({ ...acc, [u.side]: (acc[u.side] ?? 0) + 1 }),
      {},
    ),
    utterances: log.utterances.length,
    translated,
    audioFailed: log.utterances.filter((u) => u.audioFailed).length,
    disconnects: drops.length,
    drops,
    incidents,
    heap: {
      minuteOneMb: +minuteOne.mb.toFixed(2),
      lastMb: +last.mb.toFixed(2),
      growthFromMinuteOnePct: +(((last.mb - minuteOne.mb) / minuteOne.mb) * 100).toFixed(1),
      slopeMbPerMin: +slope(samples.filter((s) => s.t >= 60_000)).toFixed(3),
      // The visible transcript fills its 40-line window in the first minutes; the tail shows the steady state.
      lastTwoMinutesSlopeMbPerMin: +slope(samples.filter((s) => s.t >= (minutes - 2) * 60_000)).toFixed(3),
      samples: samples.map((s) => ({ t: s.t, mb: +s.mb.toFixed(2) })),
    },
    latency: log.modes.find((m) => m.mode === modeKey)?.latency ?? [],
  }
  const out = resolve('test-results/soak')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `soak-${report.mode}-${label}.json`), JSON.stringify(report, null, 2))
  // The session log holds only the synthetic or scripted clips' text; kept next to the report for line-level checks.
  writeFileSync(join(out, `soak-${report.mode}-${label}-session-log.json`), readFileSync(logPath))
  // Transcripts stay out of the report; the raw session log is kept only as a local test artifact.
  await test.info().attach('session-log', { path: logPath, contentType: 'application/json' })

  expect.soft(report.disconnects, 'unexpected disconnects').toBe(0)
  expect.soft(report.measuredMinutes, 'minutes the session actually ran').toBeGreaterThanOrEqual(minutes * 0.98)
  expect.soft(Object.keys(report.sides).length, 'both speakers took turns').toBe(2)
  expect.soft(report.utterances, 'utterances in the run (G10)').toBeGreaterThanOrEqual(minUtterances)
  expect.soft(report.heap.growthFromMinuteOnePct, 'heap growth from minute 1').toBeLessThan(10)
})
