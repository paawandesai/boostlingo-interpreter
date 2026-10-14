export interface Health {
  status: string
  version: string
}

/** Calls the backend through the Vite proxy; never reaches a vendor directly. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<Health> {
  const res = await fetchImpl('/health')
  if (!res.ok) throw new Error(`Backend health check failed: HTTP ${res.status}`)
  return (await res.json()) as Health
}
