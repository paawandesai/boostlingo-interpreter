/**
 * Replay input (T3.6): plays recorded clips into a MediaStream that either transport takes in
 * place of the mic, so both modes hear exactly the same audio. Clips play one at a time, like a
 * back-and-forth: after each clip the replay waits for the interpreter to start speaking (up to
 * replyWaitMs) and finish, then pauses, then plays the next one; the set loops.
 *
 * Waiting for the reply to start matters: with only the pause, the next clip began while the
 * previous one was still being interpreted, and when that interpretation started playing the mic
 * gate cut the new clip mid-sentence (about 1 in 4 cascade turns in the 2026-10-15 replay runs).
 */
export interface ReplayClip {
  name: string
  /** Language spoken in the clip, from a file-name prefix like `es-03.wav`; null when absent. */
  lang: string | null
  buffer: AudioBuffer
}

/** `en-01.wav`, `es_medical_3.webm` → `en`, `es`; anything else → null. */
export function langFromName(name: string): string | null {
  const m = /^([a-z]{2})[-_]/i.exec(name)
  return m ? m[1].toLowerCase() : null
}

export interface ReplayOptions {
  /** Silence after the interpreter stops before the next clip. */
  gapMs?: number
  /**
   * After a clip, how long to wait for the interpreter to start speaking before moving on; read
   * per clip so it can follow a mode switch. 0 skips the wait (a simultaneous mode with no gate).
   */
  replyWaitMs?: () => number
  loop?: boolean
  /** True while the interpreter's audio is playing (the mic gate). */
  isBusy?: () => boolean
  /** Called when a clip starts, with its name; for logs and reference matching. */
  onClip?: (clip: ReplayClip, index: number) => void
}

export interface ReplayHandle {
  stream: MediaStream
  /** Starts playback; resolves when the set ends (never, when looping) or stop() is called. */
  run(): Promise<void>
  stop(): Promise<void>
}

export async function decodeClips(files: Array<{ name: string; data: ArrayBuffer }>): Promise<ReplayClip[]> {
  const ctx = new OfflineAudioContext(1, 1, 48000)
  const clips: ReplayClip[] = []
  for (const f of files)
    clips.push({ name: f.name, lang: langFromName(f.name), buffer: await ctx.decodeAudioData(f.data.slice(0)) })
  return clips
}

/** Waits until cond() is false, polling; resolves early when aborted. */
async function whileTrue(cond: () => boolean, signal: AbortSignal, pollMs = 100): Promise<void> {
  while (cond() && !signal.aborted) await new Promise((r) => setTimeout(r, pollMs))
}

/** Waits until cond() is true or maxMs passes, polling; resolves early when aborted. */
async function untilTrue(cond: () => boolean, maxMs: number, signal: AbortSignal, pollMs = 50): Promise<void> {
  const end = Date.now() + maxMs
  while (!cond() && !signal.aborted && Date.now() < end) await new Promise((r) => setTimeout(r, pollMs))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createReplay(clips: ReplayClip[], opts: ReplayOptions = {}): ReplayHandle {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const abort = new AbortController()
  let current: AudioBufferSourceNode | null = null
  const gapMs = opts.gapMs ?? 2500

  const play = (clip: ReplayClip) =>
    new Promise<void>((resolve) => {
      const src = ctx.createBufferSource()
      src.buffer = clip.buffer
      src.connect(dest)
      // One listener per clip would pile up over a long soak, so each clip removes its own.
      const onAbort = () => resolve()
      src.onended = () => {
        abort.signal.removeEventListener('abort', onAbort)
        src.disconnect()
        current = null
        resolve()
      }
      current = src
      src.start()
      abort.signal.addEventListener('abort', onAbort, { once: true })
    })

  return {
    stream: dest.stream,
    async run() {
      if (clips.length === 0) return
      await ctx.resume()
      do {
        for (let i = 0; i < clips.length && !abort.signal.aborted; i++) {
          // The interpreter may start speaking during the gap (the pipeline is still working on the
          // last clip), so wait it out again afterwards.
          await sleep(gapMs, abort.signal)
          await whileTrue(() => opts.isBusy?.() ?? false, abort.signal)
          if (abort.signal.aborted) break
          opts.onClip?.(clips[i], i)
          await play(clips[i])
          // A speaker waits to hear the interpretation before going on.
          const busy = () => opts.isBusy?.() ?? false
          await untilTrue(busy, opts.replyWaitMs?.() ?? 0, abort.signal)
          await whileTrue(busy, abort.signal)
        }
      } while ((opts.loop ?? true) && !abort.signal.aborted)
    },
    async stop() {
      abort.abort()
      try {
        current?.stop()
      } catch {
        // already stopped
      }
      for (const t of dest.stream.getTracks()) t.stop()
      await ctx.close()
    },
  }
}
