/**
 * gpt-realtime-translate streams both transcripts as continuous deltas with no turn events (G17,
 * probed live 2026-10-14), so the transcript lines are cut here. Pure apart from the times passed in.
 *
 * Both streams carry elapsed_ms, the position in the input audio when the delta was produced, so
 * they share one clock. A translated sentence belongs to the latest source sentence that had started
 * by the time the translation started. Source sentences with no translation of their own stay in the
 * line that gets the next one, so "Interpreter. Can you summarize…?" stays one line when the model
 * renders it as one. A recorded 10-clip stream paired every sentence this way; pairing by sentence
 * count or by client VAD pauses did not (first soak run, 2026-10-14). When both sides have been quiet
 * for RESYNC_MS every open line closes; a line still without a translation closes empty, which the
 * output checks flag as an omission.
 *
 * Latency marks: every line gets the client time its first source and first translated text arrived
 * (text lag). A line that starts after a pause also gets the client VAD speech start, and the first
 * audible output after it, which is only measured when nothing was playing (start lag).
 */
import type { TransportEvent } from '../types'

/** Both streams quiet this long: close every open line. */
export const RESYNC_MS = 1500
/** Both streams quiet this long mid-sentence: close anyway (the model may never finish it). */
export const STALL_MS = 5000
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
  /** Client VAD starts not yet given to a line, and speech ends. */
  private starts: number[] = []
  private ends: number[] = []
  private firstAudio = new Map<number, number>()
  private readonly prefix: string

  constructor(prefix = 'tr') {
    this.prefix = prefix
  }

  /** True when the transport should stamp the next audible frame as this start's first audio. */
  speechStart(t: number): boolean {
    this.speaking = true
    this.lastSpeech = t
    this.starts.push(t)
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
    if (!line || line.final) {
      line = this.newLine()
      out.push(...this.startMarks(line))
    }
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
    this.lastOutput = t
    const out: TransportEvent[] = []
    if (!this.outLine) out.push(...this.assign(at))
    const line = this.outLine!
    if (line.target === '') out.push({ type: 'mark', name: 'target.first_text', t, utteranceId: line.id })
    line.target += delta
    if (SENTENCE_END.test(line.target)) this.outLine = null
    out.push({ type: 'transcript', role: 'target', utteranceId: line.id, text: line.target.trim(), final: false })
    return out
  }

  /**
   * Call on a timer: once both sides have paused at a sentence end, every open line is closed. The
   * model's transcripts arrive in bursts, so a pause mid-sentence waits up to STALL_MS (a paced soak
   * cut "…tell me a | joke." when this only looked at the pause).
   */
  tick(t: number): TransportEvent[] {
    if (this.lines.length === 0 || this.speaking) return []
    const quiet = t - Math.max(this.lastInput, this.lastSpeech, this.lastOutput)
    const last = this.lines.at(-1)!.sentences.at(-1)
    const atSentenceEnd = this.outLine === null && (last === undefined || SENTENCE_END.test(last.text))
    if (quiet >= STALL_MS || (atSentenceEnd && quiet >= RESYNC_MS)) return this.flush()
    return []
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
      if (this.lines.length === 1 && line.sentences.length === 0) out.push(...this.startMarks(line))
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

  /** Only the first line after a pause has a speech start of its own; later ones run on from it. */
  private startMarks(line: Line): TransportEvent[] {
    if (this.lines.some((l) => l !== line && !l.final) || this.starts.length === 0) return []
    const start = this.starts[0]
    this.starts = []
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
