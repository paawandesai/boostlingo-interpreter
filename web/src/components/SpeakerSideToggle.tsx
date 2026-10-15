import type { SpeakerSide } from '../transports/types'

export function SpeakerSideToggle({
  value,
  onChange,
  nameA,
  nameB,
}: {
  value: SpeakerSide
  onChange(s: SpeakerSide): void
  nameA: string
  nameB: string
}) {
  return (
    <div role="group" aria-label="Who is speaking" className="speaker-toggle">
      <button type="button" aria-pressed={value === 'A'} onClick={() => onChange('A')}>
        A · {nameA}
      </button>
      <button type="button" aria-pressed={value === 'B'} onClick={() => onChange('B')}>
        B · {nameB}
      </button>
    </div>
  )
}
