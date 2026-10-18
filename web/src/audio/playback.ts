/**
 * Gapless playback of streamed PCM chunks on an AudioContext, with a bounded queue (D14).
 *
 * Chunks are scheduled back to back at a cursor. If the audio queued ahead of "now"
 * would exceed `maxAheadSec`, the oldest unplayed chunks of *earlier* turns are dropped and a
 * `drift.skip` is reported, so a backlog can't make latency creep up over a 5-minute session.
 * The turn that is arriving is never cut by that cap: TTS streams faster than real time, so a
 * single long interpretation can sit well past 3 s ahead with no backlog at all. Only past
 * `maxTurnAheadSec` (a memory ceiling, not a latency control) is the arriving turn itself trimmed.
 * Chunks enqueued without a turn id keep the plain oldest-first cap.
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
  /** Chunks dropped because the queue exceeded its cap; `turns` lists the turn ids that lost audio. */
  onDriftSkip?(droppedSec: number, droppedChunks: number, turns: string[]): void
  /** true when output starts, false when the queue drains (drives mic gating). */
  onActiveChange?(active: boolean): void
}

interface Scheduled {
  buffer: AudioBuffer
  source: AudioBufferSourceNode
  start: number
  end: number
  turn?: string
}

export class PlaybackScheduler {
  private queue: Scheduled[] = []
  private cursor = 0
  private active = false
  private readonly leadSec = 0.02
  private readonly ctx: PlaybackContext
  private readonly events: PlaybackEvents
  private readonly maxAheadSec: number
  private readonly maxTurnAheadSec: number
  private readonly output: AudioNode

  constructor(
    ctx: PlaybackContext,
    events: PlaybackEvents = {},
    maxAheadSec = 3,
    output: AudioNode = ctx.destination,
    maxTurnAheadSec = 30,
  ) {
    this.ctx = ctx
    this.events = events
    this.maxAheadSec = maxAheadSec
    this.maxTurnAheadSec = Math.max(maxAheadSec, maxTurnAheadSec)
    this.output = output
  }

  /** Seconds of audio scheduled after the current time. */
  get queuedAheadSec(): number {
    return Math.max(0, this.cursor - this.ctx.currentTime)
  }

  get isActive(): boolean {
    return this.active
  }

  /**
   * Schedules a chunk and returns the AudioContext time (s) it starts at, or null for an empty chunk.
   * `turn` identifies the utterance the chunk belongs to; the cap never cuts the turn that is arriving.
   */
  enqueue(samples: Float32Array, sampleRate: number, turn?: string): number | null {
    if (samples.length === 0) return null
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    this.prune()

    const now = this.ctx.currentTime
    const startingBurst = this.queue.length === 0
    if (this.cursor < now + this.leadSec) this.cursor = now + this.leadSec

    if (this.cursor + buffer.duration - now > this.maxAheadSec) this.dropOldest(buffer.duration, turn)

    const item = this.schedule(buffer, this.cursor, turn)
    this.cursor = item.end
    if (startingBurst) {
      this.events.onFirstAudio?.(item.start)
      this.setActive(true)
    }
    return item.start
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

  private schedule(buffer: AudioBuffer, start: number, turn?: string): Scheduled {
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.output)
    source.start(start)
    const item: Scheduled = { buffer, source, start, end: start + buffer.duration, turn }
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
   * Make room for `incomingSec` by dropping the oldest unplayed chunks of earlier turns (any chunk
   * when no turn is given). The arriving turn's own chunks go only past `maxTurnAheadSec`. Scheduled
   * sources can't be moved, so the kept ones are re-created back to back.
   */
  private dropOldest(incomingSec: number, turn?: string): void {
    const now = this.ctx.currentTime
    const playing = this.queue.filter((q) => q.start <= now)
    const unplayed = this.queue.filter((q) => q.start > now)
    const resumeFrom = Math.max(now + this.leadSec, ...playing.map((q) => q.end))
    const sum = (xs: Scheduled[]) => xs.reduce((s, q) => s + q.buffer.duration, 0)
    const ahead = () => resumeFrom + sum(unplayed) + incomingSec - now
    const earlier = (q: Scheduled) => turn === undefined || q.turn !== turn

    const dropped: Scheduled[] = []
    const dropFirst = (pick: (q: Scheduled) => boolean, cap: number) => {
      while (ahead() > cap) {
        const i = unplayed.findIndex(pick)
        if (i < 0) return
        dropped.push(...unplayed.splice(i, 1))
      }
    }
    dropFirst(earlier, this.maxAheadSec)
    if (turn !== undefined) dropFirst(() => true, this.maxTurnAheadSec)
    if (dropped.length === 0) return

    for (const q of this.queue.filter((q) => q.start > now)) {
      q.source.onended = null
      q.source.stop()
      q.source.disconnect()
    }
    this.queue = playing
    let resumeAt = resumeFrom
    for (const q of unplayed) resumeAt = this.schedule(q.buffer, resumeAt, q.turn).end
    this.cursor = resumeAt
    const turns = [...new Set(dropped.flatMap((q) => (q.turn === undefined ? [] : [q.turn])))]
    this.events.onDriftSkip?.(sum(dropped), dropped.length, turns)
  }

  private setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.events.onActiveChange?.(active)
  }
}
