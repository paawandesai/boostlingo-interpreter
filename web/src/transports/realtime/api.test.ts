import { describe, expect, it, vi } from 'vitest'
import { createRealtimeSession, exchangeSdp, RealtimeApiError } from './api'

describe('createRealtimeSession', () => {
  it('posts the direction to our backend, not to OpenAI', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientSecret: 'ek_1' })))
    await createRealtimeSession('en', 'es', undefined, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('/api/realtime/session', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ source: 'en', target: 'es' })
  })

  it('sends the chosen model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientSecret: 'ek_1' })))
    await createRealtimeSession('en', 'es', 'gpt-realtime', fetchImpl)
    const init = fetchImpl.mock.calls[0][1]
    expect(JSON.parse(init.body)).toEqual({ source: 'en', target: 'es', model: 'gpt-realtime' })
  })

  it('maps a 429 problem to rate_limited with retry-after', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ kind: 'RateLimited', detail: 'slow', retryAfterMs: 2000 }), { status: 429 }),
      )
    const err = await createRealtimeSession('en', 'es', undefined, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RealtimeApiError)
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2000 })
  })
})

describe('exchangeSdp', () => {
  it('sends the offer as application/sdp with the ephemeral secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('v=0 answer', { status: 201 }))
    const answer = await exchangeSdp('https://api.openai.com/v1/realtime/calls', 'ek_1', 'v=0 offer', fetchImpl)
    expect(answer).toBe('v=0 answer')
    const init = fetchImpl.mock.calls[0][1]
    expect(init.headers).toEqual({ Authorization: 'Bearer ek_1', 'Content-Type': 'application/sdp' })
    expect(init.body).toBe('v=0 offer')
  })
})
