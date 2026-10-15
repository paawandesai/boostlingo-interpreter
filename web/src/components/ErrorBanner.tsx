import type { SessionState } from '../session/store'

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
  return (
    <div role="alert" className="banner">
      <div>
        <strong>{m.title}</strong>
        <span className="meta">
          {error.message}
          {error.retryAfterMs ? ` · retry after ${Math.ceil(error.retryAfterMs / 1000)} s` : ''}
        </span>
      </div>
      <button type="button" onClick={retries ? onRetry : onDismiss}>
        {m.action}
      </button>
    </div>
  )
}
