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
  it('lists unset keys and a missing access token, and nothing for an older server', () => {
    const base = { status: 'ok', version: '1' }
    expect(missingConfig(base)).toEqual([])
    expect(
      missingConfig({
        ...base,
        config: {
          accessTokenSet: false,
          keys: { OPENAI_API_KEY: true, DEEPGRAM_API_KEY: false },
          cascadeStt: 'deepgram',
          cascadeTranslator: 'openai',
          cascadeTts: 'elevenlabs',
        },
      }),
    ).toEqual(['DEMO_ACCESS_TOKEN', 'DEEPGRAM_API_KEY'])
  })
})
