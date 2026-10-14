/**
 * Gapless playback of streamed PCM chunks on an AudioContext, with a bounded queue (D14).
 *
 * Chunks are scheduled back to back at a cursor. If the audio queued ahead of "now"
 * would exceed `maxAheadSec`, the oldest unplayed chunks are dropped and a `drift.skip`
 * is reported, so latency can't creep up over a 5-minute session.
 *
 * Only the AudioContext members used here are required, so tests can pass a fake clock.
 */
export type PlaybackContext = Pick<
  BaseAudioContext,
  'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource'
>

export interface PlaybackEvents {
  /** First chunk of a burst scheduled; `when` is AudioContext time (s) it will start. */
  onFirstAudio?(when: number): void
  /** Chunks dropped because the queue exceeded its cap. */
  onDriftSkip?(droppedSec: number, droppedChunks: number): void
  /** true when output starts, false when the queue drains (drives mic gating). */
  onActiveChange?(active: boolean): void
}

interface Scheduled {
  buffer: AudioBuffer
  source: AudioBufferSourceNode
  start: number
  end: number
}

export class PlaybackScheduler {
  private queue: Scheduled[] = []
  private cursor = 0
  private active = false
  private readonly leadSec = 0.02
  private readonly ctx: PlaybackContext
  private readonly events: PlaybackEvents
  private readonly maxAheadSec: number
  private readonly output: AudioNode

  constructor(ctx: PlaybackContext, events: PlaybackEvents = {}, maxAheadSec = 3, output: AudioNode = ctx.destination) {
    this.ctx = ctx
    this.events = events
    this.maxAheadSec = maxAheadSec
    this.output = output
  }

  /** Seconds of audio scheduled after the current time. */
  get queuedAheadSec(): number {
    return Math.max(0, this.cursor - this.ctx.currentTime)
  }

  get isActive(): boolean {
    return this.active
  }

  enqueue(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    this.prune()

    const now = this.ctx.currentTime
    const startingBurst = this.queue.length === 0
    if (this.cursor < now + this.leadSec) this.cursor = now + this.leadSec

    if (this.cursor + buffer.duration - now > this.maxAheadSec) this.dropOldest(buffer.duration)

    const item = this.schedule(buffer, this.cursor)
    this.cursor = item.end
    if (startingBurst) {
      this.events.onFirstAudio?.(item.start)
      this.setActive(true)
    }
  }

  /** Stops everything and forgets the queue (mode switch, end of session). */
  stop(): void {
    for (const q of this.queue) {
      q.source.onended = null
      try {
        q.source.stop()
      } catch {
        // already stopped
      }
      q.source.disconnect()
    }
    this.queue = []
    this.cursor = 0
    this.setActive(false)
  }

  private schedule(buffer: AudioBuffer, start: number): Scheduled {
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.output)
    source.start(start)
    const item: Scheduled = { buffer, source, start, end: start + buffer.duration }
    source.onended = () => this.onEnded(item)
    this.queue.push(item)
    return item
  }

  private onEnded(item: Scheduled): void {
    item.source.disconnect()
    this.queue = this.queue.filter((q) => q !== item)
    if (this.queue.length === 0) this.setActive(false)
  }

  /** Drop finished items (onended can lag behind currentTime). */
  private prune(): void {
    const now = this.ctx.currentTime
    this.queue = this.queue.filter((q) => q.end > now)
  }

  /**
   * Make room for `incomingSec` by dropping the oldest unplayed chunks. Scheduled
   * sources can't be moved, so the kept ones are re-created back to back.
   */
  private dropOldest(incomingSec: number): void {
    const now = this.ctx.currentTime
    const playing = this.queue.filter((q) => q.start <= now)
    const unplayed = this.queue.filter((q) => q.start > now)
    let resumeAt = Math.max(now + this.leadSec, ...playing.map((q) => q.end))

    let droppedSec = 0
    let droppedChunks = 0
    const sum = (xs: Scheduled[]) => xs.reduce((s, q) => s + q.buffer.duration, 0)
    while (unplayed.length > 0 && resumeAt + sum(unplayed) + incomingSec - now > this.maxAheadSec) {
      const dropped = unplayed.shift()!
      droppedSec += dropped.buffer.duration
      droppedChunks++
    }

    for (const q of this.queue.filter((q) => q.start > now)) {
      q.source.onended = null
      q.source.stop()
      q.source.disconnect()
    }
    this.queue = playing
    for (const q of unplayed) resumeAt = this.schedule(q.buffer, resumeAt).end
    this.cursor = resumeAt
    if (droppedChunks > 0) this.events.onDriftSkip?.(droppedSec, droppedChunks)
  }

  private setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.events.onActiveChange?.(active)
  }
}
