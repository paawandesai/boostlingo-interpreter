import type { Marker, Utterance } from '../session/store'

export function TranscriptColumn({
  title,
  role,
  timeline,
}: {
  title: string
  role: 'source' | 'target'
  timeline: Array<Utterance | Marker>
}) {
  return (
    <div className="panel transcript">
      <h2>{title}</h2>
      <ol aria-live="polite" aria-relevant="additions">
        {timeline.map((item, i) =>
          item.kind === 'marker' ? (
            <li key={item.id} role="separator" className="marker">
              {item.text}
            </li>
          ) : (
            <li key={item.id}>
              <span className="meta">
                #{i + 1} · {item.side} · {item.mode}
                {item[role].final ? '' : ' · partial'}
              </span>
              <span className={item[role].final ? 'final' : 'partial'} aria-hidden={!item[role].final}>
                {item[role].text || '…'}
              </span>
            </li>
          ),
        )}
      </ol>
    </div>
  )
}
