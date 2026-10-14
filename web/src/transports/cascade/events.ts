/**
 * Maps cascade socket messages (D5, server/Interpreter.Api/Cascade/CascadeProtocol.cs) to transport events.
 * Pure apart from the clock. Utterance ids are prefixed per socket, because a speaker switch opens a new
 * socket whose numbering restarts at 1.
 */
import type { ErrorKind, MarkName, TransportEvent } from '../types'
import type { ClockSync } from './clock'

type Json = Record<string, unknown>

const serverMarks = new Set<MarkName>([
  'endpoint',
  'stt.final',
  'translation.first_token',
  'tts.first_flush',
  'tts.first_byte',
])

const kindMap: Record<string, ErrorKind> = {
  RateLimited: 'rate_limited',
  Timeout: 'timeout',
  Auth: 'auth',
  Empty: 'empty_transcript',
  Unavailable: 'unavailable',
}

export class CascadeEventParser {
  private target = new Map<string, string>()
  /** Utterance whose audio the binary frames currently carry (set by its tts.first_byte mark). */
  speaking: string | null = null
  private readonly clock: ClockSync
  private readonly prefix: string
  private readonly now: () => number

  constructor(clock: ClockSync, prefix: string, now: () => number = () => performance.now()) {
    this.clock = clock
    this.prefix = prefix
    this.now = now
  }

  id(u: unknown): string {
    return `${this.prefix}-${String(u)}`
  }

  parse(raw: string | Json): TransportEvent[] {
    const e = typeof raw === 'string' ? (JSON.parse(raw) as Json) : raw
    const t = typeof e.t === 'number' ? this.clock.toClient(e.t, this.now()) : this.now()
    const u = e.u === undefined || e.u === null ? undefined : this.id(e.u)
    switch (e.type) {
      case 'ready':
        return [{ type: 'state', state: 'live' }]
      case 'transcript.partial':
        return [{ type: 'transcript', role: 'source', utteranceId: u!, text: e.text as string, final: false }]
      case 'transcript.final':
        return [{ type: 'transcript', role: 'source', utteranceId: u!, text: e.text as string, final: true }]
      case 'translation.delta': {
        // Segments of one utterance arrive one after another; keep them in one target line.
        const text = (this.target.get(u!) ?? '') + (e.text as string)
        this.target.set(u!, text)
        return [{ type: 'transcript', role: 'target', utteranceId: u!, text, final: false }]
      }
      case 'translation.final':
        return []
      case 'utterance.done': {
        const text = (this.target.get(u!) ?? '').trim()
        this.target.delete(u!)
        return [{ type: 'transcript', role: 'target', utteranceId: u!, text, final: true }]
      }
      case 'latency.mark': {
        const name = e.name as MarkName
        if (!serverMarks.has(name)) return []
        if (name === 'tts.first_byte') this.speaking = u ?? null
        return [{ type: 'mark', name, t, utteranceId: u }]
      }
      case 'error': {
        const stage = e.stage as string
        const kind = kindMap[e.kind as string] ?? 'unavailable'
        return [
          {
            type: 'error',
            kind: stage === 'tts' && kind === 'unavailable' ? 'tts_failed' : kind,
            message: (e.message as string | undefined) ?? `Cascade ${stage} failed (${String(e.provider)})`,
          },
        ]
      }
      default:
        return []
    }
  }
}
