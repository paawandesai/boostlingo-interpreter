import { FLAG_TEXT, type CheckFlag } from '../session/outputChecks'
import { LOW_CONFIDENCE, type Marker, type Utterance } from '../session/store'

/** Source-line flags (G7, G8): Realtime's source text comes from a separate ASR model with no confidence. */
function sourceFlags(u: Utterance): string {
  if (u.mode === 'realtime') return ' · approximate (separate ASR), confidence unknown'
  if (u.mode === 'translate') return ' · approximate (model transcript, line breaks estimated), confidence unknown'
  const c = u.source.confidence
  if (c === undefined) return u.source.final ? ' · confidence unknown' : ''
  return c < LOW_CONFIDENCE ? ` · low confidence (${c.toFixed(2)}), check with the speaker` : ''
}

/** Lines rendered per column; older ones stay in the store and the export (T3.6 soak: flat page size). */
const TRANSCRIPT_LINES = 40

/** Shown in place of a refusal (G15): never a silent omission. */
export const DECLINED = '[segment not interpreted — model declined]'

export function TranscriptColumn({
  title,
  role,
  timeline,
  flagsFor,
  onRequestHuman,
}: {
  title: string
  role: 'source' | 'target'
  timeline: Array<Utterance | Marker>
  /** Output-check flags for a target line (G15). */
  flagsFor?: (u: Utterance) => CheckFlag[]
  onRequestHuman?: () => void
}) {
  return (
    <div className="panel transcript">
      <h2>{title}</h2>
      {timeline.length > TRANSCRIPT_LINES && (
        <p className="meta">
          {timeline.length - TRANSCRIPT_LINES} earlier lines hidden; Export log has the whole session.
        </p>
      )}
      <ol aria-live="polite" aria-relevant="additions">
        {timeline.slice(-TRANSCRIPT_LINES).map((item, j, shown) =>
          item.kind === 'marker' ? (
            <li key={item.id} role="separator" className="marker">
              {item.text}
            </li>
          ) : (
            <Line
              key={item.id}
              n={timeline.length - shown.length + j + 1}
              item={item}
              role={role}
              flags={role === 'target' ? (flagsFor?.(item) ?? []) : []}
              onRequestHuman={onRequestHuman}
            />
          ),
        )}
      </ol>
    </div>
  )
}

function Line({
  n,
  item,
  role,
  flags,
  onRequestHuman,
}: {
  n: number
  item: Utterance
  role: 'source' | 'target'
  flags: CheckFlag[]
  onRequestHuman?: () => void
}) {
  const declined = flags.includes('refusal')
  const omitted = flags.includes('omission')
  const text = item[role].text
  // Text is rendered by React as text nodes (textContent), never as HTML: speech can contain markup.
  return (
    <li className={flags.length ? 'flagged' : undefined}>
      <span className="meta">
        #{n} · {item.side} · {item.mode}
        {item[role].final ? '' : ' · partial'}
        {role === 'source' ? sourceFlags(item) : ''}
        {role === 'target' && item.audioFailed ? ' · audio failed, text only' : ''}
      </span>
      {declined || omitted ? (
        <span className="final">{declined ? DECLINED : '[segment not interpreted]'}</span>
      ) : (
        <span className={item[role].final ? 'final' : 'partial'} aria-hidden={!item[role].final}>
          {text || '…'}
        </span>
      )}
      {flags.length > 0 && (
        <span role="note" className="check-flag">
          Possibly not a translation: {flags.map((f) => FLAG_TEXT[f]).join('; ')}.
          {declined && text && <span className="meta"> Model output: “{text}”</span>}
          {onRequestHuman && (
            <button type="button" onClick={onRequestHuman}>
              Request human interpreter
            </button>
          )}
        </span>
      )}
    </li>
  )
}
