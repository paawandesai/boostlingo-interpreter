/**
 * Mic capture for both modes: getUserMedia with browser echo cancellation, plus the
 * capture worklet for 16 kHz PCM16 frames and client VAD marks. Times reported to callers
 * are performance.now() milliseconds (the client clock every latency mark uses, D9).
 */
import type { CaptureMessage, CaptureProcessorOptions } from './capture-worklet'
import workletUrl from './capture-worklet.ts?worker&url'
import type { VadOptions } from './vad'

export class MicDeniedError extends Error {
  constructor(cause: unknown) {
    super('Microphone access was denied', { cause })
    this.name = 'MicDeniedError'
  }
}

export interface CaptureOptions {
  /** Use an existing stream (replay harness) instead of the mic. */
  stream?: MediaStream
  targetRate?: number
  frameMs?: number
  vad?: Partial<VadOptions>
  onFrame?(pcm: Int16Array, t0: number, t1: number): void
  onVad?(kind: 'speech.start' | 'speech.end', t: number): void
  onLevel?(rms: number): void
}

export interface CaptureHandle {
  readonly stream: MediaStream
  readonly context: AudioContext
  /** Mute the mic (half-duplex gating). Also disables the track, so WebRTC sends silence. */
  setGated(gated: boolean): void
  stop(): Promise<void>
}

export const micConstraints: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
}

export async function openMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints)
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new MicDeniedError(e)
    }
    throw e
  }
}

/** Converts AudioContext time (ms) to performance.now() ms using the context's own timestamp pair. */
export function contextMsToPerf(ctx: AudioContext, contextMs: number): number {
  const ts = ctx.getOutputTimestamp()
  if (ts.contextTime === undefined || ts.performanceTime === undefined) return performance.now()
  return ts.performanceTime + (contextMs - ts.contextTime * 1000)
}

export async function startCapture(opts: CaptureOptions = {}): Promise<CaptureHandle> {
  const stream = opts.stream ?? (await openMic())
  const context = new AudioContext({ latencyHint: 'interactive' })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const processorOptions: CaptureProcessorOptions = {
      targetRate: opts.targetRate ?? 16000,
      frameMs: opts.frameMs ?? 20,
      vad: opts.vad,
    }
    const node = new AudioWorkletNode(context, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions,
    })
    const source = context.createMediaStreamSource(stream)
    source.connect(node)

    node.port.onmessage = (e: MessageEvent<CaptureMessage>) => {
      const m = e.data
      if (m.type === 'frame') opts.onFrame?.(m.pcm, contextMsToPerf(context, m.t0), contextMsToPerf(context, m.t1))
      else if (m.type === 'vad') opts.onVad?.(m.kind, contextMsToPerf(context, m.t))
      else opts.onLevel?.(m.rms)
    }

    let stopped = false
    return {
      stream,
      context,
      setGated(gated) {
        for (const t of stream.getAudioTracks()) t.enabled = !gated
        node.port.postMessage({ type: 'gate', on: gated })
      },
      async stop() {
        if (stopped) return
        stopped = true
        node.port.onmessage = null
        node.port.close()
        source.disconnect()
        node.disconnect()
        if (!opts.stream) for (const t of stream.getTracks()) t.stop()
        await context.close()
      },
    }
  } catch (e) {
    if (!opts.stream) for (const t of stream.getTracks()) t.stop()
    await context.close()
    throw e
  }
}
