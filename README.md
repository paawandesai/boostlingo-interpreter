# AI Interpreter Workbench: Realtime API vs. Cascade Pipeline

A browser workbench that interprets live speech two ways and measures both:

- **Realtime mode**: OpenAI Realtime API (`gpt-realtime`), voice in, voice out, over WebRTC.
- **Cascade mode**: streaming STT → translation → TTS, with swappable providers per stage.

Built for the Boostlingo Week 4 brief. Spec: [docs/SPEC.md](docs/SPEC.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agent workflow: [AGENTS.md](AGENTS.md).

> Status: skeleton. Setup, keys, architecture overview and "Why .NET + TypeScript" are completed in T4.5.

## Prerequisites

- .NET 10 SDK
- Node 22 and npm
- Headphones (the interpreter's voice otherwise leaks back into the mic)
- Optional: [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-commit secret scan (`brew install gitleaks`). CI runs it either way.

## Run locally

```bash
# terminal 1: backend on http://localhost:5080
export OPENAI_API_KEY=...          # server only
export DEMO_ACCESS_TOKEN=...       # any long random string; enter it in the setup screen
# Cascade mode also needs (all server only):
export DEEPGRAM_API_KEY=...        # STT; or run with Cascade__Stt=openai to use OpenAI transcription
export ELEVENLABS_API_KEY=...      # TTS; a paid plan (the free plan is non-commercial)
export CLAUDE_TRANSLATOR_API_KEY=...  # only if Cascade__Translator=anthropic (ANTHROPIC_API_KEY also works locally)
dotnet run --project server/Interpreter.Api

# terminal 2: frontend on http://localhost:5173 (proxies /health, /api, /ws to the backend)
cd web && npm ci && npm run dev
```

Open http://localhost:5173. The page shows "Backend: ok" when the round trip works.

## Test

```bash
dotnet test --solution server/Interpreter.slnx --filter-not-trait "Category=Live"
cd web && npm run lint && npm run typecheck && npm test
```

Live provider checks (call the real APIs with synthetic speech; skipped for any key that isn't set; not run in CI):

```bash
dotnet test --solution server/Interpreter.slnx --filter-trait "Category=Live"
```

## Layout

```
server/   .NET 10: Interpreter.Api, Interpreter.Core, Interpreter.Providers.*, Interpreter.Tests
web/      React + Vite + TypeScript SPA (audio/, transports/, session/, components/)
config/   languages.json (adding a language pair is config only)
docs/     spec, architecture, tasks, acceptance, decisions
```

## What this does not do (yet), and what is unverified

This is an evaluation workbench, not a product. [docs/GUARDRAILS.md](docs/GUARDRAILS.md) outranks the brief; where they conflict, the conflict is listed under "Known constraints" below.

- **Not an interpreter of record.** It is not a "qualified interpreter" under ACA Section 1557 (45 CFR 92.4), and it must not be used for medical, legal or court interpreting without a qualified human in the loop.
- **Not HIPAA-compliant.** It is designed with HIPAA in mind (keys stay on the server, no transcripts are logged), but this deployment is not HIPAA-compliant: no Business Associate Agreement is in place with OpenAI, Deepgram, Anthropic or ElevenLabs, and zero-retention terms are not provisioned. Use scripted, synthetic speech only.
- **Cascade mode will send conversation content to three vendors at once** (STT, translation and TTS). Realtime mode sends it to one.
- **A mid-session mode switch carries only the last 6 finished turns.** The new connection (Realtime session or cascade socket) gets them as context data, so names and register carry over; it has no other memory of the conversation. Cascade opens a new socket on every speaker switch and carries the same 6 turns.
- **Transcripts are discarded at End** (G20). Use **Export log** before **End** to keep a session; End asks first when there are unexported lines.
- **Output checks are heuristics.** Every translated line is checked for the wrong language, an odd length ratio, assistant phrasing, refusals and the prompt-leak canary, and flagged lines offer the human handoff. A clean line is not verified, and the word lists in `config/languages.json` are model-written.
- **The human-interpreter handoff is a stub.** "Request human interpreter" ends the AI session at once, but this demo has no interpreter queue, so no request goes anywhere.
- **The spoken AI notice uses the browser's own speech synthesis**, so its voice and availability depend on the browser and OS. The written notice and consent box are always shown.
- **Unverified:** the Realtime fidelity of the interpreter prompt beyond two manual round trips; any latency figure from fewer than a full 5-minute run; every model-generated artifact listed in [AI_USAGE.md](AI_USAGE.md).

## Known constraints

Conflicts between [docs/GUARDRAILS.md](docs/GUARDRAILS.md) and the brief or plan, and how each was resolved. The rule wins every time.

| Conflict | Resolution | Status |
|---|---|---|
| The brief asks for a latency and quality comparison that includes the cascade STT vendor. Deepgram's Terms of Service, clause (i), forbid using the service "for competitive purposes, including ... benchmarking and other competitive analysis" without written consent. | Paawan is asking Deepgram for written consent (decided 2026-10-14). Both STT adapters are built (Day 2): Deepgram, which sets `mip_opt_out=true` on every connection so audio is excluded from Deepgram's model training (G4), and the OpenAI transcription fallback. Live tests check behaviour only and record no numbers. If consent has not arrived by the write-up, published cascade numbers use OpenAI transcription, and Deepgram appears only as a swappable adapter with no numbers. | Open: awaiting Deepgram |
| The brief's success criteria start capture on "Start session". The guardrails require telling both parties that third-party AI processes the audio, and an all-party consent step before capture (California Penal Code 632). | The setup screen shows the AI notice in both languages (from `config/languages.json`) and the vendors the chosen mode sends audio to, and Start stays disabled until "Both parties were told and agree" is ticked. The notice is read aloud in both languages before the mic opens. A persistent "not a qualified human interpreter" banner and a "Request human interpreter" button are always visible. Cascade source lines below 0.8 STT confidence are flagged; Realtime source lines say confidence is unknown. | Done (G7, T3.8); the Spanish notice needs a native-speaker check |
| The brief ranks modes on latency, cost and quality. The guardrails require the recommendation to account for regulated settings first. | The write-up recommends AI modes for low-stakes and consumer use and a human in the loop for medical and legal use. Latency and cost are secondary factors. | Applies to the Day 4 write-up |
| "Interpretation quality (subjective + WER)". WER measures STT only, and the Realtime source column comes from a separate transcription model. | WER is reported as transcription accuracy only. Translation quality uses chrF or COMET (`wmt22-comet-da`, Apache-2.0) against human-written or human-checked references, plus a blind human rubric labelled as subjective. | Applies to Day 4 measurement |
| The guardrails forbid the ElevenLabs free plan (non-commercial, attribution required). | Paawan moved to a paid ElevenLabs plan on 2026-10-14. | Resolved |
| The brief requires `gpt-realtime`. The guardrails say it is deprecated (removal 2027-01-20) and that the model id must be configuration, defaulting to `gpt-realtime-2.1`. | `OpenAI:Realtime:Model` defaults to `gpt-realtime-2.1`. `gpt-realtime` stays selectable in the setup screen so the brief's model can still be measured. The write-up notes the deprecation. Both ids are listed by the OpenAI API and both mint sessions (checked 2026-10-14). The deprecation dates are unverified. | Done (G1); write-up note on Day 4 |
| The brief's Realtime/cascade framing has two options. The guardrails require evaluating `gpt-realtime-translate` as a third option. | It is measured on the same replay set, or the write-up explains why not. | Open: Day 4 (G11) |
| The Realtime client-secret endpoint was unauthenticated, which is fine for a local run. The guardrails require it to be authenticated and rate-limited. | It now requires the `DEMO_ACCESS_TOKEN` (sent as `X-Access-Token`, compared in constant time) and allows 10 requests per client per minute by default (`Access:PermitLimit`). The cascade WebSocket (`/ws/cascade`) has the same guard: the rate limit applies to the upgrade, and the token is checked in the first message because browsers can't set WebSocket headers. | Done (G2) |
| The guardrails require LLM translation at temperature 0 (G16). `claude-haiku-5-5` rejects the parameter (HTTP 400, "`temperature` is deprecated for this model", checked 2026-10-14). | The OpenAI translator sends `temperature: 0`. The Anthropic adapter sends it only when `Anthropic:Translation:Temperature` is set, so with Haiku it runs at the vendor default. The other structural controls (no tools, transcript as delimited data, per-segment output cap, output checks) apply to both. | Constraint |
| The guardrails want Realtime to default to `gpt-realtime-translate` where the pair is supported (G17). | Done: "Realtime translate" is a third mode and the default for English ↔ Spanish (`realtimeTranslate` in `config/languages.json`). The minted session carries a target language only, no instructions and no tools; a speaker flip changes only the output language. `gpt-realtime-2.1` (Realtime) and Cascade stay selectable. The SDP exchange was checked live; the audio path was not (WebRTC media can't connect from the cloud container). | Built; audio check is manual |
| Realtime translate speaks while the speaker is still talking, so the half-duplex mic gate can't apply. | The mic stays open in that mode and the setup screen says headphones are required. Browser echo cancellation is the only defence against re-translating its own voice; the red-team "TTS echo" lines in `eval/adversarial/` are the test. | Open until the red-team run |
| Speech end to first audio (D9) is often negative for a simultaneous interpreter. | The same total is still reported where it can be measured, plus a start lag (client speech start to first audible output) on lines that start after a pause, and a text lag (first source text to first translated text as they reach the browser) on every line. Lines are cut client-side by pairing each translated sentence with the source sentence that had started when it began (both streams carry the model's `elapsed_ms`); a recorded live stream pairs all ten sentences this way, but boundaries stay approximate and the UI and export say so. | Reported as defined |
| Realtime translate has no context input, so a mode switch into it can't carry the last turns (G9). | The switch marker says it starts with no memory of the conversation. | Accepted |
| `gpt-realtime-translate` price. | The guardrails quote $0.034/min; OpenAI's pricing page is blocked from the cloud container, so `config/prices.json` keeps it null and the cost table shows it as unpriced. | Paawan to check |
| The checklist's soak memory criterion is < 10% heap growth from minute 1 to 5. | Measured +14.4% in the final cascade run, flat (−0.07 MB/min) over minutes 3–5: the growth is the on-screen transcript window filling and the store keeping every turn for export. Reported as measured, not re-tuned. | Reported |
| AGENTS.md and CLAUDE.md are graded deliverables. The guardrails require them in the candidate's own voice with no internal URLs. They are currently agent-written and name the GitLab host. | Paawan rewrites them before submission. | Open: Day 4 (G13) |
