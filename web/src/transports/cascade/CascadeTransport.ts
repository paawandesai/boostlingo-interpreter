/**
 * Cascade mode: browser <-> our backend over one WebSocket (D5). The backend runs STT, translation and
 * TTS with its own keys; the browser sends 16 kHz PCM16 and plays the 24 kHz PCM16 that comes back.
 *
 * Owns: mic capture (frames, client VAD marks), the socket, clock sync, the playback scheduler and the
 * half-duplex mic gate. stop() releases all of them. A speaker switch opens a new socket for the new
 * direction and keeps capture and playback; an utterance in flight is dropped (D12).
 */
import { contextMsToPerf, MicDeniedError, startCapture, type CaptureHandle } from '../../audio/capture'
import { createMicGate, type MicGate } from '../../audio/micGate'
import { PlaybackScheduler } from '../../audio/playback'
import { currentAccessToken } from '../../session/access'
import { direction } from '../realtime/RealtimeTransport'
import { TransportEmitter, type Mode, type SessionConfig, type SpeakerSide, type Transport } from '../types'
import { ClockSync } from './clock'
import { CascadeEventParser } from './events'

/** Capture worklet output rate (D6). */
const STT_RATE = 16000
const TTS_RATE = 24000

export class CascadeTransport implements Transport {
  readonly mode: Mode = 'cascade'
  private readonly emitter = new TransportEmitter()
  private config: SessionConfig | null = null
  private capture: CaptureHandle | null = null
  private playback: PlaybackScheduler | null = null
  private gate: MicGate | null = null
  private ws: WebSocket | null = null
  private parser: CascadeEventParser | null = null
  private clock = new ClockSync()
  private ready = false
  /** The server explained its refusal on this socket, so the close that follows adds nothing. */
  private serverError = false
  private stopped = false
  private sockets = 0
  private firstOut = new Set<string>()
  private firstReceived = new Set<string>()
  /** Samples sent to STT on this transport, reported as session usage on stop (T3.5). */
  private samplesSent = 0
  private pingTimers: Array<ReturnType<typeof setTimeout>> = []
  private resyncTimer: ReturnType<typeof setInterval> | null = null

  /** Where the socket lives; tests and the replay harness can point it elsewhere. */
  static url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/cascade`

  subscribe = this.emitter.subscribe.bind(this.emitter)

  async start(config: SessionConfig): Promise<void> {
    this.config = config
    this.stopped = false
    this.emitter.emit({ type: 'state', state: 'connecting' })
    try {
      this.capture = await startCapture({
        stream: config.inputStream,
        targetRate: 16000,
        onFrame: (pcm) => {
          if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(pcm as Int16Array<ArrayBuffer>)
            this.samplesSent += pcm.length
          }
        },
        onVad: (kind, t) => this.emitter.emit({ type: 'mark', name: kind, t }),
        onLevel: (rms) => this.emitter.emit({ type: 'level', rms }),
      })
      if (this.stopped) return void (await this.release())
      this.gate = createMicGate((gated) => {
        this.capture?.setGated(gated)
        this.emitter.emit({ type: 'gated', gated })
      })
      this.playback = new PlaybackScheduler(this.capture.context, {
        onActiveChange: (active) => this.gate?.setPlaybackActive(active),
        onDriftSkip: (sec) =>
          this.emitter.emit({
            type: 'notice',
            message: `Dropped ${sec.toFixed(1)} s of late audio to stay in sync`,
          }),
      })
      this.connect(config.speaker)
    } catch (e) {
      await this.release()
      this.emitter.emit(
        e instanceof MicDeniedError
          ? { type: 'error', kind: 'mic_denied', message: e.message }
          : { type: 'error', kind: 'unavailable', message: e instanceof Error ? e.message : String(e) },
      )
    }
  }

  setSpeaker(side: SpeakerSide): void {
    if (!this.config || this.stopped) return
    this.config = { ...this.config, speaker: side }
    this.playback?.stop()
    this.connect(side)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.samplesSent > 0) {
      this.emitter.emit({ type: 'usage', usage: { sttAudioSeconds: this.samplesSent / STT_RATE } })
      this.samplesSent = 0
    }
    await this.release()
    this.emitter.emit({ type: 'state', state: 'closed' })
  }

  private connect(side: SpeakerSide): void {
    this.closeSocket()
    const [source, target] = direction(this.config!, side)
    const ws = new WebSocket(CascadeTransport.url())
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.ready = false
    this.serverError = false
    // Each socket has its own server clock (it starts at the connection), so the offset is re-measured.
    // Keeping the old one put a reconnected socket's marks minutes off (found by the T3.6 soak).
    this.clock = new ClockSync()
    this.parser = new CascadeEventParser(this.clock, `c${++this.sockets}`)

    const glossary = this.config!.glossary ?? false
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', token: currentAccessToken(), source, target, glossary }))
    ws.onmessage = (m: MessageEvent<string | ArrayBuffer>) => {
      if (typeof m.data === 'string') this.onMessage(m.data)
      else this.onAudio(m.data)
    }
    ws.onclose = (e) => {
      if (this.stopped || ws !== this.ws) return
      this.ready = false
      if (e.code !== 1000 && !this.serverError) {
        const reason = e.reason ? `: ${e.reason}` : ''
        this.emitter.emit({
          type: 'error',
          kind: 'unavailable',
          message: `Cascade connection closed (${e.code})${reason}`,
        })
      }
    }
  }

  private onMessage(raw: string): void {
    const json = JSON.parse(raw) as { type: string; c?: number; t?: number }
    if (json.type === 'pong' && typeof json.c === 'number' && typeof json.t === 'number') {
      this.clock.onPong(json.c, json.t, performance.now())
      return
    }
    if (json.type === 'error') this.serverError = true
    if (json.type === 'ready') {
      this.ready = true
      this.syncClock()
    }
    for (const ev of this.parser?.parse(json) ?? []) this.emitter.emit(ev)
  }

  private onAudio(data: ArrayBuffer): void {
    if (!this.playback || !this.capture) return
    const receivedAt = performance.now()
    const speaking = this.parser?.speaking
    // Network stage (D9): first audio frame of the utterance received on the client.
    if (speaking && !this.firstReceived.has(speaking)) {
      this.firstReceived.add(speaking)
      this.emitter.emit({ type: 'mark', name: 'audio.first_received', t: receivedAt, utteranceId: speaking })
    }
    const pcm = new Int16Array(data)
    const samples = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768
    const when = this.playback.enqueue(samples, TTS_RATE)
    const utteranceId = this.parser?.speaking
    // First audio out (D9): when the utterance's first chunk is scheduled to start, on the client clock.
    if (when !== null && utteranceId && !this.firstOut.has(utteranceId)) {
      this.firstOut.add(utteranceId)
      this.emitter.emit({
        type: 'mark',
        name: 'audio.first_out',
        t: contextMsToPerf(this.capture.context, when * 1000),
        utteranceId,
      })
    }
  }

  /** Five quick pings at connect, then one every 30 s (D9). */
  private syncClock(): void {
    const ping = () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping', c: performance.now() }))
    }
    for (let i = 0; i < 5; i++) this.pingTimers.push(setTimeout(ping, i * 100))
    if (this.resyncTimer === null) {
      this.resyncTimer = setInterval(() => {
        this.clock.decay()
        ping()
      }, 30000)
    }
  }

  private closeSocket(): void {
    for (const t of this.pingTimers) clearTimeout(t)
    this.pingTimers = []
    const ws = this.ws
    this.ws = null
    this.ready = false
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'done')
  }

  private async release(): Promise<void> {
    this.closeSocket()
    if (this.resyncTimer !== null) clearInterval(this.resyncTimer)
    this.resyncTimer = null
    this.gate?.dispose()
    this.gate = null
    this.playback?.stop()
    this.playback = null
    await this.capture?.stop()
    this.capture = null
  }
}
