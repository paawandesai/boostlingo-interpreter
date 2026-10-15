import { MODE_LABEL } from '../session/modes'
import type { Mode } from '../transports/types'

const modes: Mode[] = ['translate', 'realtime', 'cascade']

/** One-line description under each mode on the setup screen. */
const DESCRIPTION: Record<Mode, string> = {
  translate: 'Speech in, speech out, no instructions',
  realtime: 'Instructed speech model',
  cascade: 'Speech-to-text → translate → speech',
}

export function ModeToggle({
  value,
  onChange,
  disabled,
  translateAvailable = true,
  described = false,
}: {
  value: Mode
  onChange(m: Mode): void
  disabled?: boolean
  /** gpt-realtime-translate can't speak one of the pair's languages (config/languages.json). */
  translateAvailable?: boolean
  /** Show a description under each mode (setup screen); the accessible name stays the mode's name. */
  described?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Mode" className={described ? 'segmented described' : 'segmented'}>
      {modes.map((m) => {
        const available = m !== 'translate' || translateAvailable
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            disabled={disabled || !available}
            title={available ? undefined : 'gpt-realtime-translate does not support this language pair'}
            onClick={() => onChange(m)}
            aria-label={described ? MODE_LABEL[m] : undefined}
          >
            {described ? (
              <>
                <span className="mode-name">{MODE_LABEL[m]}</span>
                <span className="mode-desc">{DESCRIPTION[m]}</span>
              </>
            ) : (
              MODE_LABEL[m]
            )}
          </button>
        )
      })}
    </div>
  )
}
