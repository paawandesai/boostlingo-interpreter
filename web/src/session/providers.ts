import type { Mode } from '../transports/types'

export interface CascadeProviders {
  stt: string
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
  if (mode === 'realtime') return ['OpenAI']
  if (!cascade) return null
  const names = [cascade.stt, cascade.translator, cascade.tts].map((v) => vendorNames[v] ?? v)
  return [...new Set(names)]
}
