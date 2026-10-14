import type { LanguageInfo } from '../session/languages'

interface Props {
  languages: LanguageInfo[]
  /** Vendors that will receive the conversation; null while unknown. */
  vendors: string[] | null
  consented: boolean
  onConsent(v: boolean): void
  spoken: boolean
  onSpoken(v: boolean): void
}

/**
 * Consent step before the mic opens (G7). Both parties must be told, in their own language, that
 * third-party AI processes and may transcribe the audio. California and other all-party-consent
 * states require everyone's consent before a conversation is recorded or transcribed.
 */
export function ConsentNotice({ languages, vendors, consented, onConsent, spoken, onSpoken }: Props) {
  return (
    <div className="field consent">
      <span className="label">Before you start, read this to both parties</span>
      {languages.map((l) => (
        <p key={l.code} lang={l.code} className="notice">
          {l.disclosure?.notice ?? `${l.name}: no notice configured for this language.`}
        </p>
      ))}
      <p className="hint">
        Audio and text in this mode go to: {vendors ? vendors.join(', ') : 'the providers configured on the server'}.
      </p>
      <label className="check">
        <input type="checkbox" checked={consented} onChange={(e) => onConsent(e.target.checked)} />
        Both parties were told and agree to AI interpretation
      </label>
      <label className="check">
        <input type="checkbox" checked={spoken} onChange={(e) => onSpoken(e.target.checked)} />
        Read the notice aloud in both languages when the session starts
      </label>
    </div>
  )
}
