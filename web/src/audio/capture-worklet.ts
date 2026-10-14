/// <reference lib="es2023" />
/**
 * Capture worklet (audio thread). Downsamples the mic to 16 kHz PCM16, cuts 20 ms frames,
 * and runs the client VAD on those frames. Runs for both modes: in Realtime the frames are
 * not sent anywhere, but the VAD marks still are, so speech end is measured the same way.
 *
 * Times are AudioContext seconds converted to ms (`currentTime * 1000`); the main thread
 * maps them to performance.now().
 */
import { pcm16ToFloat, Resampler, rms } from './resample'
import { EnergyVad, type VadOptions } from './vad'

// AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number
declare const currentTime: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}

export interface CaptureProcessorOptions {
  targetRate: number
  frameMs: number
  vad?: Partial<VadOptions>
}

export type CaptureMessage =
  | { type: 'frame'; pcm: Int16Array; t0: number; t1: number }
  | { type: 'vad'; kind: 'speech.start' | 'speech.end'; t: number }
  | { type: 'level'; rms: number }

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler: Resampler
  private readonly vad: EnergyVad
  private readonly frameLen: number
  private readonly frameMs: number
  private readonly targetRate: number
  private buf: Int16Array
  private fill = 0
  /** ms time of the first sample in `buf`. */
  private bufStart = 0
  private gated = false
  private levelEvery = 5
  private frameCount = 0

  constructor(options: { processorOptions: CaptureProcessorOptions }) {
    super()
    const { targetRate, frameMs, vad } = options.processorOptions
    this.resampler = new Resampler(sampleRate, targetRate)
    this.vad = new EnergyVad(vad)
    this.frameMs = frameMs
    this.targetRate = targetRate
    this.frameLen = Math.round((targetRate * frameMs) / 1000)
    this.buf = new Int16Array(this.frameLen)
    this.port.onmessage = (e: MessageEvent<{ type: 'gate'; on: boolean }>) => {
      if (e.data.type !== 'gate') return
      this.gated = e.data.on
      // While gated, drop partial frames and reset VAD: the interpreter is talking, not the user.
      this.fill = 0
      this.resampler.reset()
      this.vad.reset()
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (!ch || this.gated) return true
    const out = this.resampler.process(ch)
    let i = 0
    while (i < out.length) {
      // currentTime is the start of this 128-sample render quantum; output sample i is i / targetRate later.
      if (this.fill === 0) this.bufStart = currentTime * 1000 + (i * 1000) / this.targetRate
      const n = Math.min(this.frameLen - this.fill, out.length - i)
      this.buf.set(out.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === this.frameLen) this.emitFrame()
    }
    return true
  }

  private emitFrame(): void {
    const pcm = this.buf
    const t0 = this.bufStart
    const t1 = t0 + this.frameMs
    const level = rms(pcm16ToFloat(pcm))
    const ev = this.vad.process(level, t0, t1)
    this.port.postMessage({ type: 'frame', pcm, t0, t1 } satisfies CaptureMessage, [pcm.buffer])
    if (ev) this.port.postMessage({ type: 'vad', kind: ev.kind, t: ev.t } satisfies CaptureMessage)
    if (++this.frameCount % this.levelEvery === 0)
      this.port.postMessage({ type: 'level', rms: level } satisfies CaptureMessage)
    this.buf = new Int16Array(this.frameLen)
    this.fill = 0
  }
}

registerProcessor('capture-processor', CaptureProcessor)
