import { useEffect, useState } from 'react'
import { AudioCheck } from './components/AudioCheck'
import { BackendStatus } from './components/BackendStatus'
import { LiveSession } from './components/LiveSession'
import { SetupPanel } from './components/SetupPanel'
import { fetchLanguages, type LanguagesResponse } from './session/languages'
import { useSession } from './session/useSession'

export default function App() {
  const { state, start, end, configure, setSpeaker, dismissError } = useSession()
  const [languages, setLanguages] = useState<LanguagesResponse | null>(null)

  useEffect(() => {
    fetchLanguages()
      .then(setLanguages)
      .catch(() => setLanguages(null))
  }, [])

  const inSession = state.status === 'connecting' || state.status === 'live'

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>AI Interpreter Workbench</h1>
          <p className="meta">Realtime API vs. cascade pipeline, measured the same way</p>
        </div>
        <BackendStatus />
      </header>
      {inSession ? (
        <LiveSession
          state={state}
          languages={languages}
          onSpeaker={setSpeaker}
          onEnd={() => void end()}
          onRetry={() => void start()}
          onDismissError={dismissError}
        />
      ) : (
        <>
          {state.error && (
            <p role="alert" className="banner">
              {state.error.message}
            </p>
          )}
          <SetupPanel
            state={state}
            languages={languages}
            onConfigure={configure}
            onSpeaker={setSpeaker}
            onStart={() => void start()}
          />
          <details className="panel">
            <summary>Audio check (mic, VAD, test tone)</summary>
            <AudioCheck />
          </details>
        </>
      )}
    </main>
  )
}
