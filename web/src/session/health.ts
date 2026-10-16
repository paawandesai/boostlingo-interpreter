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

type HealthConfig = NonNullable<Health['config']>

/**
 * Keys only one cascade adapter needs. /health reports every key the server knows, so a key is
 * listed as missing only when the adapter that would use it is the configured one; the others
 * (OPENAI_API_KEY for both Realtime modes and the OpenAI cascade adapters) are always needed.
 */
const NEEDED_BY: Record<string, (c: HealthConfig) => boolean> = {
  DEEPGRAM_API_KEY: (c) => c.cascadeStt === 'deepgram',
  CLAUDE_TRANSLATOR_API_KEY: (c) => c.cascadeTranslator === 'anthropic',
  ELEVENLABS_API_KEY: (c) => c.cascadeTts === 'elevenlabs',
}

/** Server settings that will make a session fail, for the header. */
export function missingConfig(h: Health): string[] {
  const config = h.config
  if (!config) return []
  const missing = Object.entries(config.keys)
    .filter(([name, set]) => !set && (NEEDED_BY[name]?.(config) ?? true))
    .map(([name]) => name)
  return config.accessTokenSet ? missing : ['DEMO_ACCESS_TOKEN', ...missing]
}

/** Calls the backend through the Vite proxy; never reaches a vendor directly. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<Health> {
  const res = await fetchImpl('/health')
  if (!res.ok) throw new Error(`Backend health check failed: HTTP ${res.status}`)
  return (await res.json()) as Health
}
