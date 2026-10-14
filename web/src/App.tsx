import { useEffect, useState } from 'react'
import type { ReplayClip } from './audio/replay'
import { speakNotice } from './audio/spokenNotice'
import { AiBanner } from './components/AiBanner'
import { AudioCheck } from './components/AudioCheck'
import { BackendStatus } from './components/BackendStatus'
import { LiveSession } from './components/LiveSession'
import { SetupPanel } from './components/SetupPanel'
import { fetchLanguages, type LanguagesResponse } from './session/languages'
import { fetchRealtimeModels, type RealtimeModels } from './session/models'
import { buildSessionLog, download } from './session/export'
import { fetchHealth } from './session/health'
import { fetchCascadeProviders, fetchGlossaryInfo, fetchPrices, type CascadeProviders } from './session/providers'
import { useSession } from './session/useSession'

export default function App() {
  const { state, start, end, configure, setSpeaker, dismissError, requestHuman, switchMode } = useSession()
  const [languages, setLanguages] = useState<LanguagesResponse | null>(null)
  const [models, setModels] = useState<RealtimeModels | null>(null)
  const [cascadeProviders, setCascadeProviders] = useState<CascadeProviders | null>(null)
  const [announcing, setAnnouncing] = useState(false)
  const [glossaryTerms, setGlossaryTerms] = useState<number | null>(null)
  const [replay, setReplay] = useState<ReplayClip[]>([])

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
    fetchGlossaryInfo()
      .then((g) => setGlossaryTerms(g.count))
      .catch(() => setGlossaryTerms(null))
  }, [])

  const exportLog = async () => {
    const [prices, health] = await Promise.all([fetchPrices().catch(() => null), fetchHealth().catch(() => null)])
    download(
      buildSessionLog(state, {
        exportedAt: new Date().toISOString(),
        appVersion: health?.version ?? null,
        cascadeProviders,
        defaultRealtimeModel: models?.default ?? null,
        prices,
        userAgent: navigator.userAgent,
      }),
    )
  }
  const hasLog = state.timeline.some((x) => x.kind === 'utterance')

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
    await start({ replay })
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
          onExport={() => void exportLog()}
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
          {hasLog && (
            <p className="actions-row">
              <button type="button" onClick={() => void exportLog()}>
                Export last session log (JSON)
              </button>
            </p>
          )}
          <SetupPanel
            state={state}
            languages={languages}
            models={models}
            cascadeProviders={cascadeProviders}
            glossaryTerms={glossaryTerms}
            replay={replay}
            onReplay={setReplay}
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
