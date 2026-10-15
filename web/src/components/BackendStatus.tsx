import { useEffect, useState } from 'react'
import { fetchHealth, missingConfig } from '../session/health'

type State =
  { kind: 'loading' } | { kind: 'ok'; version: string; missing: string[] } | { kind: 'error'; message: string }

export function BackendStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    fetchHealth()
      .then((h) => setState({ kind: 'ok', version: h.version, missing: missingConfig(h) }))
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
  }, [])

  return (
    <p role="status" className="backend-status">
      Backend:{' '}
      {state.kind === 'loading'
        ? 'checking…'
        : state.kind === 'ok'
          ? `ok (v${state.version})${state.missing.length ? ` · not set on the server: ${state.missing.join(', ')}` : ''}`
          : `unreachable (${state.message})`}
    </p>
  )
}
