import { LOW_CONFIDENCE, type Marker, type Utterance } from '../session/store'

/** Source-line flags (G7, G8): Realtime's source text comes from a separate ASR model with no confidence. */
function sourceFlags(u: Utterance): string {
  if (u.mode === 'realtime') return ' · approximate (separate ASR), confidence unknown'
  const c = u.source.confidence
  if (c === undefined) return u.source.final ? ' · confidence unknown' : ''
  return c < LOW_CONFIDENCE ? ` · low confidence (${c.toFixed(2)}), check with the speaker` : ''
}

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
                {role === 'source' ? sourceFlags(item) : ''}
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
