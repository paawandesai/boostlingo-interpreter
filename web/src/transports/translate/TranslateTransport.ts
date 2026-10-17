/**
 * Realtime translate mode (G17): browser <-> gpt-realtime-translate over WebRTC. The session takes a
 * target language and nothing else (no instructions, no tools), which is the structural defence the
 * guardrails prefer. It interprets simultaneously: it speaks while the speaker is still talking, so
 * the mic is never gated here and headphones are required (echo cancellation is the only defence
 * against re-translating its own voice; the red-team "TTS echo" lines test it).
 *
 * The SDP exchange with /v1/realtime/translations/calls was checked live (201, data channel offered)
 * on 2026-10-14. Event names over the data channel are assumed to match the WebSocket ones, which
 * were checked live; the audio path itself could not be tested from the cloud container.
 */
import { MicDeniedError, startCapture, type CaptureHandle } from '../../audio/capture'
import {
  createTranslationSession,
  exchangeSdpWithFreshSecret,
  RealtimeApiError,
  type TranslationSessionInfo,
} from '../realtime/api'
import { createFirstAudioProbe, type FirstAudioProbe } from '../realtime/firstAudioProbe'
import {
  direction,
  TransportEmitter,
  type Mode,
  type SessionConfig,
  type SpeakerSide,
  type Transport,
  type TransportEvent,
} from '../types'
import { TranslateSegmenter } from './segmenter'

const TICK_MS = 200

export class TranslateTransport implements Transport {
  readonly mode: Mode = 'translate'
  private readonly emitter = new TransportEmitter()
  private segmenter = new TranslateSegmenter()
  private config: SessionConfig | null = null
  private capture: CaptureHandle | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private audioEl: HTMLAudioElement | null = null
  private probe: FirstAudioProbe | null = null
  private stopped = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private limitTimer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private pendingStart: number | null = null

  static connectTimeoutMs = 15000

  subscribe = this.emitter.subscribe.bind(this.emitter)

  async start(config: SessionConfig): Promise<void> {
    this.config = config
    this.stopped = false
    // A fresh prefix per connection so a reconnect never reuses an earlier line's id.
    this.segmenter = new TranslateSegmenter(`tr${Date.now().toString(36)}-`)
    this.emitter.emit({ type: 'state', state: 'connecting' })
    try {
      const [, target] = direction(config, config.speaker)
      const info = await createTranslationSession(target)
      if (this.stopped) return

      await config.beforeCapture
      if (this.stopped) return
      this.capture = await startCapture({
        stream: config.inputStream,
        onVad: (kind, t) => (kind === 'speech.start' ? this.onSpeechStart(t) : this.segmenter.speechEnd(t)),
        onLevel: (rms) => this.emitter.emit({ type: 'level', rms }),
      })
      if (this.stopped) return void (await this.release())

      await this.connect(info, this.capture.stream)
    } catch (e) {
      await this.release()
      this.emitError(e)
    }
  }

  /** Only the output language changes; the model detects whoever is speaking. */
  setSpeaker(side: SpeakerSide): void {
    if (!this.config) return
    this.config = { ...this.config, speaker: side }
    const [, target] = direction(this.config, side)
    if (this.dc?.readyState !== 'open') return
    this.dc.send(JSON.stringify({ type: 'session.update', session: { audio: { output: { language: target } } } }))
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.release()
    this.emitter.emit({ type: 'state', state: 'closed' })
  }

  private async connect(info: TranslationSessionInfo, mic: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection()
    this.pc = pc

    const audioEl = document.createElement('audio')
    audioEl.autoplay = true
    this.audioEl = audioEl
    pc.ontrack = (e) => {
      const [remote] = e.streams
      audioEl.srcObject = remote
      if (!this.capture) return
      this.probe = createFirstAudioProbe(this.capture.context, remote)
      // Speech that began before the remote track arrived still gets its first audio stamped.
      if (this.pendingStart !== null) this.armProbe(this.pendingStart)
    }
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (m) => this.onServerEvent(m.data as string)
    dc.onopen = () => {
      this.clearConnectTimer()
      this.emitter.emit({ type: 'state', state: 'live' })
      this.ticker = setInterval(() => this.emitAll(this.segmenter.tick(performance.now())), TICK_MS)
      const max = info.maxSessionSeconds
      if (max)
        this.limitTimer = setTimeout(() => {
          // The session is over, not paused: the mic closes and the UI leaves the live screen (closed).
          this.stopped = true
          void this.release().then(() => {
            this.emitter.emit({
              type: 'error',
              kind: 'unavailable',
              message: `This session reached the ${Math.round(max / 6) / 10}-minute limit. Start a new session to continue.`,
            })
            this.emitter.emit({ type: 'state', state: 'closed' })
          })
        }, max * 1000)
    }
    this.connectTimer = setTimeout(() => {
      if (!this.stopped && dc.readyState !== 'open') {
        this.emitter.emit({
          type: 'error',
          kind: 'webrtc_dropped',
          message: 'Could not open the WebRTC media connection',
        })
      }
    }, TranslateTransport.connectTimeoutMs)

    pc.onconnectionstatechange = () => {
      if (this.stopped) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.emitter.emit({ type: 'error', kind: 'webrtc_dropped', message: `WebRTC connection ${pc.connectionState}` })
      }
    }

    await pc.setLocalDescription(await pc.createOffer())
    const { answer } = await exchangeSdpWithFreshSecret(info, pc.localDescription!.sdp, () =>
      createTranslationSession(direction(this.config!, this.config!.speaker)[1]),
    )
    if (this.stopped) return
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  }

  private onServerEvent(raw: string): void {
    const e = JSON.parse(raw) as { type: string; delta?: string; elapsed_ms?: number; error?: { message?: string } }
    const t = performance.now()
    switch (e.type) {
      case 'session.input_transcript.delta':
        this.emitAll(this.segmenter.inputDelta(e.delta ?? '', t, e.elapsed_ms))
        return
      case 'session.output_transcript.delta':
        this.emitAll(this.segmenter.outputDelta(e.delta ?? '', t, e.elapsed_ms))
        return
      case 'error':
        this.emitter.emit({ type: 'error', kind: 'unavailable', message: e.error?.message ?? 'Translation error' })
        return
    }
  }

  /** First audible output after a pause in both directions is that speech's start lag. */
  private onSpeechStart(t: number): void {
    if (this.segmenter.speechStart(t)) this.armProbe(t)
  }

  private armProbe(start: number): void {
    this.pendingStart = this.probe ? null : start
    this.probe?.arm((at) => this.emitAll(this.segmenter.audioOut(start, at)))
  }

  private emitAll(events: TransportEvent[]): void {
    for (const ev of events) this.emitter.emit(ev)
  }

  private emitError(e: unknown): void {
    if (e instanceof MicDeniedError) {
      this.emitter.emit({ type: 'error', kind: 'mic_denied', message: e.message })
    } else if (e instanceof RealtimeApiError) {
      this.emitter.emit({ type: 'error', kind: e.kind, message: e.message, retryAfterMs: e.retryAfterMs })
    } else {
      this.emitter.emit({ type: 'error', kind: 'unavailable', message: e instanceof Error ? e.message : String(e) })
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private async release(): Promise<void> {
    this.clearConnectTimer()
    if (this.limitTimer !== null) clearTimeout(this.limitTimer)
    this.limitTimer = null
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
    // Whatever was said before the close still gets its final lines.
    this.emitAll(this.segmenter.flush())
    this.probe?.stop()
    this.probe = null
    this.pendingStart = null
    if (this.dc) {
      this.dc.onmessage = null
      this.dc.onopen = null
      this.dc.close()
    }
    this.dc = null
    if (this.pc) {
      this.pc.ontrack = null
      this.pc.onconnectionstatechange = null
      this.pc.close()
    }
    this.pc = null
    if (this.audioEl) {
      this.audioEl.srcObject = null
      this.audioEl.remove()
    }
    this.audioEl = null
    await this.capture?.stop()
    this.capture = null
  }
}
