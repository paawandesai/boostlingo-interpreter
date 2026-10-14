import { useCallback, useEffect, useReducer, useRef } from 'react'
import { createReplay, type ReplayClip, type ReplayHandle } from '../audio/replay'
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
  const replay = useRef<ReplayHandle | null>(null)
  const startGen = useRef(0)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const teardown = useCallback(async () => {
    const t = transport.current
    transport.current = null
    // Stop before unsubscribing: stop() reports the session's STT usage (T3.5).
    await t?.stop()
    unsubscribe.current?.()
    unsubscribe.current = null
    dispatch({ type: 'segmentEnded', at: Date.now() })
  }, [])

  const stopReplay = useCallback(async () => {
    const r = replay.current
    replay.current = null
    await r?.stop()
  }, [])

  const setSpeaker = useCallback((side: SpeakerSide) => {
    dispatch({ type: 'configure', speaker: side })
    stateRef.current = { ...stateRef.current, speaker: side }
    transport.current?.setSpeaker(side)
  }, [])

  /**
   * Starts a session. With replay clips (T3.6) the clips are the input instead of the mic; the
   * replay keeps running across a mode switch so both modes hear the same audio, and each clip
   * flips the speaker side to the side whose language it is in.
   */
  const start = useCallback(
    async (opts: { replay?: ReplayClip[]; replayGapMs?: number } = {}) => {
      const gen = ++startGen.current
      await teardown()
      // A newer start (a quick second mode switch) began while this one waited; let it win.
      if (gen !== startGen.current) return
      if (opts.replay?.length) {
        await stopReplay()
        const r = createReplay(opts.replay, {
          gapMs: opts.replayGapMs,
          // The capture gate disables the input track while the interpreter speaks.
          isBusy: () => r.stream.getAudioTracks().some((t) => !t.enabled),
          onClip: (clip) => {
            const s = stateRef.current
            const side = clip.lang === s.langA ? 'A' : clip.lang === s.langB ? 'B' : null
            if (side && side !== s.speaker) setSpeaker(side)
          },
        })
        replay.current = r
        void r.run()
      }
      // A teardown while gated leaves the replay track disabled; the new capture starts ungated.
      const inputStream = replay.current?.stream
      for (const t of inputStream?.getAudioTracks() ?? []) t.enabled = true
      const { mode, langA, langB, speaker, realtimeModel, glossary } = stateRef.current
      const t = createTransport(mode)
      transport.current = t
      unsubscribe.current = t.subscribe((event) => dispatch({ type: 'transport', event }))
      dispatch({ type: 'started', at: Date.now() })
      await t.start({ langA, langB, speaker, realtimeModel: realtimeModel ?? undefined, glossary, inputStream })
    },
    [teardown, stopReplay, setSpeaker],
  )

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
      } finally {
        switching.current = false
      }
      // Not under the guard: a Realtime start can sit in "connecting" for a long time, and the user
      // must be able to switch back meanwhile (start() supersedes an earlier start).
      await start()
    },
    [teardown, start],
  )

  const end = useCallback(async () => {
    await teardown()
    await stopReplay()
    dispatch({ type: 'ended' })
  }, [teardown, stopReplay])

  const configure = useCallback(
    (c: { mode?: Mode; langA?: string; langB?: string; realtimeModel?: string; glossary?: boolean }) => {
      dispatch({ type: 'configure', ...c })
    },
    [],
  )

  /** Ends the AI session at once and records that a human interpreter was asked for (G7). */
  const requestHuman = useCallback(async () => {
    await teardown()
    await stopReplay()
    dispatch({ type: 'handoff' })
  }, [teardown, stopReplay])

  const dismissError = useCallback(() => dispatch({ type: 'dismissError' }), [])

  useEffect(
    () => () => {
      void teardown()
      void stopReplay()
    },
    [teardown, stopReplay],
  )

  return { state, start, end, configure, setSpeaker, dismissError, requestHuman, switchMode }
}
