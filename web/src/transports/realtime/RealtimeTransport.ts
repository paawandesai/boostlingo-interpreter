/**
 * Realtime mode: browser <-> OpenAI over WebRTC (D4). Our backend only mints the ephemeral
 * secret; audio and events flow directly between the browser and OpenAI.
 *
 * Owns: mic capture (for client VAD marks and the outgoing track), the peer connection,
 * the `oai-events` data channel, the remote <audio> element and the first-audio probe.
 * stop() releases all of them.
 */
import { MicDeniedError, startCapture, type CaptureHandle } from '../../audio/capture'
import { createMicGate, type MicGate } from '../../audio/micGate'
import { TransportEmitter, type Mode, type SessionConfig, type SpeakerSide, type Transport } from '../types'
import { createRealtimeSession, exchangeSdp, RealtimeApiError, type RealtimeSessionInfo } from './api'
import { RealtimeEventParser } from './events'
import { createFirstAudioProbe, type FirstAudioProbe } from './firstAudioProbe'

export class RealtimeTransport implements Transport {
  readonly mode: Mode = 'realtime'
  private readonly emitter = new TransportEmitter()
  private parser = new RealtimeEventParser()
  private config: SessionConfig | null = null
  private info: RealtimeSessionInfo | null = null
  private capture: CaptureHandle | null = null
  private gate: MicGate | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private audioEl: HTMLAudioElement | null = null
  private probe: FirstAudioProbe | null = null
  private stopped = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  /** How long to wait for the data channel before reporting a failed connection. */
  static connectTimeoutMs = 15000

  subscribe = this.emitter.subscribe.bind(this.emitter)

  async start(config: SessionConfig): Promise<void> {
    this.config = config
    this.stopped = false
    this.parser = new RealtimeEventParser()
    this.emitter.emit({ type: 'state', state: 'connecting' })
    try {
      const [source, target] = direction(config, config.speaker)
      this.info = await createRealtimeSession(source, target)
      if (this.stopped) return

      this.capture = await startCapture({
        stream: config.inputStream,
        onVad: (kind, t) => this.emitter.emit({ type: 'mark', name: kind, t }),
        onLevel: (rms) => this.emitter.emit({ type: 'level', rms }),
      })
      this.gate = createMicGate((gated) => {
        this.capture?.setGated(gated)
        this.emitter.emit({ type: 'gated', gated })
      })
      if (this.stopped) return void (await this.release())

      await this.connect(this.info, this.capture.stream)
    } catch (e) {
      await this.release()
      this.emitError(e)
    }
  }

  setSpeaker(side: SpeakerSide): void {
    if (!this.config || !this.info) return
    this.config = { ...this.config, speaker: side }
    const [source, target] = direction(this.config, side)
    const instructions = this.info.instructions[`${source}>${target}`]
    if (!instructions || this.dc?.readyState !== 'open') return
    // Partial update: only instructions and the transcription language change.
    this.dc.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions,
          audio: { input: { transcription: { model: this.info.transcriptionModel, language: source } } },
        },
      }),
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.release()
    this.emitter.emit({ type: 'state', state: 'closed' })
  }

  private async connect(info: RealtimeSessionInfo, mic: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection()
    this.pc = pc

    const audioEl = document.createElement('audio')
    audioEl.autoplay = true
    this.audioEl = audioEl
    pc.ontrack = (e) => {
      const [remote] = e.streams
      audioEl.srcObject = remote
      // Chrome only feeds WebAudio from a remote WebRTC stream that is also attached to a media element.
      if (this.capture) this.probe = createFirstAudioProbe(this.capture.context, remote)
    }
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (m) => this.onServerEvent(m.data as string)
    dc.onopen = () => {
      this.clearConnectTimer()
      this.emitter.emit({ type: 'state', state: 'live' })
    }
    // ICE can fail silently behind strict firewalls; surface it instead of "connecting" forever.
    this.connectTimer = setTimeout(() => {
      if (!this.stopped && dc.readyState !== 'open') {
        this.emitter.emit({
          type: 'error',
          kind: 'webrtc_dropped',
          message: 'Could not open the WebRTC media connection',
        })
      }
    }, RealtimeTransport.connectTimeoutMs)

    pc.onconnectionstatechange = () => {
      if (this.stopped) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.emitter.emit({ type: 'error', kind: 'webrtc_dropped', message: `WebRTC connection ${pc.connectionState}` })
      }
    }

    await pc.setLocalDescription(await pc.createOffer())
    const answer = await exchangeSdp(info.callsUrl, info.clientSecret, pc.localDescription!.sdp)
    if (this.stopped) return
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  }

  private onServerEvent(raw: string): void {
    const json = JSON.parse(raw) as { type: string }
    // Playback state drives half-duplex gating; these events only exist on WebRTC sessions.
    if (json.type === 'output_audio_buffer.started') this.gate?.setPlaybackActive(true)
    if (json.type === 'output_audio_buffer.stopped' || json.type === 'output_audio_buffer.cleared') {
      this.gate?.setPlaybackActive(false)
    }
    for (const ev of this.parser.parse(json as unknown as Record<string, unknown>)) {
      this.emitter.emit(ev)
      if (ev.type === 'mark' && ev.name === 'response.created') {
        const utteranceId = ev.utteranceId
        this.probe?.arm((t) => this.emitter.emit({ type: 'mark', name: 'audio.first_out', t, utteranceId }))
      }
    }
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
    this.probe?.stop()
    this.probe = null
    this.gate?.dispose()
    this.gate = null
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

/** Source and target language for the side that is speaking. */
export function direction(config: SessionConfig, side: SpeakerSide): [string, string] {
  return side === 'A' ? [config.langA, config.langB] : [config.langB, config.langA]
}
