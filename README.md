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
- **No consent step or AI disclosure in the UI yet.** Both are required before capture starts (see Known constraints).
- **Unverified:** the Realtime fidelity of the interpreter prompt beyond two manual round trips; any latency figure from fewer than a full 5-minute run; every model-generated artifact listed in [AI_USAGE.md](AI_USAGE.md).

## Known constraints

Conflicts between [docs/GUARDRAILS.md](docs/GUARDRAILS.md) and the brief or plan, and how each was resolved. The rule wins every time.

| Conflict | Resolution | Status |
|---|---|---|
| The brief asks for a latency and quality comparison that includes the cascade STT vendor. Deepgram's Terms of Service, clause (i), forbid using the service "for competitive purposes, including ... benchmarking and other competitive analysis" without written consent. | Paawan is asking Deepgram for written consent (decided 2026-10-14). An OpenAI transcription adapter is added on Day 2 as the fallback. If consent has not arrived by the write-up, published cascade numbers use OpenAI transcription, and Deepgram appears only as a swappable adapter with no numbers. | Open: awaiting Deepgram |
| The brief's success criteria start capture on "Start session". The guardrails require telling both parties that third-party AI processes the audio, and an all-party consent step before capture (California Penal Code 632). | A consent and AI-disclosure step goes in before the mic opens, in both languages. | Open: planned for Day 3 failure-and-states work |
| The brief ranks modes on latency, cost and quality. The guardrails require the recommendation to account for regulated settings first. | The write-up recommends AI modes for low-stakes and consumer use and a human in the loop for medical and legal use. Latency and cost are secondary factors. | Applies to the Day 4 write-up |
| "Interpretation quality (subjective + WER)". WER measures STT only, and the Realtime source column comes from a separate transcription model. | WER is reported as transcription accuracy only. Translation quality uses chrF or COMET (`wmt22-comet-da`, Apache-2.0) against human-written or human-checked references, plus a blind human rubric labelled as subjective. | Applies to Day 4 measurement |
| The guardrails forbid the ElevenLabs free plan (non-commercial, attribution required). | Paawan moved to a paid ElevenLabs plan on 2026-10-14. | Resolved |
| The brief requires `gpt-realtime`. The guardrails say it is deprecated (removal 2027-01-20) and that the model id must be configuration, defaulting to `gpt-realtime-2.1`. | `OpenAI:Realtime:Model` defaults to `gpt-realtime-2.1`. `gpt-realtime` stays selectable in the setup screen so the brief's model can still be measured. The write-up notes the deprecation. Both ids are listed by the OpenAI API and both mint sessions (checked 2026-10-14). The deprecation dates are unverified. | Done (G1); write-up note on Day 4 |
| The brief's Realtime/cascade framing has two options. The guardrails require evaluating `gpt-realtime-translate` as a third option. | It is measured on the same replay set, or the write-up explains why not. | Open: Day 4 (G11) |
| The Realtime client-secret endpoint was unauthenticated, which is fine for a local run. The guardrails require it to be authenticated and rate-limited. | It now requires the `DEMO_ACCESS_TOKEN` (sent as `X-Access-Token`, compared in constant time) and allows 10 requests per client per minute by default (`Access:PermitLimit`). The cascade WebSocket gets the same guard in T2.6. | Done (G2) |
| AGENTS.md and CLAUDE.md are graded deliverables. The guardrails require them in the candidate's own voice with no internal URLs. They are currently agent-written and name the GitLab host. | Paawan rewrites them before submission. | Open: Day 4 (G13) |
