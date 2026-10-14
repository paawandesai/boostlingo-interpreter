/**
 * Client-side energy VAD (D9). The same code runs in both modes, so "speech end" is
 * measured identically for Realtime and Cascade.
 *
 * Feed it one frame at a time with the frame's RMS and its end time. It emits
 * `speech.start` once the level stays above the threshold for `minSpeechMs`, and
 * `speech.end` once it stays below for `hangoverMs`. The end mark is back-dated to the
 * end of the last voiced frame: that is when the user actually stopped talking, which is
 * what "perceived latency" starts from.
 */
export interface VadOptions {
  /** RMS level (0..1) above which a frame counts as voiced. */
  threshold: number
  /** Voiced time needed before speech.start fires (filters clicks). */
  minSpeechMs: number
  /** Silence needed before speech.end fires. */
  hangoverMs: number
}

export const defaultVadOptions: VadOptions = { threshold: 0.015, minSpeechMs: 100, hangoverMs: 200 }

export type VadEvent = { kind: 'speech.start'; t: number } | { kind: 'speech.end'; t: number }

export class EnergyVad {
  private readonly opts: VadOptions
  private speaking = false
  private voicedSince: number | null = null
  private lastVoicedEnd: number | null = null

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...defaultVadOptions, ...opts }
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  /**
   * @param level RMS of the frame
   * @param frameStart start time of the frame (ms)
   * @param frameEnd end time of the frame (ms)
   */
  process(level: number, frameStart: number, frameEnd: number): VadEvent | null {
    const voiced = level >= this.opts.threshold
    if (voiced) {
      this.lastVoicedEnd = frameEnd
      this.voicedSince ??= frameStart
      if (!this.speaking && frameEnd - this.voicedSince >= this.opts.minSpeechMs) {
        this.speaking = true
        return { kind: 'speech.start', t: this.voicedSince }
      }
      return null
    }

    if (!this.speaking) {
      this.voicedSince = null
      return null
    }
    if (this.lastVoicedEnd !== null && frameEnd - this.lastVoicedEnd >= this.opts.hangoverMs) {
      this.speaking = false
      this.voicedSince = null
      return { kind: 'speech.end', t: this.lastVoicedEnd }
    }
    return null
  }

  reset(): void {
    this.speaking = false
    this.voicedSince = null
    this.lastVoicedEnd = null
  }
}
