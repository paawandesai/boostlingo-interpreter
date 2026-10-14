import { useState } from 'react'
import { getAccessToken, setAccessToken } from '../session/access'
import type { LanguagesResponse } from '../session/languages'
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
  onConfigure(c: { mode?: Mode; langA?: string; langB?: string; realtimeModel?: string }): void
  onSpeaker(s: SpeakerSide): void
  onStart(opts: { spokenNotice: boolean }): void
}

export function SetupPanel({ state, languages, models, cascadeProviders, onConfigure, onSpeaker, onStart }: Props) {
  const [token, setToken] = useState(getAccessToken)
  // Consent is per session: this panel remounts after every session, so it starts unticked.
  const [consented, setConsented] = useState(false)
  const [spoken, setSpoken] = useState(true)
  const pairLanguages = [state.langA, state.langB].map(
    (code) => languages?.languages.find((l) => l.code === code) ?? { code, name: code },
  )
  const name = (code: string) => languages?.languages.find((l) => l.code === code)?.name ?? code
  const pairKey = `${state.langA}|${state.langB}`
  return (
    <section aria-labelledby="setup-h" className="panel setup">
      <h2 id="setup-h">New session</h2>
      <div className="field">
        <span className="label">Mode</span>
        <ModeToggle value={state.mode} onChange={(mode) => onConfigure({ mode })} />
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
            onConfigure({ langA, langB })
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
        <p className="hint">Use headphones. The mic is muted while the interpreter speaks.</p>
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
