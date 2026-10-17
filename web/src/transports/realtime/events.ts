/**
 * Maps Realtime API data-channel events to transport events. Pure apart from the clock, so it
 * is tested against recorded event fixtures. Event names and fields checked against the
 * openai npm v7.32.0 type definitions (2026-10-14).
 *
 * Utterance identity: the user's input item id (from speech_stopped / committed). A response
 * is attributed to the most recently committed input item.
 */
import type { TransportEvent, Usage } from '../types'

type Json = Record<string, unknown>

export class RealtimeEventParser {
  private sourceText = new Map<string, string>()
  private targetText = new Map<string, string>()
  private lastInputItem: string | null = null
  private responseToItem = new Map<string, string>()
  /** Responses whose output transcript was finalized (output_audio_transcript.done). */
  private finalized = new Set<string>()
  /** Input items whose endpoint mark was emitted (server VAD sends speech_stopped before committed). */
  private endpointed = new Set<string>()
  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  /** Utterance whose translation is currently playing, for gating and the first-audio probe. */
  get currentUtterance(): string | null {
    return this.lastInputItem
  }

  parse(raw: string | Json): TransportEvent[] {
    const e = typeof raw === 'string' ? (JSON.parse(raw) as Json) : raw
    const t = this.now()
    switch (e.type) {
      case 'input_audio_buffer.speech_stopped': {
        const id = e.item_id as string
        this.lastInputItem = id
        this.endpointed.add(id)
        return [{ type: 'mark', name: 'endpoint', t, utteranceId: id }]
      }
      case 'input_audio_buffer.committed': {
        // With client endpointing there is no speech_stopped: the commit the browser sent is the endpoint.
        const id = e.item_id as string
        this.lastInputItem = id
        if (this.endpointed.delete(id)) return []
        return [{ type: 'mark', name: 'endpoint', t, utteranceId: id }]
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const id = e.item_id as string
        const text = (this.sourceText.get(id) ?? '') + ((e.delta as string | undefined) ?? '')
        this.sourceText.set(id, text)
        return [{ type: 'transcript', role: 'source', utteranceId: id, text, final: false }]
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const id = e.item_id as string
        this.sourceText.delete(id)
        const text = ((e.transcript as string) ?? '').trim()
        if (!text) return [{ type: 'error', kind: 'empty_transcript', message: 'No speech recognised' }]
        return [{ type: 'transcript', role: 'source', utteranceId: id, text, final: true }]
      }
      case 'conversation.item.input_audio_transcription.failed':
        return [{ type: 'error', kind: 'unavailable', message: 'Input transcription failed' }]
      case 'response.created': {
        const responseId = (e.response as Json | undefined)?.id as string | undefined
        const id = this.lastInputItem
        if (responseId && id) this.responseToItem.set(responseId, id)
        return [{ type: 'mark', name: 'response.created', t, utteranceId: id ?? undefined }]
      }
      case 'response.output_audio_transcript.delta': {
        const id = this.itemFor(e.response_id as string)
        const text = (this.targetText.get(id) ?? '') + (e.delta as string)
        this.targetText.set(id, text)
        return [{ type: 'transcript', role: 'target', utteranceId: id, text, final: false }]
      }
      case 'response.output_audio_transcript.done': {
        const id = this.itemFor(e.response_id as string)
        this.targetText.delete(id)
        if (e.response_id) this.finalized.add(e.response_id as string)
        return [
          {
            type: 'transcript',
            role: 'target',
            utteranceId: id,
            text: ((e.transcript as string) ?? '').trim(),
            final: true,
          },
        ]
      }
      case 'response.done': {
        const response = (e.response as Json | undefined) ?? {}
        const responseId = response.id as string | undefined
        const known = (responseId && this.responseToItem.has(responseId)) || this.lastInputItem !== null
        const id = this.itemFor(responseId)
        const out: TransportEvent[] = []
        // G15: a response that ended without a finished output transcript (the model said nothing, or the
        // response was cancelled or cut short) still finalizes its line, so the output checks run and an
        // omission is flagged with the handoff offer instead of a partial line that never resolves.
        if (known && !(responseId && this.finalized.has(responseId))) {
          const text = (this.targetText.get(id) ?? '').trim()
          this.targetText.delete(id)
          out.push({ type: 'transcript', role: 'target', utteranceId: id, text, final: true })
        }
        const usage = toUsage(response.usage as Json | undefined)
        if (usage) out.push({ type: 'usage', utteranceId: id, usage })
        const status = response.status
        if (status === 'failed' || status === 'incomplete' || status === 'cancelled') {
          out.push({
            type: 'error',
            kind: 'unavailable',
            message: status === 'failed' ? 'Realtime response failed' : `Realtime response ${status}`,
            utteranceId: known ? id : undefined,
          })
        }
        if (responseId) {
          this.responseToItem.delete(responseId)
          this.finalized.delete(responseId)
        }
        return out
      }
      case 'error': {
        const err = (e.error as Json | undefined) ?? {}
        const code = String(err.code ?? '')
        const kind = code.includes('rate_limit') ? 'rate_limited' : 'unavailable'
        return [{ type: 'error', kind, message: String(err.message ?? 'Realtime API error') }]
      }
      case 'rate_limits.updated':
      default:
        return []
    }
  }

  private itemFor(responseId: string | undefined): string {
    return (responseId && this.responseToItem.get(responseId)) || this.lastInputItem || responseId || 'unknown'
  }
}

function toUsage(u: Json | undefined): Usage | undefined {
  if (!u) return undefined
  const inD = (u.input_token_details as Json | undefined) ?? {}
  const outD = (u.output_token_details as Json | undefined) ?? {}
  // Cached input is billed at its own rates per modality, so the split is kept when the API reports it.
  const cachedD = (inD.cached_tokens_details as Json | undefined) ?? {}
  return {
    inputTokens: u.input_tokens as number | undefined,
    outputTokens: u.output_tokens as number | undefined,
    inputAudioTokens: inD.audio_tokens as number | undefined,
    inputTextTokens: inD.text_tokens as number | undefined,
    cachedTokens: inD.cached_tokens as number | undefined,
    cachedTextTokens: cachedD.text_tokens as number | undefined,
    cachedAudioTokens: cachedD.audio_tokens as number | undefined,
    outputAudioTokens: outD.audio_tokens as number | undefined,
    outputTextTokens: outD.text_tokens as number | undefined,
  }
}
