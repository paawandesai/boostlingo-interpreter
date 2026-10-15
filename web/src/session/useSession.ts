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

  return { state, start, end, configure, setSpeaker, dismissError, requestHuman }
}
