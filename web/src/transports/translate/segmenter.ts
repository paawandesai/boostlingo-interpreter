/**
 * gpt-realtime-translate streams both transcripts as continuous deltas with no turn events (G17,
 * probed live 2026-10-14), so the transcript lines are cut here. Pure apart from the times passed in.
 *
 * Rules: client VAD speech start opens a segment; source text goes to the newest segment and is
 * final once the speaker has stopped and no source text came for SOURCE_IDLE_MS. Target text goes to
 * the oldest segment whose target is not final, and is final once its source is final and no target
 * text came for TARGET_IDLE_MS. The cut is approximate: if the speaker keeps talking without a pause,
 * one segment's translation can spill into the next. The UI says so.
 */
import type { TransportEvent } from '../types'

export const SOURCE_IDLE_MS = 800
export const TARGET_IDLE_MS = 1500
/** A finished source with no translation after this long is closed empty, so the output checks flag it. */
export const NO_OUTPUT_MS = 8000

interface Segment {
  id: string
  source: string
  target: string
  speechEnd: number | null
  lastInput: number | null
  lastOutput: number | null
  sourceFinalAt: number | null
  targetFinal: boolean
  /** VAD marks held back until the segment has text, so noise never makes an empty line. */
  held: TransportEvent[]
}

export class TranslateSegmenter {
  private segments: Segment[] = []
  private n = 0
  private speaking = false

  private readonly prefix: string

  constructor(prefix = 'tr') {
    this.prefix = prefix
  }

  speechStart(t: number): TransportEvent[] {
    this.speaking = true
    const cur = this.current()
    // A noise blip that produced no text keeps its segment rather than leaving an empty line.
    const seg = cur && cur.sourceFinalAt === null && cur.source === '' ? cur : this.open()
    seg.speechEnd = null
    return this.release(seg, { type: 'mark', name: 'speech.start', t, utteranceId: seg.id })
  }

  speechEnd(t: number): TransportEvent[] {
    this.speaking = false
    const seg = this.current()
    if (!seg || seg.sourceFinalAt !== null) return []
    seg.speechEnd = t
    return this.release(seg, { type: 'mark', name: 'speech.end', t, utteranceId: seg.id })
  }

  inputDelta(delta: string, t: number): TransportEvent[] {
    let seg = this.current()
    if (!seg || seg.sourceFinalAt !== null) seg = this.open()
    const held = seg.held
    seg.held = []
    seg.source += delta
    seg.lastInput = t
    return [...held, { type: 'transcript', role: 'source', utteranceId: seg.id, text: seg.source.trim(), final: false }]
  }

  /** `first` is true on the first target text of a segment, which arms the first-audio probe. */
  outputDelta(delta: string, t: number): { events: TransportEvent[]; first: string | null } {
    const seg = this.segments.find((s) => !s.targetFinal) ?? this.open()
    const first = seg.target === '' ? seg.id : null
    seg.target += delta
    seg.lastOutput = t
    return {
      events: [{ type: 'transcript', role: 'target', utteranceId: seg.id, text: seg.target.trim(), final: false }],
      first,
    }
  }

  /** Call on a timer; closes segments whose idle windows have passed. */
  tick(t: number): TransportEvent[] {
    const out: TransportEvent[] = []
    for (const s of this.segments) {
      if (s.sourceFinalAt === null && this.sourceDone(s, t)) {
        s.sourceFinalAt = t
        if (s.source === '' && s.target === '') {
          s.targetFinal = true // nothing was said: dropped without a line
          continue
        }
        out.push({ type: 'transcript', role: 'source', utteranceId: s.id, text: s.source.trim(), final: true })
      }
      if (s.sourceFinalAt === null || s.targetFinal) continue
      const idle = s.lastOutput !== null && t - s.lastOutput >= TARGET_IDLE_MS
      const none = s.target === '' && t - s.sourceFinalAt >= NO_OUTPUT_MS
      if (idle || none) {
        s.targetFinal = true
        out.push({ type: 'transcript', role: 'target', utteranceId: s.id, text: s.target.trim(), final: true })
      }
    }
    // Finished segments are only kept until nothing can reach them.
    this.segments = this.segments.filter((s) => !(s.targetFinal && s.sourceFinalAt !== null))
    return out
  }

  /** The connection closed: every open line gets its final text now. */
  flush(): TransportEvent[] {
    const out: TransportEvent[] = []
    for (const s of this.segments) {
      if (s.source === '' && s.target === '') continue
      if (s.sourceFinalAt === null)
        out.push({ type: 'transcript', role: 'source', utteranceId: s.id, text: s.source.trim(), final: true })
      if (!s.targetFinal)
        out.push({ type: 'transcript', role: 'target', utteranceId: s.id, text: s.target.trim(), final: true })
    }
    this.segments = []
    this.speaking = false
    return out
  }

  private sourceDone(s: Segment, t: number): boolean {
    // A segment that is no longer the newest stopped being spoken into.
    const ended = s !== this.current() || !this.speaking
    if (!ended) return false
    const last = Math.max(s.lastInput ?? 0, s.speechEnd ?? 0)
    return s.source !== '' ? t - last >= SOURCE_IDLE_MS : t - last >= NO_OUTPUT_MS
  }

  private release(seg: Segment, mark: TransportEvent): TransportEvent[] {
    if (seg.source !== '') return [mark]
    seg.held.push(mark)
    return []
  }

  private current(): Segment | undefined {
    return this.segments.at(-1)
  }

  private open(): Segment {
    const seg: Segment = {
      id: `${this.prefix}${++this.n}`,
      source: '',
      target: '',
      speechEnd: null,
      lastInput: null,
      lastOutput: null,
      sourceFinalAt: null,
      targetFinal: false,
      held: [],
    }
    this.segments.push(seg)
    return seg
  }
}
