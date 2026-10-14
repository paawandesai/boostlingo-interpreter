export interface RealtimeModels {
  default: string
  allowed: string[]
}

/** Realtime model ids are server configuration (docs/GUARDRAILS.md); the UI only picks from this list. */
export async function fetchRealtimeModels(fetchImpl: typeof fetch = fetch): Promise<RealtimeModels> {
  const res = await fetchImpl('/api/realtime/models')
  if (!res.ok) throw new Error(`Could not load Realtime models: HTTP ${res.status}`)
  return (await res.json()) as RealtimeModels
}
