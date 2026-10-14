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
  /** The client ends the session after this long (G19). */
  maxSessionSeconds?: number
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
  glossary = false,
): Promise<RealtimeSessionInfo> {
  const res = await fetchImpl('/api/realtime/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: JSON.stringify({ source, target, ...(model ? { model } : {}), ...(glossary ? { glossary } : {}) }),
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

export interface TranslationSessionInfo {
  clientSecret: string
  expiresAt: string
  model: string
  callsUrl: string
  /** Language the translation is spoken in; the model detects the source (G17). */
  target: string
  maxSessionSeconds?: number
}

/**
 * Ephemeral secret for gpt-realtime-translate (G17). The request carries only the target language:
 * the session has no instructions and no tools, so nothing said can reconfigure it.
 */
export async function createTranslationSession(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TranslationSessionInfo> {
  const res = await fetchImpl('/api/realtime/translation-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: JSON.stringify({ target }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { kind?: string; detail?: string; retryAfterMs?: number }
    throw new RealtimeApiError(
      kindMap[body.kind ?? ''] ?? (res.status === 429 ? 'rate_limited' : 'unavailable'),
      body.detail ?? `Translation session request failed (HTTP ${res.status})`,
      body.retryAfterMs,
    )
  }
  return (await res.json()) as TranslationSessionInfo
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
