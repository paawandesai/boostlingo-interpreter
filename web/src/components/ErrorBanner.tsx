import { useEffect, useState } from 'react'
import type { SessionState } from '../session/store'

/** Recoverable states are amber; the session stopping or refusing is red (screen C). */
const WARN_KINDS = new Set(['rate_limited', 'empty_transcript', 'tts_failed'])

const messages: Record<string, { title: string; action: string }> = {
  rate_limited: { title: 'Rate limited by the provider.', action: 'Retry' },
  timeout: { title: 'The provider timed out.', action: 'Retry' },
  empty_transcript: { title: 'No speech recognised. Check the input level.', action: 'Dismiss' },
  tts_failed: { title: 'Speech synthesis failed. The text is still shown.', action: 'Dismiss' },
  mic_denied: {
    title:
      'Microphone access is blocked. Click the icon at the left of the address bar, set Microphone to Allow, then press Try again.',
    action: 'Try again',
  },
  webrtc_dropped: { title: 'Connection to the Realtime API dropped.', action: 'Reconnect' },
  auth: { title: 'The server refused the request (access token or provider key).', action: 'Dismiss' },
  unavailable: { title: 'The provider is unavailable.', action: 'Retry' },
}

/** Failure banner: one title and one recovery action per error kind (T3.4). */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: NonNullable<SessionState['error']>
  onRetry(): void
  onDismiss(): void
}) {
  const m = messages[error.kind] ?? messages.unavailable
  const retries = m.action !== 'Dismiss'
  // Seconds left before the provider's Retry-After allows another try, ticked for the error it belongs to.
  const [tick, setTick] = useState<{ error: typeof error; left: number } | null>(null)
  useEffect(() => {
    const ms = error.retryAfterMs
    if (!ms) return
    const until = Date.now() + ms
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setTick({ error, left })
      if (left === 0) clearInterval(id)
    }, 250)
    return () => clearInterval(id)
  }, [error])
  const waitS = !error.retryAfterMs ? 0 : tick?.error === error ? tick.left : Math.ceil(error.retryAfterMs / 1000)
  const waiting = retries && waitS > 0
  return (
    <div role="alert" className={WARN_KINDS.has(error.kind) ? 'banner warn' : 'banner'}>
      <div>
        <strong>{m.title}</strong>
        <span className="meta">{error.message}</span>
      </div>
      <button type="button" className="end" disabled={waiting} onClick={retries ? onRetry : onDismiss}>
        {waiting ? `${m.action} in ${waitS} s` : m.action}
      </button>
    </div>
  )
}
