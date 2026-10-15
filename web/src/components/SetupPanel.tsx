import { useState } from 'react'
import { decodeClips, type ReplayClip } from '../audio/replay'
import { getAccessToken, setAccessToken } from '../session/access'
import { translateSupported, type LanguagesResponse } from '../session/languages'
import type { CascadeProviders } from '../session/providers'
import { vendorsFor } from '../session/providers'
import type { RealtimeModels } from '../session/models'
import type { SessionState } from '../session/store'
import type { Mode, SpeakerSide } from '../transports/types'
import { ConsentNotice } from './ConsentNotice'
import { ModeToggle } from './ModeToggle'
import { SpeakerSideToggle } from './SpeakerSideToggle'

interface Props {
  state: SessionState
  languages: LanguagesResponse | null
  models: RealtimeModels | null
  cascadeProviders: CascadeProviders | null
  onConfigure(c: { mode?: Mode; langA?: string; langB?: string; realtimeModel?: string; glossary?: boolean }): void
  /** Configured glossary size; null when the server has none. */
  glossaryTerms: number | null
  onSpeaker(s: SpeakerSide): void
  onStart(opts: { spokenNotice: boolean }): void
  /** Replay clips used as input instead of the mic (T3.6); empty means the mic. */
  replay: ReplayClip[]
  onReplay(clips: ReplayClip[]): void
}

export function SetupPanel({
  state,
  languages,
  models,
  cascadeProviders,
  glossaryTerms,
  onConfigure,
  onSpeaker,
  onStart,
  replay,
  onReplay,
}: Props) {
  const [replayError, setReplayError] = useState<string | null>(null)
  const [token, setToken] = useState(getAccessToken)
  // Consent is per session: this panel remounts after every session, so it starts unticked.
  const [consented, setConsented] = useState(false)
  const [spoken, setSpoken] = useState(true)
  const pairLanguages = [state.langA, state.langB].map(
    (code) => languages?.languages.find((l) => l.code === code) ?? { code, name: code },
  )
  const name = (code: string) => languages?.languages.find((l) => l.code === code)?.name ?? code
  const pairKey = `${state.langA}|${state.langB}`
  const canTranslate = translateSupported(languages, state.langA, state.langB)
  return (
    <section aria-labelledby="setup-h" className="panel setup">
      <h2 id="setup-h">New session</h2>
      <div className="field">
        <span className="label">Mode</span>
        <ModeToggle value={state.mode} onChange={(mode) => onConfigure({ mode })} translateAvailable={canTranslate} />
      </div>
      <div className="field">
        <label htmlFor="pair" className="label">
          Language pair
        </label>
        <select
          id="pair"
          value={pairKey}
          onChange={(e) => {
            const [langA, langB] = e.target.value.split('|')
            // G17: Realtime translate is the default wherever the pair supports it.
            const mode = translateSupported(languages, langA, langB)
              ? 'translate'
              : state.mode === 'translate'
                ? 'realtime'
                : state.mode
            onConfigure({ langA, langB, mode })
          }}
        >
          {(languages?.pairs ?? [[state.langA, state.langB]]).map(([a, b]) => (
            <option key={`${a}|${b}`} value={`${a}|${b}`}>
              {name(a)} ↔ {name(b)}
            </option>
          ))}
        </select>
      </div>
      {state.mode === 'realtime' && models && (
        <div className="field">
          <label htmlFor="rt-model" className="label">
            Realtime model
          </label>
          <select
            id="rt-model"
            value={state.realtimeModel ?? models.default}
            onChange={(e) => onConfigure({ realtimeModel: e.target.value })}
          >
            {models.allowed.map((m) => (
              <option key={m} value={m}>
                {m === models.default ? `${m} (default)` : m}
              </option>
            ))}
          </select>
        </div>
      )}
      {glossaryTerms !== null && glossaryTerms > 0 && (
        <div className="field">
          <span className="label">Glossary</span>
          <label className="check">
            <input
              type="checkbox"
              checked={state.glossary}
              onChange={(e) => onConfigure({ glossary: e.target.checked })}
            />
            Use the medical glossary ({glossaryTerms} terms, same terms in both modes)
          </label>
        </div>
      )}
      <div className="field">
        <label htmlFor="replay-files" className="label">
          Input
        </label>
        <input
          id="replay-files"
          type="file"
          accept="audio/*"
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []).sort((a, b) => a.name.localeCompare(b.name))
            setReplayError(null)
            Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })))
              .then(decodeClips)
              .then(onReplay)
              .catch(() => {
                setReplayError('Could not decode one of those files.')
                onReplay([])
              })
          }}
        />
        <span className="meta">
          {replay.length > 0
            ? `Replaying ${replay.length} clip${replay.length === 1 ? '' : 's'} in a loop instead of the mic. Name files en-01.wav, es-01.wav, … to set the speaker side per clip.`
            : 'Microphone. Pick recorded clips to replay the same audio into either mode.'}
        </span>
        {replayError && <span role="alert">{replayError}</span>}
        {replay.length > 0 && (
          <button type="button" onClick={() => onReplay([])}>
            Use the microphone
          </button>
        )}
      </div>
      <div className="field">
        <label htmlFor="access-token" className="label">
          Access token
        </label>
        <input
          id="access-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => {
            setToken(e.target.value)
            setAccessToken(e.target.value)
          }}
          placeholder="The server's DEMO_ACCESS_TOKEN"
        />
      </div>
      <div className="field">
        <span className="label">Who speaks first</span>
        <SpeakerSideToggle
          value={state.speaker}
          onChange={onSpeaker}
          nameA={name(state.langA)}
          nameB={name(state.langB)}
        />
      </div>
      <ConsentNotice
        languages={pairLanguages}
        vendors={vendorsFor(state.mode, cascadeProviders)}
        consented={consented}
        onConsent={setConsented}
        spoken={spoken}
        onSpoken={setSpoken}
      />
      <div className="actions">
        <p className="hint">
          {state.mode === 'translate'
            ? 'Headphones required. Realtime translate speaks while you talk, so the mic stays open and a speaker would be translated again.'
            : 'Use headphones. The mic is muted while the interpreter speaks.'}
        </p>
        <button
          type="button"
          className="primary"
          disabled={!consented}
          title={consented ? undefined : 'Confirm both parties agreed first'}
          onClick={() => onStart({ spokenNotice: spoken })}
        >
          Start session
        </button>
      </div>
    </section>
  )
}
