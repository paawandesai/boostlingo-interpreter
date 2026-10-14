/**
 * Mode-agnostic session state (D12). It owns transcript history, the language pair, speaker
 * side and latency marks, so a transport can be torn down and replaced without losing them.
 * Pure reducer; the controller feeds it transport events.
 */
import type { ErrorKind, MarkName, Mode, SpeakerSide, TransportEvent, Usage } from '../transports/types'

export type Status = 'idle' | 'connecting' | 'live' | 'ended'

export interface Utterance {
  kind: 'utterance'
  id: string
  mode: Mode
  side: SpeakerSide
  source: { text: string; final: boolean }
  target: { text: string; final: boolean }
  marks: Partial<Record<MarkName, number>>
  usage?: Usage
}

export interface Marker {
  kind: 'marker'
  id: string
  text: string
}

export interface SessionState {
  status: Status
  mode: Mode
  langA: string
  langB: string
  speaker: SpeakerSide
  timeline: Array<Utterance | Marker>
  error: { kind: ErrorKind; message: string; retryAfterMs?: number } | null
  level: number
  gated: boolean
  /** Client VAD speech end not yet matched to an utterance (vendor endpointing comes later). */
  pendingSpeechEnd: number | null
}

export type SessionAction =
  | { type: 'configure'; mode?: Mode; langA?: string; langB?: string; speaker?: SpeakerSide }
  | { type: 'started' }
  | { type: 'ended' }
  | { type: 'dismissError' }
  | { type: 'marker'; text: string }
  | { type: 'transport'; event: TransportEvent }

export const initialState: SessionState = {
  status: 'idle',
  mode: 'realtime',
  langA: 'en',
  langB: 'es',
  speaker: 'A',
  timeline: [],
  error: null,
  level: 0,
  gated: false,
  pendingSpeechEnd: null,
}

/** A speech end older than this can't belong to the next endpoint event. */
const SPEECH_END_MATCH_WINDOW_MS = 5000

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'configure': {
      // Language pair is locked during a session; mode and speaker are not.
      const locked = state.status === 'connecting' || state.status === 'live'
      return {
        ...state,
        mode: action.mode ?? state.mode,
        speaker: action.speaker ?? state.speaker,
        langA: locked ? state.langA : (action.langA ?? state.langA),
        langB: locked ? state.langB : (action.langB ?? state.langB),
      }
    }
    case 'started':
      return { ...state, status: 'connecting', error: null, pendingSpeechEnd: null }
    case 'ended':
      return { ...state, status: 'ended', level: 0, gated: false }
    case 'dismissError':
      return { ...state, error: null }
    case 'marker':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'marker', id: `m${state.timeline.length}`, text: action.text }],
      }
    case 'transport':
      return applyEvent(state, action.event)
  }
}

function applyEvent(state: SessionState, e: TransportEvent): SessionState {
  switch (e.type) {
    case 'state':
      if (e.state === 'live') return { ...state, status: 'live' }
      if (e.state === 'connecting') return { ...state, status: 'connecting' }
      return state
    case 'level':
      return { ...state, level: e.rms }
    case 'gated':
      return { ...state, gated: e.gated }
    case 'error':
      return { ...state, error: { kind: e.kind, message: e.message, retryAfterMs: e.retryAfterMs } }
    case 'transcript':
      return updateUtterance(state, e.utteranceId, (u) => ({
        ...u,
        [e.role]: { text: e.text, final: e.final },
      }))
    case 'usage':
      return e.utteranceId ? updateUtterance(state, e.utteranceId, (u) => ({ ...u, usage: e.usage })) : state
    case 'mark': {
      if (!e.utteranceId) {
        return e.name === 'speech.end' ? { ...state, pendingSpeechEnd: e.t } : state
      }
      let pending = state.pendingSpeechEnd
      const next = updateUtterance(state, e.utteranceId, (u) => {
        const marks = { ...u.marks, [e.name]: u.marks[e.name] ?? e.t }
        if (e.name === 'endpoint' && pending !== null && pending <= e.t && e.t - pending < SPEECH_END_MATCH_WINDOW_MS) {
          marks['speech.end'] ??= pending
          pending = null
        }
        return { ...u, marks }
      })
      return { ...next, pendingSpeechEnd: pending }
    }
  }
}

function updateUtterance(state: SessionState, id: string, f: (u: Utterance) => Utterance): SessionState {
  const idx = state.timeline.findIndex((x) => x.kind === 'utterance' && x.id === id)
  if (idx === -1) {
    const fresh: Utterance = {
      kind: 'utterance',
      id,
      mode: state.mode,
      side: state.speaker,
      source: { text: '', final: false },
      target: { text: '', final: false },
      marks: {},
    }
    return { ...state, timeline: [...state.timeline, f(fresh)] }
  }
  const timeline = state.timeline.slice()
  timeline[idx] = f(timeline[idx] as Utterance)
  return { ...state, timeline }
}

/** Headline latency for one utterance: client speech end to first audio out (D9). */
export function headlineLatencyMs(u: Utterance): number | null {
  const start = u.marks['speech.end']
  const end = u.marks['audio.first_out']
  return start === undefined || end === undefined ? null : end - start
}
