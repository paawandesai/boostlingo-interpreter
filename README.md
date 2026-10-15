# AI Interpreter Workbench: Realtime API vs. Cascade Pipeline

A browser workbench that interprets live speech two ways and measures both:

- **Realtime translate** (default where the pair is supported): OpenAI `gpt-realtime-translate`, a streaming translation model that takes only a target language, over WebRTC.
- **Realtime**: OpenAI Realtime API (`gpt-realtime-2.1` by default; the brief's `gpt-realtime` is deprecated but selectable), voice in, voice out, over WebRTC.
- **Cascade**: streaming STT → translation → TTS on the server, with swappable providers per stage.

The comparison is in [docs/WRITEUP.md](docs/WRITEUP.md) (draft); the numbers behind it are in [eval/results/](eval/results/).

Built for the Boostlingo Week 4 brief. Spec: [docs/SPEC.md](docs/SPEC.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agent workflow: [AGENTS.md](AGENTS.md).

## Prerequisites

- .NET 10 SDK
- Node 22 and npm
- Headphones. Realtime and Cascade close the mic while the interpreter speaks, but Realtime translate speaks while you are still talking, so the mic stays open and only the browser's echo cancellation stands between its voice and a re-translation. The setup screen says so for that mode.
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

Open http://localhost:5173. The page shows "Backend: ok" when the round trip works. Enter the access token, pick a mode and a language pair, tick the consent box (both parties must be told an AI interprets them), then Start.

Put keys in a `.env` at the repo root (copy `.env.example`; it is git-ignored) and load it with `set -a; source .env; set +a`, since a plain `source` does not export them.

### Keys

Every key stays on the server. The browser gets only a short-lived, single-session secret for Realtime, minted by `POST /api/realtime/session`, which requires the access token and is rate-limited.

| Variable | Needed for | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Realtime, Realtime translate, OpenAI transcription | No free tier for Realtime models; set a spend cap in the OpenAI dashboard |
| `DEMO_ACCESS_TOKEN` | Every session | Any long random string; typed into the setup screen |
| `DEEPGRAM_API_KEY` | Cascade with Deepgram STT | Or `Cascade__Stt=openai` |
| `ELEVENLABS_API_KEY` | Cascade TTS | Paid plan required; stock voices only |
| `CLAUDE_TRANSLATOR_API_KEY` | Cascade with `Cascade__Translator=anthropic` | |

## Test

```bash
dotnet test --solution server/Interpreter.slnx --filter-not-trait "Category=Live"
cd web && npm run lint && npm run typecheck && npm test
```

Live provider checks (call the real APIs with synthetic speech; skipped for any key that isn't set; not run in CI):

```bash
dotnet test --solution server/Interpreter.slnx --filter-trait "Category=Live"
```

## Evaluation

```bash
python3 -m pip install -r eval/requirements.txt
python3 eval/summarize.py eval/results/logs/*.json   # writes eval/results/summary.md
python3 -m unittest discover -s eval -p 'test_*.py'
```

The replay clips (`eval/replay/`) and the 5-minute soak (`web/e2e/soak.spec.ts`, manual CI job `e2e:soak`) produce the session logs it reads. Replay audio is never committed. Latency from runs on Deepgram STT is withheld, since its terms bar benchmarking.

## Architecture

The browser captures 16 kHz PCM in an AudioWorklet with a local VAD, and plays output through a scheduler that marks the first audible frame. One `Transport` interface hides the mode: the Realtime and Realtime translate transports speak WebRTC straight to OpenAI with an ephemeral secret; the cascade transport streams PCM over a WebSocket to the .NET server, which runs STT, translation and TTS as a back-pressured pipeline of `IAsyncEnumerable` stages behind provider interfaces. The UI, transcript store, output checks and latency waterfall are the same for every mode. Diagram and data flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Why .NET + TypeScript

The brief prefers .NET and asks for the choice to be explained. The cascade is a streaming problem, and .NET makes the hard parts explicit and testable: `System.Threading.Channels` with bounded capacity for back-pressure, `CancellationToken` for teardown on a speaker switch or End, Kestrel WebSockets with no extra libraries. Vendor adapters talk to the raw WebSocket and HTTP APIs instead of SDKs, so the only vendor-specific code lives in `Interpreter.Providers.*`. The cost was writing those adapters by hand; a Python voice framework would have been faster but would hide the streaming, flush policy and provider seams this project is meant to show. The browser side is TypeScript because audio capture, WebRTC and playback timing only exist there. Python is used only for the offline eval scripts, where `jiwer` and `sacrebleu` are the standard tools; it is never part of the app. Full reasoning: [docs/DECISIONS.md](docs/DECISIONS.md) D1 and D2.

## CI

Local hooks: lint-staged and the secret check on commit, commitlint on the message, build and test on push. GitLab CI runs change-scoped jobs (web, server, eval, gitleaks); the bundle is grepped for key-like strings. Live provider tests and the soak are manual jobs because they make billed calls.

Step times and peak memory, cloud container, warm caches:

| Step | Day 1 (skeleton) | Day 4 (2026-10-15) |
|---|---|---|
| npm ci | 3.5 s, 375 MB | 10.6 s, 351 MB |
| eslint | 1.7 s, 223 MB | 6.5 s, 405 MB |
| prettier --check | 0.9 s, 104 MB | 6.1 s, 273 MB |
| tsc | 1.9 s, 258 MB | 5.1 s, 291 MB |
| vitest run | 1.8 s, 168 MB | 16.0 s, 211 MB |
| vite build | 1.0 s, 192 MB | 2.0 s, 230 MB |
| dotnet restore | 1.8 s, 165 MB | 2.4 s, 157 MB |
| dotnet format --verify-no-changes | 9.3 s, 255 MB | 26.7 s, 352 MB |
| dotnet build -m:1 | 3.1 s, 173 MB | 13.2 s, 191 MB |
| dotnet test (not Live) | 2.6 s, 124 MB | 7.4 s, 156 MB |

Every step stays under the smallest runner slot's 1.5 GB. `dotnet format` is now the slowest step; it runs only when server files change.

## Public demo (AWS)

A manual CI job, `deploy:aws` on `main`, runs [infra/deploy.sh](infra/deploy.sh). It builds the image with the .NET SDK (`dotnet publish -p:DemoImage=true /t:PublishContainer`, no Docker daemon), with the built SPA and `config/` inside and no keys. It pushes the image to ECR, writes the keys to one Secrets Manager secret, and deploys [infra/demo.yml](infra/demo.yml): ECS Fargate behind a load balancer that only CloudFront can reach, with CloudFront providing HTTPS (the mic needs a secure page) and WebSockets.

- **Gate:** every session needs the access token; minting and the cascade socket are rate-limited per client address, read past the two proxies so a client can't pick its own.
- **Not indexed:** `X-Robots-Tag: noindex` on every response and a `robots.txt` that disallows everything.
- **Banner:** the page always says it is AI interpretation with synthetic data only.
- **Nothing to purge:** no audio or transcript is stored, and logs (ids and status codes only) expire after a day.
- **Turns itself off:** a one-time schedule scales the service to zero at `SHUTDOWN_AT` (default 14 days after deploy). After grading, rotate `DEMO_ACCESS_TOKEN` or run `aws cloudformation delete-stack --stack-name interpreter-demo`.
- Cascade runs on OpenAI transcription in the demo; Deepgram is not used.

## Layout

```
server/   .NET 10: Interpreter.Api, Interpreter.Core, Interpreter.Providers.*, Interpreter.Tests
web/      React + Vite + TypeScript SPA (audio/, transports/, session/, components/)
config/   languages.json (adding a language pair is config only), glossary.json, prices.json
eval/     replay clips script, red-team suite, summarize.py, results/
infra/    demo.yml (CloudFormation) and deploy.sh for the public demo
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
