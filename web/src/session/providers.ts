import type { Mode } from '../transports/types'
import type { PriceList } from './cost'

export interface CascadeProviders {
  stt: string
  /** The OpenAI transcription model when `stt` is openai; null for other vendors and in older logs. */
  sttModel?: string | null
  translator: string
  tts: string
}

const vendorNames: Record<string, string> = {
  openai: 'OpenAI',
  deepgram: 'Deepgram',
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs',
}

/** Which vendors the server is configured to use for cascade sessions (no live calls). */
export async function fetchCascadeProviders(fetchImpl: typeof fetch = fetch): Promise<CascadeProviders> {
  const res = await fetchImpl('/api/cascade/providers')
  if (!res.ok) throw new Error(`Could not load cascade providers: HTTP ${res.status}`)
  return (await res.json()) as CascadeProviders
}

/** Vendors that receive the conversation in a mode, for the consent notice. Null when unknown. */
export function vendorsFor(mode: Mode, cascade: CascadeProviders | null): string[] | null {
  if (mode !== 'cascade') return ['OpenAI']
  if (!cascade) return null
  const names = [cascade.stt, cascade.translator, cascade.tts].map((v) => vendorNames[v] ?? v)
  return [...new Set(names)]
}

/**
 * Vendors that may receive the conversation in a session that can switch between `modes` mid-session, for the
 * consent notice. Null when any of them is unknown, so the notice never names fewer vendors than may be used.
 */
export function vendorsForModes(modes: Mode[], cascade: CascadeProviders | null): string[] | null {
  const lists = modes.map((m) => vendorsFor(m, cascade))
  if (lists.length === 0 || lists.some((l) => l === null)) return null
  return [...new Set(lists.flatMap((l) => l!))]
}

/** List prices from config/prices.json (null prices mean unchecked). */
export async function fetchPrices(fetchImpl: typeof fetch = fetch): Promise<PriceList> {
  const res = await fetchImpl('/api/prices')
  if (!res.ok) throw new Error(`Could not load prices: HTTP ${res.status}`)
  return (await res.json()) as PriceList
}

/** Size of the server's glossary; 0 when none is configured. */
export async function fetchGlossaryInfo(fetchImpl: typeof fetch = fetch): Promise<{ name: string; count: number }> {
  const res = await fetchImpl('/api/glossary')
  if (!res.ok) throw new Error(`Could not load glossary: HTTP ${res.status}`)
  return (await res.json()) as { name: string; count: number }
}
