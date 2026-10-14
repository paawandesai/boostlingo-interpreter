import { accessHeaders } from '../../session/access'
import type { ErrorKind } from '../types'

export interface RealtimeSessionInfo {
  clientSecret: string
  expiresAt: string
  model: string
  transcriptionModel: string
  callsUrl: string
  /** Keyed "en>es". */
  instructions: Record<string, string>
}

export class RealtimeApiError extends Error {
  readonly kind: ErrorKind
  readonly retryAfterMs?: number

  constructor(kind: ErrorKind, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'RealtimeApiError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

const kindMap: Record<string, ErrorKind> = {
  RateLimited: 'rate_limited',
  Timeout: 'timeout',
  Auth: 'auth',
  Empty: 'unavailable',
  Unavailable: 'unavailable',
}

/** Asks our backend for an ephemeral secret. The browser never sees the OpenAI API key. */
export async function createRealtimeSession(
  source: string,
  target: string,
  model?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RealtimeSessionInfo> {
  const res = await fetchImpl('/api/realtime/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: JSON.stringify(model ? { source, target, model } : { source, target }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { kind?: string; detail?: string; retryAfterMs?: number }
    throw new RealtimeApiError(
      kindMap[body.kind ?? ''] ?? (res.status === 429 ? 'rate_limited' : 'unavailable'),
      body.detail ?? `Realtime session request failed (HTTP ${res.status})`,
      body.retryAfterMs,
    )
  }
  return (await res.json()) as RealtimeSessionInfo
}

/** WebRTC SDP exchange with OpenAI using the ephemeral secret. */
export async function exchangeSdp(
  callsUrl: string,
  clientSecret: string,
  offerSdp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(callsUrl, {
    method: 'POST',
    body: offerSdp,
    headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
  })
  if (!res.ok) {
    throw new RealtimeApiError(
      res.status === 429 ? 'rate_limited' : 'unavailable',
      `SDP exchange failed (HTTP ${res.status})`,
    )
  }
  return res.text()
}
