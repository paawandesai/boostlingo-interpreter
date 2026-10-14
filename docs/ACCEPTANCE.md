# Acceptance

Definition of done per requirement. A box is ticked only with evidence (test name, screenshot, log path) written after it. 🎧 = needs a real mic and ears (Paawan).

## 1a. Must-haves (brief §Success Criteria)

- [ ] **M1 SPA with mic capture + playback**  
  Task(s): T0.3 (design), T1.4  
  Acceptance check: Mic permission prompt; capture worklet emits 16 kHz PCM16 frames (unit test on resampler); test tone plays through the playback scheduler  
  Evidence: _pending_

- [ ] **M2 Realtime, `gpt-realtime`, voice in/out**  
  Task(s): T1.5, T1.6  
  Acceptance check: 🎧 EN→ES and ES→EN spoken round trip; secret never in the browser bundle (grep in CI); session config pins model `gpt-realtime`  
  Evidence: _pending_

- [ ] **M3 Cascade STT→Translation→TTS, streaming**  
  Task(s): T2.1–T2.6  
  Acceptance check: Pipeline test proves TTS receives its first chunk before STT emits utterance end on a long utterance (no full-utterance blocking)  
  Evidence: _pending_

- [ ] **M4 Mode toggle pre- and mid-session**  
  Task(s): T1.7 (pre), T3.3 (mid)  
  Acceptance check: Playwright: switch mid-session, transcript history preserved, old transport fully closed (no open WS/peer)  
  Evidence: _pending_

- [ ] **M5 Language pairs ≥ EN↔ES both directions**  
  Task(s): T1.5, T2.6, T4.1 (VI)  
  Acceptance check: Both directions in both modes; a pair added via `languages.json` only  
  Evidence: _pending_

- [ ] **M6 Live source + target transcripts**  
  Task(s): T1.6, T2.6  
  Acceptance check: Partials render as they arrive, finals replace them; both columns update during speech  
  Evidence: _pending_

- [ ] **M7 Per-stage latency visible**  
  Task(s): T3.1, T3.2  
  Acceptance check: Waterfall per utterance; cascade 6 stages, Realtime 3 observable stages plus a label saying model-internal time is opaque  
  Evidence: _pending_

- [ ] **M8 1–2 page comparison write-up**  
  Task(s): T4.4  
  Acceptance check: Covers latency, quality, cost, controllability, recommendation by scenario; every claim cites a number from `/eval/results`  
  Evidence: _pending_

## 1b. Other hard requirements (brief §Other Specific Requirements, §Development Tools)

- [ ] **Provider abstractions, swaps contained**  
  Where it's satisfied: T2.1 interfaces + DI config; T2.4 second translator proves it  
  Evidence: _pending_

- [ ] **Streaming throughout cascade**  
  Where it's satisfied: T2.2 pipeline + M3 test  
  Evidence: _pending_

- [ ] **AGENTS.md / CLAUDE.md on agent direction**  
  Where it's satisfied: T0.1 (initial), T4.5 (final, honest account incl. architect/reviewer loop and cloud session)  
  Evidence: _pending_

- [ ] **Agentic assistant + Git with iterative history**  
  Where it's satisfied: §0 commit rules; no squash  
  Evidence: _pending_

- [ ] **Per-stage latency in UI**  
  Where it's satisfied: M7  
  Evidence: _pending_

- [ ] **Language choice explained**  
  Where it's satisfied: README "Why .NET + TypeScript" section (T4.5)  
  Evidence: _pending_

- [ ] **Deploy optional (AWS preferred)**  
  Where it's satisfied: T5 only after everything else  
  Evidence: _pending_

## 1c. Code-quality expectations (brief §Code Quality)

- [ ] **Mode-specific transport separate from mode-agnostic UI**  
  Enforcement: `web/src/transports/{realtime,cascade}` implement one `Transport` interface; UI imports only the interface and the session store. ESLint `no-restricted-imports` rule blocks `components/**` from importing `transports/*/**` internals  
  Evidence: _pending_

- [ ] **Provider abstractions**  
  Enforcement: `IStreamingStt`, `IStreamingTranslator`, `IStreamingTts` in `server/Interpreter.Core`; vendor SDK/HTTP code only in `server/Interpreter.Providers.*`. An architecture test (NetArchTest or reflection) fails if Core references a Providers assembly  
  Evidence: _pending_

- [ ] **Targeted tests on pipeline + provider boundaries**  
  Enforcement: T2.2 pipeline tests (fakes), T2.3–T2.5 contract tests per adapter, T3.4 error-path tests  
  Evidence: _pending_

- [ ] **Error handling: rate limits, timeouts, empty results, mic denied**  
  Enforcement: T3.4; each maps to `ProviderErrorKind` and a visible UI state with recovery  
  Evidence: _pending_

- [ ] **README: setup, run, architecture**  
  Enforcement: T4.5 (started in T0.2)  
  Evidence: _pending_

- [ ] **Logical commits, meaningful messages**  
  Enforcement: §0 + commitlint  
  Evidence: _pending_

## 1d. Performance benchmarks (brief §Performance Benchmarks)

- [ ] **Realtime < 1.5 s speech end → first audio**  
  Measured by: T3.1 marks, T4.2 replay runs  
  Pass condition: p50 < 1.5 s (report p95 too)  
  Evidence: _pending_

- [ ] **Cascade < 3 s, target < 2 s**  
  Measured by: Same  
  Pass condition: p50 < 3 s required; < 2 s target; p95 reported  
  Evidence: _pending_

- [ ] **5-min back-and-forth, no disconnect**  
  Measured by: T3.6 soak (Playwright, replay audio looped, both modes)  
  Pass condition: 0 disconnects  
  Evidence: _pending_

- [ ] **No audio drift**  
  Measured by: Soak: playback queue length and `drift.skip` count logged  
  Pass condition: Queue length bounded; skips reported  
  Evidence: _pending_

- [ ] **No memory leak**  
  Measured by: Soak: JS heap sampled every 30 s via CDP (`Performance.getMetrics`), plus server working set  
  Pass condition: Heap slope ≈ flat after warm-up (< 10% growth over minutes 1–5); 🎧 DevTools heap snapshot confirms  
  Evidence: _pending_

## 1e. Key impact metrics (brief §Key Impact Metrics)

- [ ] **End-to-end latency (ms)**  
  Evidence produced: p50/p95 per mode × direction (≥ 30 utterances each), cascade stage breakdown, flush-policy variants  
  Task: T3.1, T4.2  
  Evidence: _pending_

- [ ] **Cost per minute**  
  Evidence produced: `response.done` usage (Realtime) and provider units (cascade) × dated list prices; $/min, per-stage cost, projection at 100k and 1M min/month  
  Task: T3.5, T4.3  
  Evidence: _pending_

- [ ] **Quality: subjective**  
  Evidence produced: Blind 1–5 rubric (accuracy, fluency, register, names/numbers); fidelity scorecard (questions, "ignore your instructions"); glossary term accuracy  
  Task: T4.2, T4.3  
  Evidence: _pending_

- [ ] **Quality: WER**  
  Evidence produced: `jiwer` WER per mode × language on source transcripts, with the Realtime transcription caveat  
  Task: T4.3  
  Evidence: _pending_

- [ ] **Provider flexibility**  
  Evidence produced: Hours to add the 2nd translator (git timestamps); lines changed outside the adapter (target: config only); both pass the same contract tests; side-by-side latency/quality/cost  
  Task: T2.4, T4.3  
  Evidence: _pending_

- [ ] **Time to onboard a new pair**  
  Evidence produced: Timed EN↔VI onboarding: minutes, config lines, code changes (target 0); Haitian Creole Realtime probe for coverage  
  Task: T4.1  
  Evidence: _pending_

---
