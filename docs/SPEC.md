# SPEC: AI Interpreter Workbench (Realtime API vs. Cascade Pipeline)

This page restates the Boostlingo brief in the repo's own words; the brief itself is confidential and is not quoted here. Precedence: [GUARDRAILS.md](GUARDRAILS.md) outranks the brief, and the brief outranks everything else in this repo. A conflict between the guardrails and the brief is resolved in the guardrails' favour and recorded in the README under "Known constraints"; any other conflict with the brief is resolved in the brief's favour and recorded in [DECISIONS.md](DECISIONS.md).

## Problem

Boostlingo's business is matching people who need an interpreter with qualified humans. For live spoken interpretation there are now two ways to build an AI alternative:

- **Realtime**: one speech-to-speech model does everything (the OpenAI Realtime API; the brief names `gpt-realtime`, the configured default is `gpt-realtime-2.1`, see the M2 row).
- **Cascade**: a composed pipeline, streaming STT → translation → TTS, with swappable providers per stage.

Which one wins on latency, quality, cost and how much control an operator keeps can only be settled by building both and measuring them the same way. That is what this project does: one browser workbench, both paths behind the same UI and the same instruments, and a recommendation per scenario that rests on the numbers in `eval/results/`.

## Impact metrics (judged)

1. End-to-end latency (ms)
2. Cost per minute
3. Interpretation quality (subjective rubric + WER)
4. Provider flexibility
5. Time to onboard a new language pair

## Must-haves

| # | Requirement |
|---|---|
| M1 | Browser SPA with microphone capture and audio playback |
| M2 | Realtime mode on the OpenAI Realtime API: speech goes in, interpreted speech comes out. The brief names `gpt-realtime`; the model id is configuration (`OpenAI:Realtime:Model`), default `gpt-realtime-2.1` because `gpt-realtime` is deprecated, with `gpt-realtime` still selectable (README "Known constraints", G1) |
| M3 | Cascade mode: STT → Translation → TTS, streaming at every stage (no full-utterance blocking) |
| M4 | UI toggle between modes, pre-session and mid-session |
| M5 | Language pair selection, at least English ↔ Spanish in both directions |
| M6 | Live source and target transcripts as they are produced |
| M7 | Per-stage latency visible in the UI |
| M8 | 1–2 page comparison write-up: latency, quality, cost, controllability, recommendation by scenario |

## Other hard requirements

- Provider abstractions in cascade mode; swapping a provider is a contained change.
- The UI never knows which mode it is talking to: each mode lives behind one `Transport` interface, and components see only that interface and the session store.
- Tests aimed where the risk is: the cascade pipeline itself (ordering, streaming, cancellation, back-pressure) and the seam between the pipeline and each vendor adapter.
- Error handling for rate limits, timeouts, empty results, mic permission denied (plus TTS mid-stream failure and WebRTC drop).
- README with setup, run and architecture; it explains the language choice (.NET + TypeScript).
- AGENTS.md / CLAUDE.md describing how the coding agent was directed.
- Git history of logically scoped commits; no single dump commit, no squash merges.

## Performance benchmarks

| Benchmark | Target |
|---|---|
| Realtime: speech end → first audio out | < 1.5 s (p50; p95 reported) |
| Cascade: speech end → first audio out | < 3 s required, < 2 s target |
| Stability | 5-minute back-and-forth in each mode: no disconnect, no audio drift, no memory leak |

"Speech end" and "first audio out" are defined in [DECISIONS.md](DECISIONS.md) D9 and measured the same way in both modes.

## Scope

**In:** three modes (Realtime, Cascade, and Realtime translate on `gpt-realtime-translate`, added under guardrail task G17 as the default for EN↔ES), EN↔ES (plus EN↔VI added by config only, to measure onboarding time), per-stage latency waterfall, replay harness, session log export, error states, consent step, red-team suite, tests, write-up, and the optional AWS demo (T5, deployed 2026-10-15).

**Out:** auth, multi-user, visual polish, further modes beyond the three above, more than one extra language pair. The plan had put deployment after every acceptance box was ticked; the demo went up on 2026-10-15 before that, which [ACCEPTANCE.md](ACCEPTANCE.md) records as a deviation.

## Stack (locked, see D1/D2)

- Backend: .NET 10, ASP.NET Core minimal API + WebSockets.
- Frontend: TypeScript, React, Vite, AudioWorklet.
- Eval scripts: Python in `/eval` (offline only, not part of the product).

## Timebox

3–4 days, about 15–20 hours. Plan and hour budgets: [TASKS.md](TASKS.md). Definition of done: [ACCEPTANCE.md](ACCEPTANCE.md).
