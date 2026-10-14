/**
 * Maps server timestamps onto the client clock (D9): NTP-style offset from ping/pong, keeping the
 * sample with the smallest round trip, since it bounds the error best.
 */
export class ClockSync {
  private bestRtt = Infinity
  private offset: number | null = null

  /** c: client send time, t: server time in the pong, now: client receive time (all ms). */
  onPong(c: number, t: number, now: number): void {
    const rtt = now - c
    if (rtt < 0 || rtt > this.bestRtt) return
    this.bestRtt = rtt
    this.offset = c + rtt / 2 - t
  }

  get synced(): boolean {
    return this.offset !== null
  }

  /** Round trip of the sample in use; the conversion error is at most half of it. */
  get rttMs(): number | null {
    return this.offset === null ? null : this.bestRtt
  }

  /** Server ms to client performance.now() ms. Falls back to "now" before the first pong. */
  toClient(t: number, now: number): number {
    return this.offset === null ? now : t + this.offset
  }

  /** Forget the old sample so a later, slower path is still measured (re-estimate every 30 s). */
  decay(): void {
    if (Number.isFinite(this.bestRtt)) this.bestRtt *= 1.5
  }
}
