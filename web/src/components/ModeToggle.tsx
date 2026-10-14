import type { Mode } from '../transports/types'

const modes: Array<{ value: Mode; label: string; available: boolean }> = [
  { value: 'realtime', label: 'Realtime', available: true },
  { value: 'cascade', label: 'Cascade', available: false },
]

export function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: Mode
  onChange(m: Mode): void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Mode" className="segmented">
      {modes.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          disabled={disabled || !m.available}
          title={m.available ? undefined : 'Cascade mode lands on Day 2'}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
