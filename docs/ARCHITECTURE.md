# Architecture

Two transports behind one interface, one mode-agnostic UI and session store. The browser never holds a vendor API key.

## Components

```mermaid
flowchart LR
  subgraph Browser["Browser SPA (React + Vite)"]
    UI["components/*<br/>mode-agnostic UI"]
    Store["session/store<br/>transcripts, pair, speaker side,<br/>latency history"]
    Calc["session/latency<br/>computeLatency(marks)"]
    Audio["audio/*<br/>capture worklet (resample + VAD)<br/>playback scheduler"]
    RT["transports/realtime<br/>WebRTC"]
    CT["transports/cascade<br/>WebSocket"]
    UI --> Store
    Store --> Calc
    Store -- "Transport interface" --> RT
    Store -- "Transport interface" --> CT
    Audio --> RT
    Audio --> CT
  end

  subgraph Server["Backend (.NET 10 minimal API)"]
    Api["Interpreter.Api<br/>/health, /api/realtime/session, /ws/cascade"]
    Core["Interpreter.Core<br/>IStreamingStt / IStreamingTranslator / IStreamingTts<br/>Pipeline, FlushPolicy, ProviderException"]
    Prov["Interpreter.Providers.*<br/>Deepgram, OpenAI, Anthropic, ElevenLabs"]
    Api --> Core
    Api --> Prov
    Core -. "interfaces only" .- Prov
  end

  RT -- "POST /api/realtime/session" --> Api
  RT == "WebRTC audio + data channel (ek_ secret)" ==> OpenAI["OpenAI Realtime<br/>gpt-realtime"]
  Api -- "POST /v1/realtime/client_secrets (API key)" --> OpenAI
  CT == "WS: PCM16 16 kHz up, PCM 24 kHz down, JSON events" ==> Api
  Prov --> Vendors["Deepgram STT · OpenAI / Claude translation · ElevenLabs TTS"]
```

Rules enforced by tooling (see [ACCEPTANCE.md](ACCEPTANCE.md)):
- `web/src/components/**` may not import `web/src/transports/*/**` internals (ESLint `no-restricted-imports`).
- `Interpreter.Core` may not reference any `Interpreter.Providers.*` assembly (architecture test).
- Vendor SDK/HTTP/WS code lives only in `Interpreter.Providers.*`.

## Transport interface (web)

```ts
interface Transport {
  start(config: SessionConfig): Promise<void>;   // mic stream, pair, speaker side, input source
  stop(): Promise<void>;                          // closes peer/WS, disconnects nodes, stops worklets
  readonly events: EventTarget;                   // transcript.partial|final, translation.delta|final,
                                                  // latency.mark, error, state
}
```

The store owns transcript history, so a mid-session toggle is `await current.stop(); await next.start(config)` plus a "switched to X" marker (D12).

## Realtime data path

```mermaid
sequenceDiagram
  autonumber
  participant Mic as Mic + capture worklet
  participant B as Browser (Realtime transport)
  participant S as Backend
  participant O as OpenAI Realtime (gpt-realtime)
  B->>S: POST /api/realtime/session {pair, speakerSide}
  S->>O: POST /v1/realtime/client_secrets (server API key, session config: model, instructions, VAD, transcription, voice)
  O-->>S: { value: "ek_...", expires_at }
  S-->>B: { clientSecret, expiresAt } (secret only)
  B->>O: POST /v1/realtime/calls (SDP offer, Bearer ek_...)  [verify path]
  O-->>B: SDP answer
  Mic->>B: mic track (Opus over WebRTC)
  Note over Mic: client VAD mark: speech.end (headline start)
  O-->>B: input_audio_buffer.speech_stopped (endpointing)
  O-->>B: response.created
  O-->>B: remote audio track (translated speech)
  Note over B: AnalyserNode on remote track: first non-silent frame = first audio out
  O-->>B: conversation.item.input_audio_transcription.delta/completed (source text)
  O-->>B: response.output_audio_transcript.delta/done (target text)
  O-->>B: response.done (usage for cost)
```

Event names checked against the `openai` npm package v7.32.0 type definitions on 2026-10-14. The WebRTC SDP path is checked live in T1.5.

## Cascade data path

```mermaid
sequenceDiagram
  autonumber
  participant Mic as Mic + capture worklet
  participant B as Browser (Cascade transport)
  participant P as Backend pipeline
  participant STT as IStreamingStt (Deepgram)
  participant TR as IStreamingTranslator (OpenAI / Claude)
  participant FP as FlushPolicy
  participant TTS as IStreamingTts (ElevenLabs)
  B->>P: WS connect + ping/pong (clock offset)
  Mic->>B: PCM16 16 kHz frames
  B->>P: binary audio frames
  P->>STT: audio stream
  STT-->>P: Partial(text) ... Final(text)
  P-->>B: transcript.partial / transcript.final (server ts)
  Note over Mic: client VAD mark: speech.end
  STT-->>P: UtteranceEnd (endpointing)
  P->>TR: translate each Final segment (streaming)
  TR-->>FP: token deltas (first token = translation TTFT)
  FP->>TTS: clause/sentence chunks (first flush)
  P-->>B: translation.delta
  TTS-->>P: PCM 24 kHz chunks (first chunk = TTS TTFB)
  P-->>B: binary audio frames
  Note over B: playback scheduler: first source.start(when) = first audio out
```

Internals: `System.Threading.Channels` with bounded capacity between stages (back-pressure), one linked `CancellationToken` per session so teardown cancels every stage, and every adapter throws only `ProviderException { Kind, RetryAfter }` (D8).

## Latency mark points (D9)

All marks are on the client clock (`performance.now()`); server timestamps are converted with a ping/pong offset (min-RTT sample, re-estimated every 30 s).

| Mark | Realtime | Cascade |
|---|---|---|
| `speech.end` (headline start) | client energy VAD, back-dated to last voiced frame | same code |
| `endpoint` | `input_audio_buffer.speech_stopped` | STT `UtteranceEnd` / endpoint final |
| `stt.final` | n/a (transcription runs on a separate model) | STT final for the utterance |
| `translation.first_token` | opaque | translator first delta |
| `tts.first_flush` | opaque | FlushPolicy first emit |
| `tts.first_byte` | opaque | first TTS audio chunk at server |
| `response.created` | data channel event | n/a |
| `audio.first_out` (headline end) | first non-silent frame on remote track | first chunk `source.start(when)` |

Realtime shows endpointing → `response.created` → first audio, and labels model-internal time as opaque. Cascade shows all six stages. `AudioContext.outputLatency` is reported alongside, because "heard" (Realtime probe) and "scheduled" (cascade) differ by output latency.

## Audio

- Capture: `getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })` at the context's native rate; the worklet downsamples to 16 kHz PCM16 for cascade and runs the client VAD for both modes.
- Playback (cascade): scheduler with a cursor and a 3 s cap on queued audio; overflow drops the oldest unplayed chunk and logs `drift.skip` (D14).
- Echo: half-duplex mic gating while output plays, 150 ms tail (D13). Headphones recommended.
- Teardown on stop: close peer and sockets, disconnect nodes, terminate worklet ports, revoke object URLs.
