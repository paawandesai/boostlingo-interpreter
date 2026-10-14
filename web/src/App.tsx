import { useEffect, useState } from 'react'
import { speakNotice } from './audio/spokenNotice'
import { AiBanner } from './components/AiBanner'
import { AudioCheck } from './components/AudioCheck'
import { BackendStatus } from './components/BackendStatus'
import { LiveSession } from './components/LiveSession'
import { SetupPanel } from './components/SetupPanel'
import { fetchLanguages, type LanguagesResponse } from './session/languages'
import { fetchRealtimeModels, type RealtimeModels } from './session/models'
import { fetchCascadeProviders, type CascadeProviders } from './session/providers'
import { useSession } from './session/useSession'

export default function App() {
  const { state, start, end, configure, setSpeaker, dismissError, requestHuman, switchMode } = useSession()
  const [languages, setLanguages] = useState<LanguagesResponse | null>(null)
  const [models, setModels] = useState<RealtimeModels | null>(null)
  const [cascadeProviders, setCascadeProviders] = useState<CascadeProviders | null>(null)
  const [announcing, setAnnouncing] = useState(false)

  useEffect(() => {
    fetchLanguages()
      .then(setLanguages)
      .catch(() => setLanguages(null))
    fetchRealtimeModels()
      .then(setModels)
      .catch(() => setModels(null))
    fetchCascadeProviders()
      .then(setCascadeProviders)
      .catch(() => setCascadeProviders(null))
  }, [])

  // The spoken notice plays before the transport starts, so the mic is not open yet (G7).
  const startWithNotice = async ({ spokenNotice }: { spokenNotice: boolean }) => {
    if (spokenNotice) {
      const lines = [state.langA, state.langB].flatMap((code) => {
        const text = languages?.languages.find((l) => l.code === code)?.disclosure?.spoken
        return text ? [{ text, lang: code }] : []
      })
      setAnnouncing(true)
      try {
        await speakNotice(lines)
      } finally {
        setAnnouncing(false)
      }
    }
    await start()
  }

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
      <AiBanner />
      {inSession ? (
        <LiveSession
          state={state}
          languages={languages}
          onSpeaker={setSpeaker}
          onEnd={() => void end()}
          onRetry={() => void start()}
          onDismissError={dismissError}
          onRequestHuman={() => void requestHuman()}
          onSwitchMode={(m) => void switchMode(m)}
        />
      ) : (
        <>
          {announcing && (
            <p role="status" className="banner info">
              Reading the AI notice aloud. The mic opens when it finishes.
            </p>
          )}
          {state.handoffRequested && (
            <div role="alert" className="banner info">
              <div>
                <strong>Human interpreter requested. The AI session has ended.</strong>
                <span className="meta">
                  In a production deployment this hands the call to a qualified human interpreter. This demo has no
                  interpreter queue, so no request was sent anywhere.
                </span>
              </div>
            </div>
          )}
          {state.error && (
            <p role="alert" className="banner">
              {state.error.message}
            </p>
          )}
          <SetupPanel
            state={state}
            languages={languages}
            models={models}
            cascadeProviders={cascadeProviders}
            onConfigure={configure}
            onSpeaker={setSpeaker}
            onStart={(opts) => void startWithNotice(opts)}
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
