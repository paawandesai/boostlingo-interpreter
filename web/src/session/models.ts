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

/**
 * Model ids the setup screen marks as deprecated. OpenAI deprecated gpt-realtime (removal
 * 2027-01-20; docs/GUARDRAILS.md, "The required model is deprecated"), and it stays selectable so
 * the brief's model can still be measured. GET /api/realtime/models carries no deprecation field,
 * so the hint lives here until the server reports one.
 */
export const DEPRECATED_REALTIME_MODELS: ReadonlySet<string> = new Set(['gpt-realtime'])

/** Option label for the model select: the id plus "(default)" and the deprecation hint where they apply. */
export function realtimeModelLabel(id: string, models: RealtimeModels): string {
  const notes = [
    ...(id === models.default ? ['default'] : []),
    ...(DEPRECATED_REALTIME_MODELS.has(id) ? ['deprecated by OpenAI'] : []),
  ]
  return notes.length ? `${id} (${notes.join(', ')})` : id
}
