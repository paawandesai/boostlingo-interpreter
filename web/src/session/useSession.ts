import { useCallback, useEffect, useReducer, useRef } from 'react'
import { createTransport } from '../transports'
import type { Mode, SpeakerSide, Transport } from '../transports/types'
import { initialState, sessionReducer } from './store'

/**
 * Binds the mode-agnostic store to whichever transport is active. Components use this hook and
 * never touch a transport directly.
 */
export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialState)
  const transport = useRef<Transport | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const teardown = useCallback(async () => {
    unsubscribe.current?.()
    unsubscribe.current = null
    const t = transport.current
    transport.current = null
    await t?.stop()
  }, [])

  const start = useCallback(async () => {
    await teardown()
    const { mode, langA, langB, speaker, realtimeModel } = stateRef.current
    const t = createTransport(mode)
    transport.current = t
    unsubscribe.current = t.subscribe((event) => dispatch({ type: 'transport', event }))
    dispatch({ type: 'started' })
    await t.start({ langA, langB, speaker, realtimeModel: realtimeModel ?? undefined })
  }, [teardown])

  const switching = useRef(false)

  /**
   * Mid-session mode switch (T3.3, G9): the old transport is fully stopped before the new one
   * starts, and the transcript stays in the store. The new mode starts with no memory of earlier
   * turns; the marker says so.
   */
  const switchMode = useCallback(
    async (mode: Mode) => {
      const s = stateRef.current
      if (mode === s.mode || switching.current) return
      if (s.status !== 'connecting' && s.status !== 'live') {
        dispatch({ type: 'configure', mode })
        return
      }
      switching.current = true
      try {
        await teardown()
        dispatch({ type: 'configure', mode })
        dispatch({
          type: 'marker',
          text: `Switched to ${mode}. Earlier turns stay here but are not sent to the new mode.`,
        })
        stateRef.current = { ...stateRef.current, mode }
        await start()
      } finally {
        switching.current = false
      }
    },
    [teardown, start],
  )

  const end = useCallback(async () => {
    await teardown()
    dispatch({ type: 'ended' })
  }, [teardown])

  const configure = useCallback((c: { mode?: Mode; langA?: string; langB?: string; realtimeModel?: string }) => {
    dispatch({ type: 'configure', ...c })
  }, [])

  const setSpeaker = useCallback((side: SpeakerSide) => {
    dispatch({ type: 'configure', speaker: side })
    transport.current?.setSpeaker(side)
  }, [])

  /** Ends the AI session at once and records that a human interpreter was asked for (G7). */
  const requestHuman = useCallback(async () => {
    await teardown()
    dispatch({ type: 'handoff' })
  }, [teardown])

  const dismissError = useCallback(() => dispatch({ type: 'dismissError' }), [])

  useEffect(() => () => void teardown(), [teardown])

  return { state, start, end, configure, setSpeaker, dismissError, requestHuman, switchMode }
}
