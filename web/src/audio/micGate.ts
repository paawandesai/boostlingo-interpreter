/**
 * Half-duplex mic gating (D13): mute the mic while the interpreter's voice is playing,
 * plus a short tail, so the output is never re-captured and re-translated in a loop.
 */
export interface MicGate {
  setPlaybackActive(active: boolean): void
  dispose(): void
}

export function createMicGate(apply: (gated: boolean) => void, tailMs = 150): MicGate {
  let timer: ReturnType<typeof setTimeout> | null = null
  let gated = false
  const set = (g: boolean) => {
    if (g === gated) return
    gated = g
    apply(g)
  }
  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    setPlaybackActive(active) {
      clear()
      if (active) set(true)
      else timer = setTimeout(() => set(false), tailMs)
    },
    dispose() {
      clear()
      set(false)
    },
  }
}
