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
import {
  direction,
  HISTORY_PAIRS,
  TransportEmitter,
  type Mode,
  type SessionConfig,
  type SpeakerSide,
  type Transport,
} from '../types'
import { ClientEndpointer } from '../endpointing'
import { createRealtimeSession, exchangeSdpWithFreshSecret, RealtimeApiError, type RealtimeSessionInfo } from './api'
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
  private limitTimer: ReturnType<typeof setTimeout> | null = null
  /** A turn ended while a response was active; its response starts when that one is done. */
  private responseQueued = false
  /** A turn whose response is not done: speech_stopped or response.created seen, no response.done since. */
  private turnInFlight = false
  /** The session.update of a speaker flip made during a turn in flight; sent once that turn's response is done. */
  private pendingUpdate: string | null = null
  private pendingSide: SpeakerSide | null = null
  /** The side whose instructions the session has now (changes when a flip's session.update is sent). */
  private activeSide: SpeakerSide = 'A'
  /** The side each input item was endpointed under, so a turn finished after a flip keeps its own. */
  private itemSide = new Map<string, SpeakerSide>()
  /** Set when the session has no turn detection: the browser's VAD commits each turn (client endpointing). */
  private endpointer: ClientEndpointer | null = null
  /** Between response.created and response.done. */
  private responding = false
  /** Client endpointing: a turn ended while a response was active; it is committed when that one is done. */
  private commitDeferred = false

  /** How long to wait for the data channel before reporting a failed connection. */
  static connectTimeoutMs = 15000

  subscribe = this.emitter.subscribe.bind(this.emitter)

  async start(config: SessionConfig): Promise<void> {
    this.config = config
    this.stopped = false
    this.responseQueued = false
    this.turnInFlight = false
    this.pendingUpdate = null
    this.pendingSide = null
    this.activeSide = config.speaker
    this.itemSide.clear()
    this.responding = false
    this.commitDeferred = false
    this.parser = new RealtimeEventParser()
    this.emitter.emit({ type: 'state', state: 'connecting' })
    try {
      const [source, target] = direction(config, config.speaker)
      this.info = await createRealtimeSession(source, target, config.realtimeModel, undefined, config.glossary)
      if (this.stopped) return
      if (this.info.endpointing === 'client') this.endpointer = new ClientEndpointer(() => this.commitTurn())

      await config.beforeCapture
      if (this.stopped) return
      this.capture = await startCapture({
        stream: config.inputStream,
        onVad: (kind, t) => {
          this.emitter.emit({ type: 'mark', name: kind, t })
          this.endpointer?.onVad(kind)
        },
        onLevel: (rms) => this.emitter.emit({ type: 'level', rms }),
      })
      this.gate = createMicGate((gated) => {
        this.endpointer?.onGated(gated)
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
    const update = JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        audio: { input: { transcription: { model: this.info.transcriptionModel, language: source } } },
      },
    })
    // A turn whose response is still to come or still playing was spoken in the old direction: updating now
    // would interpret it the wrong way round. The update waits for its response.done; the last flip wins.
    if (this.turnInFlight) {
      this.pendingUpdate = update
      this.pendingSide = side
    } else {
      this.dc.send(update)
      this.activeSide = side
    }
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
      this.sendHistory(dc)
      this.emitter.emit({ type: 'state', state: 'live' })
      // G19: OpenAI bills while the connection is open, so a forgotten session is closed here.
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
    const { answer, info: used } = await exchangeSdpWithFreshSecret(info, pc.localDescription!.sdp, () => {
      // The re-minted session runs the current direction, which a flip while connecting may have changed.
      this.activeSide = this.config!.speaker
      const [source, target] = direction(this.config!, this.config!.speaker)
      return createRealtimeSession(source, target, this.config!.realtimeModel, undefined, this.config!.glossary)
    })
    if (this.stopped) return
    this.info = used
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  }

  /**
   * Client endpointing: ends the turn and asks for its interpretation. A response still playing makes the
   * response.create fail with an active-response error, which queues this turn (onServerEvent).
   */
  private commitTurn(): void {
    if (this.dc?.readyState !== 'open') return
    // Committing now would leave this turn without a response (one active response at a time) and the queued
    // response.create could cover two items at once, which dropped turns in the first client-endpointing
    // soak. The audio stays in the input buffer instead and is committed when the response is done.
    if (this.responding) {
      this.commitDeferred = true
      return
    }
    this.turnInFlight = true
    this.dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    this.dc.send(JSON.stringify({ type: 'response.create' }))
  }

  private onServerEvent(raw: string): void {
    const json = JSON.parse(raw) as { type: string; error?: { code?: string; message?: string } }
    // A turn that ends while the previous interpretation is still playing can't start its own response
    // (seen in the 2026-10-14 runner soak: 7 of 26 turns dropped). It is queued, not dropped.
    if (json.type === 'error' && isActiveResponseError(json.error)) {
      this.responseQueued = true
      this.turnInFlight = true
      this.emitter.emit({
        type: 'notice',
        message: 'A turn ended while the interpreter was speaking; it is interpreted next.',
      })
      return
    }
    if (json.type === 'input_audio_buffer.speech_stopped' || json.type === 'response.created') this.turnInFlight = true
    if (json.type === 'response.created') this.responding = true
    if (json.type === 'response.done') this.responding = false
    if (json.type === 'response.done' && this.commitDeferred) {
      this.commitDeferred = false
      this.commitTurn()
    } else if (json.type === 'response.done') {
      if (this.responseQueued && this.dc?.readyState === 'open') {
        // The queued turn was spoken before any flip, so it stays in flight with the current instructions.
        this.responseQueued = false
        this.dc.send(JSON.stringify({ type: 'response.create' }))
      } else {
        this.turnInFlight = false
        if (this.pendingUpdate && this.dc?.readyState === 'open') {
          this.dc.send(this.pendingUpdate)
          if (this.pendingSide) this.activeSide = this.pendingSide
        }
        this.pendingUpdate = null
        this.pendingSide = null
      }
    }
    // Playback state drives half-duplex gating; these events only exist on WebRTC sessions.
    if (json.type === 'output_audio_buffer.started') this.gate?.setPlaybackActive(true)
    if (json.type === 'output_audio_buffer.stopped' || json.type === 'output_audio_buffer.cleared') {
      this.gate?.setPlaybackActive(false)
    }
    for (const parsed of this.parser.parse(json as unknown as Record<string, unknown>)) {
      if (parsed.type === 'mark' && parsed.name === 'endpoint' && parsed.utteranceId)
        this.itemSide.set(parsed.utteranceId, this.activeSide)
      const ev =
        parsed.type === 'transcript'
          ? { ...parsed, side: this.itemSide.get(parsed.utteranceId) ?? this.activeSide }
          : parsed
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

  /**
   * Earlier turns (G9) as conversation items: the speech as delimited user data, the interpretation as
   * the assistant's. No response.create, so nothing is said; the next turn just has the context.
   * Item formats checked live against gpt-realtime-2.1 on 2026-10-14.
   */
  private sendHistory(dc: RTCDataChannel): void {
    for (const pair of this.config?.history?.().slice(-HISTORY_PAIRS) ?? []) {
      const user = { type: 'input_text', text: `<speech>${escapeSpeech(pair.source)}</speech>` }
      const assistant = { type: 'output_text', text: pair.target }
      dc.send(
        JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [user] } }),
      )
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'assistant', content: [assistant] },
        }),
      )
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private async release(): Promise<void> {
    this.endpointer?.dispose()
    this.endpointer = null
    this.clearConnectTimer()
    if (this.limitTimer !== null) clearTimeout(this.limitTimer)
    this.limitTimer = null
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

function isActiveResponseError(err: { code?: string; message?: string } | undefined): boolean {
  return (
    err?.code === 'conversation_already_has_active_response' ||
    /already has an active response/i.test(err?.message ?? '')
  )
}

/** Speech can't close the tag and pose as something else (same rule as the cascade prompt). */
function escapeSpeech(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
