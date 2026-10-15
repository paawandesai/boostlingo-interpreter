export interface Health {
  status: string
  version: string
  /** Which keys and adapters the server has (true/false only; G12). Absent on older servers. */
  config?: {
    accessTokenSet: boolean
    keys: Record<string, boolean>
    cascadeStt: string
    cascadeTranslator: string
    cascadeTts: string
  }
  /** ISO time each provider last succeeded in a real session, keyed "stage:adapter". */
  lastSuccess?: Record<string, string>
}

/** Server settings that will make a session fail, for the header. */
export function missingConfig(h: Health): string[] {
  if (!h.config) return []
  const missing = Object.entries(h.config.keys)
    .filter(([, set]) => !set)
    .map(([name]) => name)
  return h.config.accessTokenSet ? missing : ['DEMO_ACCESS_TOKEN', ...missing]
}

/** Calls the backend through the Vite proxy; never reaches a vendor directly. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<Health> {
  const res = await fetchImpl('/health')
  if (!res.ok) throw new Error(`Backend health check failed: HTTP ${res.status}`)
  return (await res.json()) as Health
}
