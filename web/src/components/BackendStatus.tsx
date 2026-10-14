import { useEffect, useState } from 'react'
import { fetchHealth } from '../session/health'

type State = { kind: 'loading' } | { kind: 'ok'; version: string } | { kind: 'error'; message: string }

export function BackendStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    fetchHealth()
      .then((h) => setState({ kind: 'ok', version: h.version }))
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
  }, [])

  return (
    <p role="status">
      Backend:{' '}
      {state.kind === 'loading'
        ? 'checking…'
        : state.kind === 'ok'
          ? `ok (v${state.version})`
          : `unreachable (${state.message})`}
    </p>
  )
}
