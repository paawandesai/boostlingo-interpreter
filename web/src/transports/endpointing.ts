/**
 * Client endpointing: the browser's VAD, not the vendor's, decides that a turn is over, so the turn is
 * committed without waiting for the vendor's own silence timer (500 ms plus its detection time). Latency is
 * still measured from the same VAD speech-end mark (D9), so this changes the wait, not the measurement.
 *
 * The VAD reports speech.end after its hangover (200 ms of silence); the commit waits a little longer so a
 * short pause inside a sentence doesn't split it, and so the last audio frames reach the vendor first.
 * Speech resuming in that window cancels the commit. If the mic gate closes while a turn is open (the
 * interpreter started speaking), the turn is committed at once: the VAD resets under the gate and would
 * never report its end.
 */

/**
 * Extra wait after the VAD's speech.end before committing; `?commitDelay=` overrides it for tuning runs.
 * 300 ms (500 ms after the last voiced frame) beat 150 ms in the 2026-10-16 soaks: 150 split sentences at
 * short pauses (cascade WER 19.2% vs 7.7%) for no gain in total latency.
 */
export const DEFAULT_COMMIT_DELAY_MS = 300

export function commitDelayMs(search = typeof location === 'undefined' ? '' : location.search): number {
  const params = new URLSearchParams(search)
  if (!params.has('commitDelay')) return DEFAULT_COMMIT_DELAY_MS
  const v = Number(params.get('commitDelay'))
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_COMMIT_DELAY_MS
}

export class ClientEndpointer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private open = false

  private readonly commit: () => void
  private readonly delayMs: number

  constructor(commit: () => void, delayMs = commitDelayMs()) {
    this.commit = commit
    this.delayMs = delayMs
  }

  onVad(kind: 'speech.start' | 'speech.end'): void {
    if (kind === 'speech.start') {
      this.clear()
      this.open = true
    } else if (this.open) {
      this.clear()
      this.timer = setTimeout(() => this.fire(), this.delayMs)
    }
  }

  onGated(gated: boolean): void {
    if (gated) this.fire()
  }

  dispose(): void {
    this.clear()
    this.open = false
  }

  private fire(): void {
    this.clear()
    if (!this.open) return
    this.open = false
    this.commit()
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
