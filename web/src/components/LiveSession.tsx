import type { LanguagesResponse } from '../session/languages'
import type { SessionState, Utterance } from '../session/store'
import type { Mode, SpeakerSide } from '../transports/types'
import { ErrorBanner } from './ErrorBanner'
import { LatencyPanel } from './LatencyPanel'
import { ModeToggle } from './ModeToggle'
import { SpeakerSideToggle } from './SpeakerSideToggle'
import { TranscriptColumn } from './TranscriptColumn'

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
  const statusText =
    state.status === 'connecting' ? 'Connecting' : state.gated ? 'Interpreter speaking (mic muted)' : 'Listening'
  return (
    <>
      <header className="panel topbar">
        {/* Switching stops the old transport, then starts the other mode; the transcript stays (T3.3). */}
        <ModeToggle value={state.mode} onChange={onSwitchMode} />
        <div role="status" className="status">
          <span
            className={`lamp ${state.error ? 'err' : state.status === 'live' ? 'ok' : 'warn'}`}
            aria-hidden="true"
          />
          <strong>{state.error ? 'Error' : statusText}</strong>
          <span className="meta">
            · {name(state.langA)} ↔ {name(state.langB)}
          </span>
        </div>
        <meter min={0} max={0.3} value={state.level} aria-label="Input level" />
        <button type="button" onClick={onExport}>
          Export log
        </button>
        <button type="button" onClick={onRequestHuman}>
          Request human interpreter
        </button>
        <button type="button" className="danger" onClick={onEnd}>
          End
        </button>
      </header>
      {state.error && <ErrorBanner error={state.error} onRetry={onRetry} onDismiss={onDismissError} />}
      {state.notice && (
        <p role="status" className="banner info">
          {state.notice}
        </p>
      )}
      <section aria-label="Transcripts" className="columns">
        <TranscriptColumn title="Source" role="source" timeline={state.timeline} />
        <TranscriptColumn title="Target" role="target" timeline={state.timeline} />
      </section>
      <SpeakerSideToggle
        value={state.speaker}
        onChange={onSpeaker}
        nameA={name(state.langA)}
        nameB={name(state.langB)}
      />
      <LatencyPanel utterances={utterances} />
    </>
  )
}
