import type { LanguagesResponse } from './languages'
import { describe, expect, it } from 'vitest'
import type { TransportEvent } from '../transports/types'
import {
  headlineLatencyMs,
  initialState,
  recentPairs,
  sessionReducer,
  type SessionState,
  type Utterance,
} from './store'

const run = (events: TransportEvent[], from: SessionState = initialState) =>
  events.reduce((s, event) => sessionReducer(s, { type: 'transport', event }), from)

const utterances = (s: SessionState) => s.timeline.filter((x): x is Utterance => x.kind === 'utterance')

describe('sessionReducer', () => {
  it('builds one utterance from partials, finals and marks', () => {
    const s = run([
      { type: 'mark', name: 'speech.end', t: 1000 },
      { type: 'mark', name: 'endpoint', t: 1500, utteranceId: 'u1' },
      { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hel', final: false },
      { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hello', final: true },
      { type: 'mark', name: 'response.created', t: 1600, utteranceId: 'u1' },
      { type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true },
      { type: 'mark', name: 'audio.first_out', t: 2100, utteranceId: 'u1' },
    ])
    const [u] = utterances(s)
    expect(u.source).toEqual({ text: 'Hello', final: true })
    expect(u.target).toEqual({ text: 'Hola', final: true })
    expect(u.marks).toEqual({ 'speech.end': 1000, endpoint: 1500, 'response.created': 1600, 'audio.first_out': 2100 })
    expect(headlineLatencyMs(u)).toBe(1100)
    expect(s.pendingSpeechEnd).toBeNull()
  })

  it('tags utterances with the mode and speaker at the time they started', () => {
    let s = sessionReducer(initialState, { type: 'configure', mode: 'realtime', speaker: 'B' })
    s = run([{ type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hola', final: true }], s)
    expect(utterances(s)[0]).toMatchObject({ mode: 'realtime', side: 'B' })
  })

  it('does not attach a stale speech end to a later endpoint', () => {
    const s = run([
      { type: 'mark', name: 'speech.end', t: 1000 },
      { type: 'mark', name: 'endpoint', t: 9000, utteranceId: 'u1' },
    ])
    expect(utterances(s)[0].marks['speech.end']).toBeUndefined()
  })

  it('keeps the first value of a mark', () => {
    const s = run([
      { type: 'mark', name: 'audio.first_out', t: 5, utteranceId: 'u1' },
      { type: 'mark', name: 'audio.first_out', t: 9, utteranceId: 'u1' },
    ])
    expect(utterances(s)[0].marks['audio.first_out']).toBe(5)
  })

  it('locks the language pair while a session runs, but not the mode', () => {
    let s = sessionReducer(initialState, { type: 'started' })
    s = sessionReducer(s, { type: 'configure', langB: 'vi', mode: 'cascade' })
    expect(s.langB).toBe('es')
    expect(s.mode).toBe('cascade')
  })

  it('records errors with their kind and clears them on dismiss', () => {
    let s = run([{ type: 'error', kind: 'rate_limited', message: 'slow', retryAfterMs: 1000 }])
    expect(s.error).toEqual({ kind: 'rate_limited', message: 'slow', retryAfterMs: 1000 })
    s = sessionReducer(s, { type: 'dismissError' })
    expect(s.error).toBeNull()
  })

  it('returns to the setup screen when the first connection of a session is refused', () => {
    let s = sessionReducer(initialState, { type: 'started', at: 1000 })
    s = run(
      [
        { type: 'state', state: 'connecting' },
        { type: 'error', kind: 'auth', message: 'Missing or wrong access token.' },
      ],
      s,
    )
    expect(s.status).toBe('ended')
    expect(s.error).toEqual({ kind: 'auth', message: 'Missing or wrong access token.' })
    expect(s.segments).toEqual([])
    // A late 'closed' from the transport changes nothing, and the next Start clears the banner.
    expect(run([{ type: 'state', state: 'closed' }], s).status).toBe('ended')
    expect(sessionReducer(s, { type: 'started' }).error).toBeNull()
  })

  it('stays on the live screen when a reconnect is refused, so the transcript can still be exported', () => {
    let s = run([{ type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true }])
    s = sessionReducer(s, { type: 'started' })
    s = run([{ type: 'error', kind: 'auth', message: 'refused' }], s)
    expect(s.status).toBe('connecting')
    expect(s.error?.kind).toBe('auth')
    expect(utterances(s)).toHaveLength(1)
    expect(s.incidents).toEqual([{ mode: initialState.mode, kind: 'auth', message: 'refused' }])
  })

  it('keeps STT confidence on the source line', () => {
    const s = run([{ type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hi', final: true, confidence: 0.5 }])
    expect(utterances(s)[0].source).toEqual({ text: 'Hi', final: true, confidence: 0.5 })
  })

  it('ends the session with a marker when a human interpreter is requested', () => {
    let s = sessionReducer(initialState, { type: 'started' })
    s = sessionReducer(s, { type: 'handoff' })
    expect(s.status).toBe('ended')
    expect(s.handoffRequested).toBe(true)
    expect(s.timeline.at(-1)).toMatchObject({ kind: 'marker', text: 'AI session ended: human interpreter requested' })
    expect(sessionReducer(s, { type: 'started' }).handoffRequested).toBe(false)
  })

  it('keeps the side a transport reports for a turn finished after a speaker flip', () => {
    let s = sessionReducer(initialState, { type: 'started' })
    s = sessionReducer(s, { type: 'configure', speaker: 'B' })
    s = run(
      [
        { type: 'mark', name: 'endpoint', t: 1, utteranceId: 'u1' },
        { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hello.', final: true, side: 'A' },
        { type: 'transcript', role: 'source', utteranceId: 'u2', text: 'Hola.', final: true },
      ],
      s,
    )
    expect(utterances(s).map((u) => u.side)).toEqual(['A', 'B'])
  })

  it('keeps the transcript after a handoff for export, and never carries it into the next session (G20)', () => {
    let s = run([
      { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Where is the pharmacy?', final: true },
      { type: 'transcript', role: 'target', utteranceId: 'u1', text: '¿Dónde está la farmacia?', final: true },
    ])
    s = sessionReducer(s, { type: 'handoff' })
    expect(utterances(s)).toHaveLength(1)

    s = sessionReducer(s, { type: 'started', at: 1 })
    expect(s.timeline).toEqual([])
    expect(recentPairs(s)).toEqual([])
    expect(s.segments).toHaveLength(1)
  })

  it('flags a turn the provider never recognised as an empty transcript', () => {
    const s = run([
      { type: 'mark', name: 'speech.end', t: 1000 },
      { type: 'mark', name: 'speech.end', t: 9000 },
    ])
    expect(s.error?.kind).toBe('empty_transcript')
    expect(s.pendingSpeechEnd).toBe(9000)
  })

  it('marks the utterance whose speech synthesis failed and keeps its text', () => {
    const s = run([
      { type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true },
      { type: 'error', kind: 'tts_failed', message: 'x', utteranceId: 'u1' },
    ])
    expect(utterances(s)[0]).toMatchObject({ audioFailed: true, target: { text: 'Hola' } })
    expect(s.error?.kind).toBe('tts_failed')
  })

  it('shows a notice until the next finished turn', () => {
    let s = run([{ type: 'notice', message: 'retrying' }])
    expect(s.notice).toBe('retrying')
    s = run([{ type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true }], s)
    expect(s.notice).toBeNull()
  })

  it('keeps every error and notice for the session log', () => {
    let s = run([{ type: 'notice', message: 'retrying' }])
    s = run([{ type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true }], s)
    s = run([{ type: 'error', kind: 'timeout', message: 'slow' }], s)
    expect(s.notice).toBeNull()
    expect(s.incidents).toEqual([
      { mode: initialState.mode, kind: 'notice', message: 'retrying' },
      { mode: initialState.mode, kind: 'timeout', message: 'slow' },
    ])
  })

  it('discards the transcript at the end of a session (G20)', () => {
    let s = run([{ type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true }])
    s = sessionReducer(s, { type: 'ended' })
    expect(s.timeline).toEqual([])
    expect(s.incidents).toEqual([])
    expect(s.status).toBe('ended')
  })

  it('lists finished turns, newest last, for the next connection (G9)', () => {
    const s = run([
      { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hello', final: true },
      { type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true },
      { type: 'transcript', role: 'source', utteranceId: 'u2', text: 'Still talk', final: false },
    ])
    expect(recentPairs(s)).toEqual([{ source: 'Hello', target: 'Hola' }])
  })

  it('leaves a flagged turn out of the next context (G15)', () => {
    const s = run([
      { type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hello', final: true },
      { type: 'transcript', role: 'target', utteranceId: 'u1', text: 'Hola', final: true },
      { type: 'transcript', role: 'source', utteranceId: 'u2', text: 'Tell me a joke.', final: true },
      { type: 'transcript', role: 'target', utteranceId: 'u2', text: 'Claro, aquí tiene un chiste.', final: true },
    ])
    const languages = {
      languages: [
        { code: 'en', outputChecks: { markers: [], assistantPatterns: [], refusalPatterns: [] } },
        { code: 'es', outputChecks: { markers: [], assistantPatterns: ['aquí tiene'], refusalPatterns: [] } },
      ],
      canary: null,
    } as unknown as LanguagesResponse
    expect(recentPairs(s, languages)).toEqual([{ source: 'Hello', target: 'Hola' }])
  })
})
