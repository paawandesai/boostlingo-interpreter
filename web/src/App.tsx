import { Fragment, useEffect, useState } from 'react'
import type { ReplayClip } from './audio/replay'
import { speakNotice } from './audio/spokenNotice'
import { AiBanner } from './components/AiBanner'
import { AudioCheck } from './components/AudioCheck'
import { BackendStatus } from './components/BackendStatus'
import { LiveSession } from './components/LiveSession'
import { SetupPanel } from './components/SetupPanel'
import { defaultMode, fetchLanguages, type LanguagesResponse } from './session/languages'
import { initialState } from './session/store'
import { fetchRealtimeModels, type RealtimeModels } from './session/models'
import { browserSummary, buildSessionLog, download } from './session/export'
import { fetchHealth } from './session/health'
import { MODE_LABEL } from './session/modes'
import {
  fetchCascadeProviders,
  fetchGlossaryInfo,
  fetchPrices,
  vendorsFor,
  type CascadeProviders,
} from './session/providers'
import { useSession } from './session/useSession'

/** `?replayGap=800` shortens the pause between replay clips, for the soak (T3.6). */
const replayGapMs = Number(new URLSearchParams(window.location.search).get('replayGap')) || undefined

export default function App() {
  const [languages, setLanguages] = useState<LanguagesResponse | null>(null)
  const { state, start, end, configure, setSpeaker, dismissError, requestHuman, switchMode } = useSession(languages)
  const [models, setModels] = useState<RealtimeModels | null>(null)
  const [cascadeProviders, setCascadeProviders] = useState<CascadeProviders | null>(null)
  const [announcing, setAnnouncing] = useState(false)
  const [glossaryTerms, setGlossaryTerms] = useState<number | null>(null)
  const [replay, setReplay] = useState<ReplayClip[]>([])

  useEffect(() => {
    fetchLanguages()
      .then((langs) => {
        setLanguages(langs)
        // G17: translate is the default only where the model speaks both languages of the pair; otherwise the
        // first mode BAA mode does not block.
        const mode = defaultMode(langs, initialState.langA, initialState.langB)
        if (mode !== initialState.mode) configure({ mode })
      })
      .catch(() => {
        setLanguages(null)
        configure({ mode: 'realtime' })
      })
    fetchRealtimeModels()
      .then(setModels)
      .catch(() => setModels(null))
    fetchCascadeProviders()
      .then(setCascadeProviders)
      .catch(() => setCascadeProviders(null))
    fetchGlossaryInfo()
      .then((g) => setGlossaryTerms(g.count))
      .catch(() => setGlossaryTerms(null))
  }, [configure])

  const exportLog = async () => {
    const [prices, health] = await Promise.all([fetchPrices().catch(() => null), fetchHealth().catch(() => null)])
    download(
      buildSessionLog(state, {
        exportedAt: new Date().toISOString(),
        appVersion: health?.version ?? null,
        cascadeProviders,
        defaultRealtimeModel: models?.default ?? null,
        prices,
        // Browser name and version only; the full string is a fingerprint the log does not need.
        userAgent: browserSummary(navigator.userAgent),
        languages,
      }),
    )
  }

  // The spoken notice plays before the mic opens (G7). The transport sets up its connection meanwhile
  // and opens the mic only when the notice has finished, so the two waits overlap instead of adding up.
  const startWithNotice = async ({ spokenNotice }: { spokenNotice: boolean }) => {
    let notice: Promise<unknown> | undefined
    if (spokenNotice) {
      const lines = [state.langA, state.langB].flatMap((code) => {
        const text = languages?.languages.find((l) => l.code === code)?.disclosure?.spoken
        return text ? [{ text, lang: code }] : []
      })
      setAnnouncing(true)
      notice = speakNotice(lines).finally(() => setAnnouncing(false))
    }
    await start({ replay, replayGapMs, beforeCapture: notice })
  }

  const inSession = state.status === 'connecting' || state.status === 'live'

  return (
    <>
      <AiBanner />
      <main className={inSession ? 'app live' : 'app'}>
        {announcing && (
          <p role="status" className="banner info">
            Reading the AI notice aloud. The mic opens when it finishes.
          </p>
        )}
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
            <header className="app-header">
              <div>
                <h1>AI Interpreter Workbench</h1>
                <p className="meta">Realtime API vs. cascade pipeline, measured the same way</p>
              </div>
              <BackendStatus />
            </header>
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
            {state.status === 'ended' && state.timeline.some((x) => x.kind === 'utterance') && (
              <p role="status" className="banner info">
                The last session&apos;s transcript is kept on this screen only and is discarded when a new session
                starts.{' '}
                <button type="button" onClick={() => void exportLog()}>
                  Export log
                </button>
              </p>
            )}
            {state.error && (
              <p role="alert" className="banner">
                {state.error.message}
              </p>
            )}
            <div className="setup-layout">
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
              <aside className="setup-aside">
                <details className="panel">
                  <summary>Audio check (mic, VAD, test tone)</summary>
                  <AudioCheck />
                </details>
                <section aria-labelledby="vendors-h" className="panel">
                  <h2 id="vendors-h">Where the conversation goes</h2>
                  <dl className="vendor-list">
                    {(['translate', 'realtime', 'cascade'] as const).map((m) => (
                      <Fragment key={m}>
                        <dt>{MODE_LABEL[m]}</dt>
                        <dd>{vendorsFor(m, cascadeProviders)?.join(', ') ?? 'not loaded'}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <p className="meta">
                    No audio is stored. Transcripts stay in this tab and are discarded at End unless you export them.
                  </p>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
    </>
  )
}
