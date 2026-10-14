import { useEffect, useRef, useState } from 'react'
import { MicDeniedError, startCapture, type CaptureHandle } from '../audio/capture'
import { createMicGate, type MicGate } from '../audio/micGate'
import { PlaybackScheduler } from '../audio/playback'
import { testToneChunks } from '../audio/testTone'

/**
 * Day-1 audio check (M1): mic level and client VAD marks, plus a test tone through the
 * playback scheduler with mic gating. Replaced by the live session screen in later tasks.
 */
export function AudioCheck() {
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [level, setLevel] = useState(0)
  const [speaking, setSpeaking] = useState(false)
  const [frames, setFrames] = useState(0)
  const [lastSpeechEnd, setLastSpeechEnd] = useState<number | null>(null)
  const [gated, setGated] = useState(false)
  const capture = useRef<CaptureHandle | null>(null)
  const gate = useRef<MicGate | null>(null)
  const player = useRef<{ ctx: AudioContext; scheduler: PlaybackScheduler } | null>(null)

  useEffect(
    () => () => {
      gate.current?.dispose()
      void capture.current?.stop()
      player.current?.scheduler.stop()
      void player.current?.ctx.close()
    },
    [],
  )

  async function startMic() {
    setError(null)
    try {
      capture.current = await startCapture({
        onFrame: () => setFrames((n) => n + 1),
        onLevel: setLevel,
        onVad: (kind, t) => {
          setSpeaking(kind === 'speech.start')
          if (kind === 'speech.end') setLastSpeechEnd(t)
        },
      })
      gate.current = createMicGate((g) => {
        capture.current?.setGated(g)
        setGated(g)
      })
      setRunning(true)
    } catch (e) {
      setError(
        e instanceof MicDeniedError
          ? 'Microphone access is blocked. Allow it from the address bar, then try again.'
          : String(e),
      )
    }
  }

  async function stopMic() {
    gate.current?.dispose()
    gate.current = null
    await capture.current?.stop()
    capture.current = null
    setRunning(false)
    setSpeaking(false)
    setLevel(0)
  }

  function playTone() {
    if (!player.current) {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const scheduler = new PlaybackScheduler(ctx, {
        onActiveChange: (active) => gate.current?.setPlaybackActive(active),
      })
      player.current = { ctx, scheduler }
    }
    const { ctx, scheduler } = player.current
    void ctx.resume()
    for (const chunk of testToneChunks(24000)) scheduler.enqueue(chunk, 24000)
  }

  return (
    <section aria-labelledby="audio-check-h">
      <h2 id="audio-check-h">Audio check</h2>
      <p>
        <button type="button" onClick={running ? stopMic : startMic}>
          {running ? 'Stop mic' : 'Start mic'}
        </button>{' '}
        <button type="button" onClick={playTone}>
          Play test tone
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      <p role="status">
        Mic: {running ? (gated ? 'gated (output playing)' : speaking ? 'speech' : 'silence') : 'off'} · level{' '}
        <meter min={0} max={0.3} value={level} aria-label="Input level" /> · frames {frames} · last speech end{' '}
        {lastSpeechEnd === null ? '—' : `${lastSpeechEnd.toFixed(0)} ms`}
      </p>
    </section>
  )
}
