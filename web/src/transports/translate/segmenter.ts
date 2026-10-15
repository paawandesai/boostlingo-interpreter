/**
 * gpt-realtime-translate streams both transcripts as continuous deltas with no turn events (G17,
 * probed live 2026-10-14), so the transcript lines are cut here. Pure apart from the times passed in.
 *
 * Both streams carry elapsed_ms, the position in the input audio when the delta was produced, so
 * they share one clock. A translated sentence belongs to the latest source sentence that had started
 * by the time the translation started. Source sentences with no translation of their own stay in the
 * line that gets the next one, so "Interpreter. Can you summarize…?" stays one line when the model
 * renders it as one. A line closes when a later line gets its translation, or after STALL_MS of
 * silence; a line still without a translation then closes empty, which the output checks flag.
 * Pairing by sentence count, by client VAD pauses, or closing lines at every pause all misattributed
 * translations in runner soaks (2026-10-14); a recorded live stream pairs all ten sentences this way.
 *
 * Latency marks: every line gets the client time its first source and first translated text arrived
 * (text lag). Speech after a pause opens its own line with the client VAD speech start, and the first
 * audible output after it, measured only when nothing was playing (start lag).
 */
import type { TransportEvent } from '../types'

/** Input quiet this long before speech starts: a pause, so the speech starts a new line with its own start mark. */
export const PAUSE_MS = 1500
/**
 * Both streams quiet this long: close every open line. Long, because the model can hold a sentence's
 * translation until the speaker goes on (a paced soak closed "Thank you, interpreter." after a 4 s
 * pause, and its translation then arrived with the next sentence).
 */
export const STALL_MS = 8000
/** Output quiet this long at a speech start: the next audible frame belongs to the new speech. */
export const OUTPUT_IDLE_MS = 800

const SENTENCE_END = /[.?!。？！…]["'»”)\]]*\s*$/

interface Sentence {
  text: string
  /** Input-audio position (elapsed_ms, else client time) of its first delta. */
  at: number
  /** Client time of its first delta. */
  wall: number
}

interface Line {
  id: string
  sentences: Sentence[]
  target: string
  speechStart: number | null
  /** Index of the last source sentence a translation was matched to; -1 before any. */
  matched: number
  final: boolean
}

export class TranslateSegmenter {
  private lines: Line[] = []
  private n = 0
  private speaking = false
  private lastInput = -Infinity
  private lastOutput = -Infinity
  private lastSpeech = -Infinity
  /** The line the current translated sentence is going to; null between sentences. */
  private outLine: Line | null = null
  /** Speech start after a pause, waiting for the source text that opens its line. */
  private pausedStart: number | null = null
  private ends: number[] = []
  private firstAudio = new Map<number, number>()
  private readonly prefix: string

  constructor(prefix = 'tr') {
    this.prefix = prefix
  }

  /** True when the transport should stamp the next audible frame as this start's first audio. */
  speechStart(t: number): boolean {
    const paused = t - Math.max(this.lastInput, this.lastSpeech) >= PAUSE_MS
    this.speaking = true
    this.lastSpeech = t
    if (!paused) return false
    this.pausedStart = t
    return t - this.lastOutput >= OUTPUT_IDLE_MS
  }

  speechEnd(t: number): void {
    this.speaking = false
    this.lastSpeech = t
    this.ends.push(t)
  }

  /** The first audible frame after the speech start `start`. */
  audioOut(start: number, t: number): TransportEvent[] {
    this.firstAudio.set(start, t)
    const line = this.lines.find((l) => l.speechStart === start)
    return line ? [{ type: 'mark', name: 'audio.first_out', t, utteranceId: line.id }] : []
  }

  inputDelta(delta: string, t: number, at = t): TransportEvent[] {
    this.lastInput = t
    const out: TransportEvent[] = []
    let line = this.lines.at(-1)
    const last0 = line?.sentences.at(-1)
    // Speech after a pause opens its own line, unless it only finishes the sentence before it.
    const pauseLine = this.pausedStart !== null && !(last0 && !SENTENCE_END.test(last0.text))
    if (!line || line.final || (pauseLine && line.sentences.length > 0)) line = this.newLine()
    if (pauseLine) out.push(...this.startMarks(line))
    else this.pausedStart = null
    const last = line.sentences.at(-1)
    // A new sentence starts only after a sentence end and a space: "2." + "5 mg" and "cost?" + "?" stay one.
    if (last && (!SENTENCE_END.test(last.text) || !/^\s/.test(delta))) last.text += delta
    else {
      line.sentences.push({ text: delta, at, wall: t })
      if (line.sentences.length === 1) out.push({ type: 'mark', name: 'source.first_text', t, utteranceId: line.id })
    }
    out.push(this.source(line, false))
    return out
  }

  outputDelta(delta: string, t: number, at = t): TransportEvent[] {
    const out: TransportEvent[] = []
    // A translated sentence the model never punctuated ends at the next burst.
    if (this.outLine && t - this.lastOutput >= PAUSE_MS) this.outLine = null
    this.lastOutput = t
    if (!this.outLine) out.push(...this.assign(at))
    const line = this.outLine!
    if (line.target === '') out.push({ type: 'mark', name: 'target.first_text', t, utteranceId: line.id })
    line.target += delta
    if (SENTENCE_END.test(line.target)) this.outLine = null
    out.push({ type: 'transcript', role: 'target', utteranceId: line.id, text: line.target.trim(), final: false })
    return out
  }

  /**
   * Call on a timer. Lines normally close when a later line gets its translation; this closes the rest
   * once everything has been quiet for STALL_MS.
   */
  tick(t: number): TransportEvent[] {
    if (this.lines.length === 0 || this.speaking) return []
    return t - Math.max(this.lastInput, this.lastSpeech, this.lastOutput) >= STALL_MS ? this.flush() : []
  }

  /** The connection closed or both sides paused: every open line gets its final text now. */
  flush(): TransportEvent[] {
    const out = this.lines.flatMap((l, i) => this.finish(l, this.lines[i + 1]))
    this.lines = []
    this.outLine = null
    return out
  }

  /** Points outLine at the line a new translated sentence belongs to; returns the events that causes. */
  private assign(at: number): TransportEvent[] {
    const out: TransportEvent[] = []
    let line: Line | undefined
    let idx = -1
    for (const l of this.lines)
      l.sentences.forEach((s, i) => {
        if (s.at <= at) {
          line = l
          idx = i
        }
      })
    if (!line) {
      // Translation ahead of any source text: the oldest open line, or a new one the source will fill.
      line = this.lines[0] ?? this.newLine()
      // With no source yet, the first sentence still to come is the one being translated.
      idx = Math.max(0, line.sentences.length - 1)
      if (this.pausedStart !== null && line.sentences.length === 0) out.push(...this.startMarks(line))
    } else if (line.target !== '' && idx > line.matched) {
      // The line already has a translation for its earlier sentences: these start a new line.
      idx -= line.matched + 1
      line = this.splitAfter(line, line.matched, out)
    }
    line.matched = Math.max(line.matched, idx)
    // Sentences after the one being translated were spoken later: they move to a new line.
    if (idx < line.sentences.length - 1) this.splitAfter(line, idx, out)
    // Everything before this line is done: the model has moved on.
    const pos = this.lines.indexOf(line)
    for (let i = 0; i < pos; i++) out.push(...this.finish(this.lines[i], this.lines[i + 1]))
    this.lines = this.lines.slice(pos)
    this.outLine = line
    return out
  }

  private splitAfter(line: Line, k: number, out: TransportEvent[]): Line {
    const rest = this.newLine(this.lines.indexOf(line) + 1)
    rest.sentences = line.sentences.splice(k + 1)
    out.push(this.source(line, false), this.source(rest, false))
    out.push({ type: 'mark', name: 'source.first_text', t: rest.sentences[0].wall, utteranceId: rest.id })
    return rest
  }

  private finish(line: Line, next: Line | undefined): TransportEvent[] {
    if (line.final) return []
    line.final = true
    if (line.sentences.length === 0 && line.target.trim() === '') return []
    const out: TransportEvent[] = []
    if (line.speechStart !== null) {
      // Its speech ends before the next line's speech (or, failing that, its first text) begins.
      const until = next?.speechStart ?? next?.sentences[0]?.wall ?? Infinity
      const end = this.ends.filter((e) => e > line.speechStart! && e < until).at(-1)
      if (end !== undefined) out.push({ type: 'mark', name: 'speech.end', t: end, utteranceId: line.id })
    }
    out.push(this.source(line, true), {
      type: 'transcript',
      role: 'target',
      utteranceId: line.id,
      text: line.target.trim(),
      final: true,
    })
    return out
  }

  private startMarks(line: Line): TransportEvent[] {
    const start = this.pausedStart!
    this.pausedStart = null
    line.speechStart = start
    const out: TransportEvent[] = [{ type: 'mark', name: 'speech.start', t: start, utteranceId: line.id }]
    const audio = this.firstAudio.get(start)
    if (audio !== undefined) out.push({ type: 'mark', name: 'audio.first_out', t: audio, utteranceId: line.id })
    return out
  }

  private source(line: Line, final: boolean): TransportEvent {
    const text = line.sentences
      .map((s) => s.text)
      .join('')
      .trim()
    return { type: 'transcript', role: 'source', utteranceId: line.id, text, final }
  }

  private newLine(at = this.lines.length): Line {
    const line: Line = {
      id: `${this.prefix}${++this.n}`,
      sentences: [],
      target: '',
      speechStart: null,
      matched: -1,
      final: false,
    }
    this.lines.splice(at, 0, line)
    return line
  }
}
