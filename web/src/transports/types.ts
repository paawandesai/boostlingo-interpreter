/**
 * The one interface the mode-agnostic UI and session store see (D12). Each mode implements it
 * in transports/<mode>/; components never import those folders directly.
 */
export type Mode = 'realtime' | 'cascade'
export type SpeakerSide = 'A' | 'B'

export interface SessionConfig {
  /** Language spoken by side A and side B, e.g. en / es. */
  langA: string
  langB: string
  speaker: SpeakerSide
  /** Realtime model id from the server's allowed list; the server default when absent. */
  realtimeModel?: string
  /** Replay harness input; the mic is used when absent. */
  inputStream?: MediaStream
}

/** Latency mark names shared by both modes (docs/ARCHITECTURE.md, D9). Times are performance.now() ms. */
export type MarkName =
  | 'speech.start'
  | 'speech.end'
  | 'endpoint'
  | 'stt.final'
  | 'translation.first_token'
  | 'tts.first_flush'
  | 'tts.first_byte'
  | 'response.created'
  | 'audio.first_out'

export type ErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'empty_transcript'
  | 'tts_failed'
  | 'mic_denied'
  | 'webrtc_dropped'
  | 'auth'
  | 'unavailable'

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  inputAudioTokens?: number
  outputAudioTokens?: number
  inputTextTokens?: number
  outputTextTokens?: number
  cachedTokens?: number
}

export type TransportEvent =
  | { type: 'state'; state: 'connecting' | 'live' | 'closed' }
  | {
      type: 'transcript'
      role: 'source' | 'target'
      utteranceId: string
      text: string
      final: boolean
      /** STT confidence 0..1 when the provider reports one (lowest across segments). Absent means unknown. */
      confidence?: number
    }
  | { type: 'mark'; name: MarkName; t: number; utteranceId?: string }
  | { type: 'usage'; utteranceId?: string; usage: Usage }
  | { type: 'error'; kind: ErrorKind; message: string; retryAfterMs?: number }
  | { type: 'level'; rms: number }
  | { type: 'gated'; gated: boolean }

export type TransportListener = (e: TransportEvent) => void

export interface Transport {
  readonly mode: Mode
  start(config: SessionConfig): Promise<void>
  /** Closes every peer, socket, node and worklet this transport opened. Safe to call twice. */
  stop(): Promise<void>
  setSpeaker(side: SpeakerSide): void
  subscribe(listener: TransportListener): () => void
}

/** Tiny typed event hub shared by transports. */
export class TransportEmitter {
  private listeners = new Set<TransportListener>()

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(e: TransportEvent): void {
    for (const l of this.listeners) l(e)
  }

  clear(): void {
    this.listeners.clear()
  }
}
