/**
 * "First audio out" for Realtime (D9): audio arrives as a remote WebRTC track, not as chunks we
 * schedule, so we watch the track and stamp the first non-silent frame after a response starts.
 * This measures audio *heard*; cascade measures audio *scheduled*. The write-up notes the gap
 * (AudioContext.outputLatency).
 */
export function isAudible(samples: Float32Array, threshold = 0.01): boolean {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length)) >= threshold
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
