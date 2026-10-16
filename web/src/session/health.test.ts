import { describe, expect, it, vi } from 'vitest'
import { fetchHealth, missingConfig } from './health'

describe('fetchHealth', () => {
  it('returns the backend status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', version: '1.0.0' })))
    await expect(fetchHealth(fetchImpl)).resolves.toEqual({ status: 'ok', version: '1.0.0' })
    expect(fetchImpl).toHaveBeenCalledWith('/health')
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await expect(fetchHealth(fetchImpl)).rejects.toThrow('HTTP 503')
  })
})

describe('missingConfig', () => {
  const base = { status: 'ok', version: '1' }
  const adapters = { cascadeStt: 'openai', cascadeTranslator: 'openai', cascadeTts: 'elevenlabs' }

  it('shows the keys the server says are missing, after a missing access token', () => {
    expect(missingConfig(base)).toEqual([])
    expect(
      missingConfig({
        ...base,
        config: { accessTokenSet: false, keys: { A_KEY: true, B_KEY: false }, ...adapters, missing: ['B_KEY'] },
      }),
    ).toEqual(['DEMO_ACCESS_TOKEN', 'B_KEY'])
    expect(
      missingConfig({
        ...base,
        config: { accessTokenSet: true, keys: { A_KEY: true, B_KEY: false }, ...adapters, missing: [] },
      }),
    ).toEqual([])
  })

  it('lists every unset key when an older server sends no missing list', () => {
    expect(
      missingConfig({
        ...base,
        config: { accessTokenSet: true, keys: { A_KEY: false, B_KEY: true, C_KEY: false }, ...adapters },
      }),
    ).toEqual(['A_KEY', 'C_KEY'])
  })
})
