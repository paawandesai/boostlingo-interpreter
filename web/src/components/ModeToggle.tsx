import { MODE_LABEL } from '../session/modes'
import type { Mode } from '../transports/types'

const modes: Mode[] = ['translate', 'realtime', 'cascade']

export function ModeToggle({
  value,
  onChange,
  disabled,
  translateAvailable = true,
}: {
  value: Mode
  onChange(m: Mode): void
  disabled?: boolean
  /** gpt-realtime-translate can't speak one of the pair's languages (config/languages.json). */
  translateAvailable?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Mode" className="segmented">
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
          >
            {MODE_LABEL[m]}
          </button>
        )
      })}
    </div>
  )
}
