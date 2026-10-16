import { useState } from 'react'
import { translateSupported, type LanguagesResponse } from '../session/languages'
import type { SessionState, Utterance } from '../session/store'
import type { Mode, SpeakerSide } from '../transports/types'
import { ErrorBanner } from './ErrorBanner'
import { LatencyPanel } from './LatencyPanel'
import { ModeToggle } from './ModeToggle'
import { SpeakerSideToggle } from './SpeakerSideToggle'
import { TranscriptColumn } from './TranscriptColumn'
import { checkContext, checkUtterance } from '../session/outputChecks'

interface Props {
  state: SessionState
  languages: LanguagesResponse | null
  onSpeaker(s: SpeakerSide): void
  onEnd(): void
  onRetry(): void
  onDismissError(): void
  onRequestHuman(): void
  onSwitchMode(m: Mode): void
  onExport(): void
}

export function LiveSession({
  state,
  languages,
  onSpeaker,
  onEnd,
  onRetry,
  onDismissError,
  onRequestHuman,
  onSwitchMode,
  onExport,
}: Props) {
  const name = (code: string) => languages?.languages.find((l) => l.code === code)?.name ?? code
  const utterances = state.timeline.filter((x): x is Utterance => x.kind === 'utterance')
  const checks = checkContext(languages, state.langA, state.langB)
  // G20: End discards the transcript, so it asks first when there is something not yet exported.
  const [exportedCount, setExportedCount] = useState(0)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const statusText =
    state.status === 'connecting' ? 'Connecting' : state.gated ? 'Interpreter speaking (mic muted)' : 'Listening'
  const lampKind = state.error ? 'err' : state.status === 'live' && !state.gated ? 'ok' : 'warn'
  return (
    <>
      <header className="topbar">
        <span className="title">AI Interpreter Workbench</span>
        {/* Switching stops the old transport, then starts the other mode; the transcript stays (T3.3). */}
        <ModeToggle
          value={state.mode}
          onChange={onSwitchMode}
          translateAvailable={translateSupported(languages, state.langA, state.langB)}
          blocked={languages?.blockedModes}
        />
        <div role="status" className={`status ${lampKind}`}>
          <span className={`lamp ${lampKind}`} aria-hidden="true" />
          {state.error ? 'Error' : statusText}
        </div>
        <span className="meta">
          {name(state.langA)} ↔ {name(state.langB)}
        </span>
        <div className="topbar-actions">
          <button
            type="button"
            aria-describedby="export-note"
            onClick={() => {
              onExport()
              setExportedCount(utterances.length)
            }}
          >
            Export log
          </button>
          <button type="button" className="outline-accent" onClick={onRequestHuman}>
            Request human interpreter
          </button>
          <button
            type="button"
            className="end"
            aria-describedby="end-note"
            onClick={() => (utterances.length > exportedCount ? setConfirmEnd(true) : onEnd())}
          >
            End
          </button>
        </div>
      </header>
      <p className="meta end-note">
        <span id="export-note">The export holds the full transcript; use it only for scripted test sessions.</span>{' '}
        <span id="end-note">Ending discards the transcript. Export the log first to keep it.</span>
      </p>
      <div className="live-body">
        {confirmEnd && (
          <div role="alertdialog" aria-label="End session" className="banner info">
            <div>
              <strong>Ending discards the transcript.</strong>
              <span className="meta">Nothing said in this session is kept unless you export the log first.</span>
            </div>
            <div className="banner-actions">
              <button
                type="button"
                onClick={() => {
                  onExport()
                  setExportedCount(utterances.length)
                  setConfirmEnd(false)
                }}
              >
                Export log first
              </button>
              <button type="button" className="danger" onClick={onEnd}>
                End and discard
              </button>
              <button type="button" onClick={() => setConfirmEnd(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {state.error && <ErrorBanner error={state.error} onRetry={onRetry} onDismiss={onDismissError} />}
        {state.notice && (
          <p role="status" className="banner info">
            {state.notice}
          </p>
        )}
        <section aria-label="Transcripts" className="columns">
          <TranscriptColumn title="Source" role="source" timeline={state.timeline} />
          <div className="speaker-col">
            <span className="meta">Who is speaking</span>
            <SpeakerSideToggle
              value={state.speaker}
              onChange={onSpeaker}
              nameA={name(state.langA)}
              nameB={name(state.langB)}
            />
            <meter min={0} max={0.3} value={state.level} aria-label="Input level" />
          </div>
          <TranscriptColumn
            title="Target"
            role="target"
            timeline={state.timeline}
            flagsFor={(u) => checkUtterance(u, state.langA, state.langB, checks)}
            onRequestHuman={onRequestHuman}
          />
        </section>
        <LatencyPanel utterances={utterances} />
      </div>
    </>
  )
}
