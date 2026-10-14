import { describe, expect, it, vi } from 'vitest'
import { fetchHealth } from './health'

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
