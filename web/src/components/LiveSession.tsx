import type { LanguagesResponse } from '../session/languages'
import { headlineLatencyMs, type SessionState, type Utterance } from '../session/store'
import type { SpeakerSide } from '../transports/types'
import { ErrorBanner } from './ErrorBanner'
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
}

export function LiveSession({ state, languages, onSpeaker, onEnd, onRetry, onDismissError }: Props) {
  const name = (code: string) => languages?.languages.find((l) => l.code === code)?.name ?? code
  const utterances = state.timeline.filter((x): x is Utterance => x.kind === 'utterance')
  const statusText =
    state.status === 'connecting' ? 'Connecting' : state.gated ? 'Interpreter speaking (mic muted)' : 'Listening'
  return (
    <>
      <header className="panel topbar">
        {/* Mid-session switching is T3.3; until then the toggle shows the mode in use. */}
        <ModeToggle value={state.mode} onChange={() => {}} disabled />
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
        <button type="button" className="danger" onClick={onEnd}>
          End
        </button>
      </header>
      {state.error && <ErrorBanner error={state.error} onRetry={onRetry} onDismiss={onDismissError} />}
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
      <section aria-labelledby="lat-h" className="panel">
        <h2 id="lat-h">Latency: speech end → first audio out</h2>
        <ul className="latency">
          {utterances.map((u, i) => {
            const ms = headlineLatencyMs(u)
            return (
              <li key={u.id}>
                #{i + 1} · {u.mode} · {ms === null ? 'pending' : `${Math.round(ms)} ms`}
              </li>
            )
          })}
        </ul>
        <p className="hint">
          Realtime exposes endpointing, response.created and first audio only; model-internal time is opaque. The
          per-stage waterfall lands in T3.2.
        </p>
      </section>
    </>
  )
}
