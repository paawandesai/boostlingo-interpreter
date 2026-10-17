/**
 * Mode-agnostic session state (D12). It owns transcript history, the language pair, speaker
 * side and latency marks, so a transport can be torn down and replaced without losing them.
 * Pure reducer; the controller feeds it transport events.
 */
import type { LanguagesResponse } from './languages'
import { checkContext, checkUtterance } from './outputChecks'
import {
  HISTORY_PAIRS,
  type ErrorKind,
  type HistoryPair,
  type MarkName,
  type Mode,
  type SpeakerSide,
  type TransportEvent,
  type Usage,
} from '../transports/types'

export type Status = 'idle' | 'connecting' | 'live' | 'ended'

export interface Utterance {
  kind: 'utterance'
  id: string
  mode: Mode
  side: SpeakerSide
  source: { text: string; final: boolean; confidence?: number }
  target: { text: string; final: boolean }
  marks: Partial<Record<MarkName, number>>
  usage?: Usage
  /** Speech synthesis failed for this utterance; its text is still shown (T3.4). */
  audioFailed?: boolean
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
  /** Realtime model id; null means the server default. */
  realtimeModel: string | null
  /** Glossary on for this session (T3.7); fixed at start like the language pair. */
  glossary: boolean
  timeline: Array<Utterance | Marker>
  error: { kind: ErrorKind; message: string; retryAfterMs?: number } | null
  level: number
  gated: boolean
  /** Client VAD speech end not yet matched to an utterance (vendor endpointing comes later). */
  pendingSpeechEnd: number | null
  /** Wall-clock spans per mode (ms since epoch), for per-minute cost (T3.5). */
  segments: Array<{ mode: Mode; startedAt: number; endedAt: number | null }>
  /** Session-level usage that belongs to no single utterance (cascade STT audio time). */
  sessionUsage: { sttAudioSeconds: number }
  /** Latest non-blocking notice (a retry in progress, dropped late audio); cleared by the next finished turn. */
  notice: string | null
  /** The user asked for a human interpreter; the AI session was ended (G7). */
  handoffRequested: boolean
  /** Every error and notice, in order, for the session log and the soak report (T3.6). App text only, never transcripts. */
  incidents: Array<{ mode: Mode; kind: ErrorKind | 'notice'; message: string }>
}

export type SessionAction =
  | {
      type: 'configure'
      mode?: Mode
      langA?: string
      langB?: string
      speaker?: SpeakerSide
      realtimeModel?: string
      glossary?: boolean
    }
  | { type: 'started'; at?: number }
  | { type: 'segmentEnded'; at: number }
  | { type: 'ended' }
  /** The transport ended the session itself (a duration limit, the server closing): the transcript stays for export. */
  | { type: 'closed' }
  | { type: 'handoff' }
  | { type: 'dismissError' }
  | { type: 'marker'; text: string }
  | { type: 'transport'; event: TransportEvent }

export const initialState: SessionState = {
  status: 'idle',
  // G17: the default where the pair supports it; the app falls back once languages load.
  mode: 'translate',
  langA: 'en',
  langB: 'es',
  speaker: 'A',
  realtimeModel: null,
  glossary: false,
  timeline: [],
  error: null,
  level: 0,
  gated: false,
  pendingSpeechEnd: null,
  segments: [],
  sessionUsage: { sttAudioSeconds: 0 },
  notice: null,
  handoffRequested: false,
  incidents: [],
}

/**
 * Finished turns, oldest first, for the next connection's context (G9). A turn the output checks flagged
 * (G15) is left out: the translator would read its output as its own earlier answer, so a reply that
 * was not a translation would become a precedent.
 */
export function recentPairs(state: SessionState, languages: LanguagesResponse | null = null): HistoryPair[] {
  const checks = checkContext(languages, state.langA, state.langB)
  return state.timeline
    .filter((x): x is Utterance => x.kind === 'utterance')
    .filter((u) => u.source.final && u.target.final && u.source.text.trim() && u.target.text.trim())
    .filter((u) => checkUtterance(u, state.langA, state.langB, checks).length === 0)
    .slice(-HISTORY_PAIRS)
    .map((u) => ({ source: u.source.text, target: u.target.text }))
}

/** Drops everything said in the session (G20); settings stay. */
function discardTranscript(state: SessionState): SessionState {
  return {
    ...state,
    timeline: [],
    incidents: [],
    segments: [],
    sessionUsage: { sttAudioSeconds: 0 },
    pendingSpeechEnd: null,
    notice: null,
  }
}

/** Below this STT confidence a source line is flagged for the listener (G7). */
export const LOW_CONFIDENCE = 0.8

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
        realtimeModel: locked ? state.realtimeModel : (action.realtimeModel ?? state.realtimeModel),
        glossary: locked ? state.glossary : (action.glossary ?? state.glossary),
      }
    }
    case 'started': {
      // G20: a new session after an ended one starts empty. Only a handoff leaves a transcript behind (for
      // export on that screen); it must never reach the next session's context or its export.
      const base = state.status === 'ended' ? discardTranscript(state) : state
      return {
        ...base,
        status: 'connecting',
        error: null,
        notice: null,
        pendingSpeechEnd: null,
        handoffRequested: false,
        segments:
          action.at === undefined
            ? base.segments
            : [...base.segments, { mode: base.mode, startedAt: action.at, endedAt: null }],
      }
    }
    case 'segmentEnded':
      return {
        ...state,
        segments: state.segments.map((s) => (s.endedAt === null ? { ...s, endedAt: action.at } : s)),
      }
    case 'ended':
      // G20: transcripts live only for the session view; export before End to keep them.
      return { ...discardTranscript(state), status: 'ended', level: 0, gated: false }
    case 'closed':
      // Leaves the live screen with the error that explains why; the next start discards the transcript (G20).
      return { ...state, status: 'ended', level: 0, gated: false, pendingSpeechEnd: null, notice: null }
    case 'handoff':
      // The transcript stays for this screen only, so it can still be exported after the handoff; the next
      // start discards it (G20).
      return {
        ...state,
        pendingSpeechEnd: null,
        notice: null,
        status: 'ended',
        level: 0,
        gated: false,
        handoffRequested: true,
        timeline: [
          ...state.timeline,
          { kind: 'marker', id: `m${state.timeline.length}`, text: 'AI session ended: human interpreter requested' },
        ],
      }
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
    case 'error': {
      const error = { kind: e.kind, message: e.message, retryAfterMs: e.retryAfterMs }
      // The server refused the first connection of a session (wrong or missing access token, or a
      // provider key): back to the setup screen, where the token field is, with the error kept for
      // its banner. After a mode switch or a retry the timeline is not empty, and the live screen
      // stays so the transcript can still be exported before End.
      if (e.kind === 'auth' && state.status === 'connecting' && state.timeline.length === 0)
        return { ...discardTranscript(state), status: 'ended', level: 0, gated: false, error }
      const next = {
        ...state,
        error,
        incidents: [...state.incidents, { mode: state.mode, kind: e.kind, message: e.message }],
      }
      return e.kind === 'tts_failed' && e.utteranceId
        ? updateUtterance(next, e.utteranceId, (u) => ({ ...u, audioFailed: true }))
        : next
    }
    case 'notice':
      return {
        ...state,
        notice: e.message,
        incidents: [...state.incidents, { mode: state.mode, kind: 'notice', message: e.message }],
      }
    case 'transcript': {
      const cleared = e.role === 'target' && e.final ? { ...state, notice: null } : state
      return updateUtterance(cleared, e.utteranceId, (u) => ({
        ...u,
        side: e.side ?? u.side,
        [e.role]:
          e.role === 'source' && e.confidence !== undefined
            ? { text: e.text, final: e.final, confidence: e.confidence }
            : { text: e.text, final: e.final },
      }))
    }
    case 'usage':
      if (e.utteranceId)
        return updateUtterance(state, e.utteranceId, (u) => ({ ...u, usage: addUsage(u.usage, e.usage) }))
      return {
        ...state,
        sessionUsage: { sttAudioSeconds: state.sessionUsage.sttAudioSeconds + (e.usage.sttAudioSeconds ?? 0) },
      }
    case 'mark': {
      if (!e.utteranceId) {
        if (e.name !== 'speech.end') return state
        // The previous turn's speech end was never claimed by an endpoint: nothing was recognised (T3.4).
        const missed =
          state.pendingSpeechEnd !== null && e.t - state.pendingSpeechEnd >= SPEECH_END_MATCH_WINDOW_MS && !state.error
        if (!missed) return { ...state, pendingSpeechEnd: e.t }
        const message = 'The provider recognised no speech in your last turn.'
        return {
          ...state,
          pendingSpeechEnd: e.t,
          error: { kind: 'empty_transcript', message },
          incidents: [...state.incidents, { mode: state.mode, kind: 'empty_transcript', message }],
        }
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

/** Sums usage reports; a field stays undefined until some report has it (never a made-up zero). */
function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b
  const out: Usage = { ...a }
  for (const k of Object.keys(b) as Array<keyof Usage>) {
    const v = b[k]
    if (v !== undefined) out[k] = (out[k] ?? 0) + v
  }
  return out
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
