import { describe, expect, it, vi } from 'vitest'
import { createRealtimeSession, exchangeSdp, exchangeSdpWithFreshSecret, RealtimeApiError } from './api'

describe('createRealtimeSession', () => {
  it('posts the direction to our backend, not to OpenAI', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientSecret: 'ek_1' })))
    await createRealtimeSession('en', 'es', undefined, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('/api/realtime/session', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ source: 'en', target: 'es' })
  })

  it('sends the chosen model and the demo access token', async () => {
    localStorage.setItem('workbench.accessToken', 'demo-token')
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientSecret: 'ek_1' })))
    await createRealtimeSession('en', 'es', 'gpt-realtime', fetchImpl)
    const init = fetchImpl.mock.calls[0][1]
    expect(JSON.parse(init.body)).toEqual({ source: 'en', target: 'es', model: 'gpt-realtime' })
    expect(init.headers).toMatchObject({ 'X-Access-Token': 'demo-token' })
    localStorage.removeItem('workbench.accessToken')
  })

  it('maps a 401 problem to auth', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ kind: 'Auth', detail: 'Missing or wrong access token.' }), { status: 401 }),
      )
    const err = await createRealtimeSession('en', 'es', undefined, fetchImpl).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'auth', message: 'Missing or wrong access token.' })
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

describe('exchangeSdpWithFreshSecret', () => {
  const info = (secret: string, expiresAt: string) => ({
    clientSecret: secret,
    expiresAt,
    callsUrl: 'https://calls.test',
  })
  const now = () => Date.parse('2026-10-17T12:00:00Z')
  const answer = () => new Response('v=0 answer', { status: 201 })
  const authHeader = (f: ReturnType<typeof vi.fn>, call: number) =>
    (f.mock.calls[call][1] as { headers: Record<string, string> }).headers.Authorization

  it('uses a secret that is still valid as is', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer())
    const remint = vi.fn()
    const out = await exchangeSdpWithFreshSecret(info('ek_1', '2026-10-17T12:00:30Z'), 'offer', remint, now, fetchImpl)
    expect(out.answer).toBe('v=0 answer')
    expect(remint).not.toHaveBeenCalled()
    expect(authHeader(fetchImpl, 0)).toBe('Bearer ek_1')
  })

  it('re-mints a secret that expired while the mic permission prompt waited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer())
    const remint = vi.fn().mockResolvedValue(info('ek_2', '2026-10-17T12:01:00Z'))
    const out = await exchangeSdpWithFreshSecret(info('ek_1', '2026-10-17T12:00:02Z'), 'offer', remint, now, fetchImpl)
    expect(remint).toHaveBeenCalledTimes(1)
    expect(authHeader(fetchImpl, 0)).toBe('Bearer ek_2')
    expect(out.info.clientSecret).toBe('ek_2')
  })

  it('retries a 401 once with a fresh secret, and only once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(answer())
    const remint = vi.fn().mockResolvedValue(info('ek_2', ''))
    const out = await exchangeSdpWithFreshSecret(info('ek_1', ''), 'offer', remint, now, fetchImpl)
    expect(out.answer).toBe('v=0 answer')
    expect(authHeader(fetchImpl, 1)).toBe('Bearer ek_2')

    const refusing = vi.fn().mockImplementation(async () => new Response('', { status: 401 }))
    await expect(exchangeSdpWithFreshSecret(info('ek_1', ''), 'offer', remint, now, refusing)).rejects.toThrow(
      'HTTP 401',
    )
    expect(refusing).toHaveBeenCalledTimes(2)
  })
})
