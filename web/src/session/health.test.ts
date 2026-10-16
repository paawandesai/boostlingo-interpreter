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
  // Every key unset, in the sorted order /health sends them.
  const keys = {
    CLAUDE_TRANSLATOR_API_KEY: false,
    DEEPGRAM_API_KEY: false,
    ELEVENLABS_API_KEY: false,
    OPENAI_API_KEY: false,
  }

  it('lists unset keys and a missing access token, and nothing for an older server', () => {
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

  it('skips the keys of cascade adapters that are not configured', () => {
    // The public demo: OpenAI STT and translator, so Deepgram and the Anthropic translator key do not matter.
    expect(
      missingConfig({
        ...base,
        config: {
          accessTokenSet: true,
          keys,
          cascadeStt: 'openai',
          cascadeTranslator: 'openai',
          cascadeTts: 'elevenlabs',
        },
      }),
    ).toEqual(['ELEVENLABS_API_KEY', 'OPENAI_API_KEY'])
    expect(
      missingConfig({
        ...base,
        config: {
          accessTokenSet: true,
          keys,
          cascadeStt: 'deepgram',
          cascadeTranslator: 'anthropic',
          cascadeTts: 'other',
        },
      }),
    ).toEqual(['CLAUDE_TRANSLATOR_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY'])
  })

  it('still lists a key it does not know about', () => {
    expect(
      missingConfig({
        ...base,
        config: {
          accessTokenSet: true,
          keys: { NEW_VENDOR_KEY: false },
          cascadeStt: 'openai',
          cascadeTranslator: 'openai',
          cascadeTts: 'elevenlabs',
        },
      }),
    ).toEqual(['NEW_VENDOR_KEY'])
  })
})
