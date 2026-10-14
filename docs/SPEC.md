# SPEC: AI Interpreter Workbench (Realtime API vs. Cascade Pipeline)

Source of truth: the Boostlingo Week 4 brief. If anything in this repo conflicts with the brief, the brief wins and the conflict is recorded in [DECISIONS.md](DECISIONS.md).

## Problem

Boostlingo connects people who need interpretation with professional human interpreters. AI now offers two architectures for live interpretation:

- **Realtime**: a direct voice-to-voice model (OpenAI Realtime API, `gpt-realtime`).
- **Cascade**: a composed pipeline, streaming STT → translation → TTS, with swappable providers per stage.

The trade-offs (latency, quality, cost, operational control) are not obvious until both are built. This project builds both in one browser workbench, instruments them identically, and produces a defensible recommendation of which mode fits which scenario.

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
| M2 | Realtime mode using the OpenAI Realtime API (`gpt-realtime`), voice in, voice out |
| M3 | Cascade mode: STT → Translation → TTS, streaming at every stage (no full-utterance blocking) |
| M4 | UI toggle between modes, pre-session and mid-session |
| M5 | Language pair selection, at least English ↔ Spanish in both directions |
| M6 | Live source and target transcripts as they are produced |
| M7 | Per-stage latency visible in the UI |
| M8 | 1–2 page comparison write-up: latency, quality, cost, controllability, recommendation by scenario |

## Other hard requirements

- Provider abstractions in cascade mode; swapping a provider is a contained change.
- Clean separation between mode-specific transport and mode-agnostic UI.
- Targeted tests on the cascade pipeline and provider boundaries.
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

**In:** two modes, EN↔ES (plus EN↔VI added by config only, to measure onboarding time), per-stage latency waterfall, replay harness, session log export, error states, tests, write-up.

**Out:** auth, multi-user, visual polish, a third mode, more than one extra language pair, deployment (optional AWS only after every acceptance box is ticked).

## Stack (locked, see D1/D2)

- Backend: .NET 10, ASP.NET Core minimal API + WebSockets.
- Frontend: TypeScript, React, Vite, AudioWorklet.
- Eval scripts: Python in `/eval` (offline only, not part of the product).

## Timebox

3–4 days, about 15–20 hours. Plan and hour budgets: [TASKS.md](TASKS.md). Definition of done: [ACCEPTANCE.md](ACCEPTANCE.md).
