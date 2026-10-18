/**
 * "First audio out" for Realtime (D9): audio arrives as a remote WebRTC track, not as chunks we
 * schedule, so we watch the track and stamp the first non-silent frame after a response starts.
 * Cascade stamps the same thing from the samples it schedules (`firstAudibleOffsetSec`): the moment
 * the first audible frame is due to play, not the start of a chunk that may open with silence. Neither
 * includes the device's AudioContext.outputLatency.
 */
export function isAudible(samples: Float32Array, threshold = 0.01): boolean {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length)) >= threshold
}

/**
 * Seconds into `samples` at which the first audible 5 ms frame starts, by the same test as the Realtime
 * probe, or null when the whole chunk is silent.
 */
export function firstAudibleOffsetSec(samples: Float32Array, sampleRate: number, frameSec = 0.005): number | null {
  const frame = Math.max(1, Math.round(sampleRate * frameSec))
  for (let i = 0; i < samples.length; i += frame)
    if (isAudible(samples.subarray(i, Math.min(samples.length, i + frame)))) return i / sampleRate
  return null
}

export interface FirstAudioProbe {
  /** Arm for the next response; `onFirst` fires once with performance.now() of the first audible frame. */
  arm(onFirst: (t: number) => void): void
  stop(): void
}

export function createFirstAudioProbe(ctx: AudioContext, stream: MediaStream, pollMs = 5): FirstAudioProbe {
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256 // ~5 ms at 48 kHz
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  let timer: ReturnType<typeof setInterval> | null = null

  const disarm = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  return {
    arm(onFirst) {
      disarm()
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        if (isAudible(buf)) {
          disarm()
          onFirst(performance.now())
        }
      }, pollMs)
    },
    stop() {
      disarm()
      source.disconnect()
      analyser.disconnect()
    },
  }
}
