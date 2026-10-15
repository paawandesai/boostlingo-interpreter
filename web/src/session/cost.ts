/**
 * Cost from measured usage x list prices (T3.5). Pure. A component with no checked price is
 * reported as unpriced, never as zero, so a partial total is visibly partial.
 */
import type { Mode, Usage } from '../transports/types'

export interface PriceEntry {
  key: string
  model: string
  inputPerMTok?: number | null
  outputPerMTok?: number | null
  perMinute?: number | null
  perThousandCharacters?: number | null
  audioInputPerMTok?: number | null
  audioOutputPerMTok?: number | null
  textInputPerMTok?: number | null
  textOutputPerMTok?: number | null
  cachedInputPerMTok?: number | null
  source: string
  checkedOn: string | null
}

export interface PriceList {
  currency: string
  entries: PriceEntry[]
}

export interface CostLine {
  component: string
  quantity: number
  unit: string
  unitPrice: number | null
  cost: number | null
  priceSource: string | null
}

export interface CostReport {
  mode: Mode
  minutes: number
  lines: CostLine[]
  /** Sum of priced lines. */
  pricedTotal: number
  /** Components with usage but no checked price; when non-empty the total is incomplete. */
  unpriced: string[]
  /** pricedTotal / minutes, or null with no minutes or any unpriced component. */
  perMinute: number | null
}

export interface CostInput {
  mode: Mode
  minutes: number
  usage: Usage[]
  sttAudioSeconds: number
  /** Cascade adapters (from /api/cascade/providers) or the Realtime model. */
  providers: { stt?: string; translator?: string; tts?: string; realtimeModel?: string }
}

function find(prices: PriceList, key: string, model?: string): PriceEntry | undefined {
  return prices.entries.find((e) => e.key === key && (model === undefined || e.model === model))
}

function sum(usage: Usage[], k: keyof Usage): number | null {
  const vals = usage.map((u) => u[k]).filter((v): v is number => v !== undefined)
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0)
}

function line(
  component: string,
  quantity: number,
  unit: string,
  perUnit: number | null | undefined,
  entry?: PriceEntry,
): CostLine {
  const unitPrice = perUnit ?? null
  return {
    component,
    quantity,
    unit,
    unitPrice,
    cost: unitPrice === null ? null : quantity * unitPrice,
    priceSource: entry && unitPrice !== null ? `${entry.source} (checked ${entry.checkedOn ?? 'never'})` : null,
  }
}

export function computeCost(input: CostInput, prices: PriceList): CostReport {
  const lines: CostLine[] = []
  const { usage, providers } = input
  if (input.mode === 'cascade') {
    const stt = find(prices, `stt:${providers.stt}`)
    if (input.sttAudioSeconds > 0)
      lines.push(line(`STT (${providers.stt})`, input.sttAudioSeconds / 60, 'min', stt?.perMinute, stt))
    const tr = find(prices, `translator:${providers.translator}`)
    const inTok = sum(usage, 'inputTokens')
    const outTok = sum(usage, 'outputTokens')
    if (inTok !== null)
      lines.push(line(`Translation input (${providers.translator})`, inTok / 1e6, 'MTok', tr?.inputPerMTok, tr))
    if (outTok !== null)
      lines.push(line(`Translation output (${providers.translator})`, outTok / 1e6, 'MTok', tr?.outputPerMTok, tr))
    const tts = find(prices, `tts:${providers.tts}`)
    const chars = sum(usage, 'ttsCharacters')
    if (chars !== null)
      lines.push(line(`TTS (${providers.tts})`, chars / 1000, 'k chars', tts?.perThousandCharacters, tts))
  } else {
    const rt = find(prices, 'realtime:openai', providers.realtimeModel)
    const parts: Array<[keyof Usage, string, number | null | undefined]> = [
      ['inputAudioTokens', 'audio input', rt?.audioInputPerMTok],
      ['outputAudioTokens', 'audio output', rt?.audioOutputPerMTok],
      ['inputTextTokens', 'text input', rt?.textInputPerMTok],
      ['outputTextTokens', 'text output', rt?.textOutputPerMTok],
    ]
    for (const [k, label, price] of parts) {
      const n = sum(usage, k)
      if (n !== null) lines.push(line(`Realtime ${label} (${providers.realtimeModel})`, n / 1e6, 'MTok', price, rt))
    }
  }
  const priced = lines.filter((l) => l.cost !== null)
  const unpriced = lines.filter((l) => l.cost === null).map((l) => l.component)
  const pricedTotal = priced.reduce((a, l) => a + (l.cost ?? 0), 0)
  return {
    mode: input.mode,
    minutes: input.minutes,
    lines,
    pricedTotal,
    unpriced,
    perMinute: input.minutes > 0 && unpriced.length === 0 && lines.length > 0 ? pricedTotal / input.minutes : null,
  }
}
