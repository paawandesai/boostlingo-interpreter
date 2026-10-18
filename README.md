# AI Interpreter Workbench: Realtime API vs. Cascade Pipeline

A browser workbench that interprets live speech two ways and measures both:

- **Realtime translate** (default where the pair is supported): OpenAI `gpt-realtime-translate`, a streaming translation model that takes only a target language, over WebRTC.
- **Realtime**: OpenAI Realtime API (`gpt-realtime-2.1` by default; the brief's `gpt-realtime` is deprecated but stays selectable, labelled "(deprecated by OpenAI)" in the setup screen), voice in, voice out, over WebRTC.
- **Cascade**: streaming STT → translation → TTS on the server, with swappable providers per stage.

The comparison is in [docs/WRITEUP.md](docs/WRITEUP.md) (method detail and the longer analyses in [docs/WRITEUP-APPENDIX.md](docs/WRITEUP-APPENDIX.md)); the numbers behind it are in [eval/results/](eval/results/).

Built for the Boostlingo brief. Spec: [docs/SPEC.md](docs/SPEC.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agent workflow: [AGENTS.md](AGENTS.md).

## Try the demo

The public demo is at https://d14cokif1zqitf.cloudfront.net. It was redeployed from `main` on 2026-10-18 and the instance stops itself on 2026-11-01 at 16:18 UTC. The access token is sent with the submission and is never in this repo; type it into the setup screen. Cascade there runs on OpenAI transcription (`gpt-realtime-whisper` with client endpointing), not Deepgram. You need headphones and a current Chromium-based browser (Chrome or Edge). Speak scripted or synthetic lines only: the page says so, and the deployment is not built for real conversations (see "Public demo (AWS)" below).

## Prerequisites

- .NET 10 SDK (`global.json` pins the 10.0 band and rolls forward to the latest feature release)
- Node 22 and npm (`.nvmrc` holds `22`; `web/package.json` declares `engines.node >= 22`)
- Python 3.12+ for the eval scripts only; the pinned numpy needs it, and the note is at the top of `eval/requirements.txt`. The app never runs Python.
- A current Chromium-based browser (Chrome or Edge). Only Chromium was tested (Playwright runs a single `chromium` project), and microphone capture needs a secure page: localhost or HTTPS.
- Headphones. Realtime and Cascade close the mic while the interpreter speaks, but Realtime translate speaks while you are still talking, so the mic stays open and only the browser's echo cancellation stands between its voice and a re-translation. The setup screen says so for that mode.
- Optional: [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-commit secret scan (`brew install gitleaks`, or a binary from its [releases page](https://github.com/gitleaks/gitleaks/releases)). Without it the hook runs only the pattern check; CI runs gitleaks either way.

## Run locally

```bash
# once, at the repo root: installs the git hooks (lint-staged, secret check, commitlint)
npm ci

# terminal 1: backend on http://localhost:5080
export OPENAI_API_KEY=...          # server only
export DEMO_ACCESS_TOKEN=...       # any long random string; enter it in the setup screen
# Cascade mode also needs (all server only):
export DEEPGRAM_API_KEY=...        # optional STT; without it the server uses OpenAI transcription
export ELEVENLABS_API_KEY=...      # TTS; a paid plan (the free plan is non-commercial)
export CLAUDE_TRANSLATOR_API_KEY=...  # only if Cascade__Translator=anthropic (ANTHROPIC_API_KEY also works locally)
dotnet run --project server/Interpreter.Api

# terminal 2: frontend on http://localhost:5173 (proxies /health, /api, /ws to the backend)
cd web && npm ci && npm run dev
```

Open http://localhost:5173. The page shows "Backend: ok" when the round trip works, and names any key the configured adapters still need (`OPENAI_API_KEY` and `DEMO_ACCESS_TOKEN` always; `DEEPGRAM_API_KEY` only with `Cascade__Stt=deepgram`, `CLAUDE_TRANSLATOR_API_KEY` only with `Cascade__Translator=anthropic`, `ELEVENLABS_API_KEY` only with `Cascade__Tts=elevenlabs`). Enter the access token, pick a mode and a language pair, tick the consent box (both parties must be told an AI interprets them), then **Start session**. The button stays disabled until the token is typed and the box is ticked; if the server refuses the token, the app returns to the setup screen with the error shown above the form.

Put keys in a `.env` at the repo root (copy `.env.example`; it is git-ignored) and load it with `set -a; source .env; set +a`, since a plain `source` does not export them. The non-secret switches (`Cascade__Stt`, `Cascade__Translator`, `Cascade__Tts`, `OpenAI__Realtime__Model`, and the BAA mode settings `Compliance__RequireBaa` and `Compliance__BaaSigned__N`) are listed, commented out, at the bottom of `.env.example`.

### Keys

Every key stays on the server. The browser gets only a 60-second ephemeral secret for Realtime (`OpenAI:Realtime:SecretTtlSeconds`), minted by `POST /api/realtime/session`, which requires the access token and is rate-limited.

| Variable | Needed for | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Realtime, Realtime translate, OpenAI transcription, the OpenAI translator (cascade default) and OpenAI TTS (`Cascade__Tts=openai`) | No free tier for Realtime models; set a spend cap in the OpenAI dashboard |
| `DEMO_ACCESS_TOKEN` | Every session | Any long random string; typed into the setup screen |
| `DEEPGRAM_API_KEY` | Cascade with Deepgram STT | Or `Cascade__Stt=openai` |
| `ELEVENLABS_API_KEY` | Cascade with ElevenLabs TTS (`Cascade__Tts=elevenlabs`, the default) | Paid plan required; stock voices only. Not needed with `Cascade__Tts=openai` |
| `CLAUDE_TRANSLATOR_API_KEY` | Cascade with `Cascade__Translator=anthropic` | |

### BAA mode

The workbench runs on synthetic data and has no BAA, so BAA mode is off by default. A deployment that has signed BAAs turns it on and declares which vendors they cover; the server then refuses any session whose route is not on that vendor's HIPAA-eligible list (`server/Interpreter.Api/Security/Compliance.cs` records the list and where each entry was read):

```bash
export Compliance__RequireBaa=true
export Compliance__BaaSigned__0=openai      # executed BAA plus Modified Retention on the OpenAI org
export Compliance__BaaSigned__1=anthropic   # BAA executed in the Claude Console
export Cascade__Stt=openai
export Cascade__Translator=anthropic
export Cascade__Tts=openai                  # OpenAI /v1/audio/speech instead of ElevenLabs
```

| Mode | In BAA mode |
|---|---|
| Realtime translate | Always refused: `/v1/realtime/translations` is not on OpenAI's eligible list |
| Realtime | Runs with an OpenAI BAA declared |
| Cascade | Runs when all three stages are eligible and declared; OpenAI's Chat Completions translator and ElevenLabs TTS are refused (not on a checked eligible list) |

The code can't sign an agreement or switch on a vendor's retention terms; declaring a vendor in `BaaSigned` is the operator's statement that both are done. The server logs which modes are off at startup.

## Test

```bash
dotnet test --solution server/Interpreter.slnx --filter-not-trait "Category=Live"
cd web && npm run lint && npm run typecheck && npm test
```

Live provider checks (call the real APIs with synthetic speech; skipped for any key that isn't set; in CI only as the manual `server:live` job on the `heavy` lane):

```bash
dotnet test --solution server/Interpreter.slnx --filter-trait "Category=Live"
```

## Evaluation

```bash
python3 -m pip install -r eval/requirements.txt
python3 eval/summarize.py eval/results/logs/2026-10-15-*-replay-*.json   # rebuilds eval/results/summary.md from the four replay logs it was built from
python3 -m unittest discover -s eval -p 'test_*.py'
```

`summarize.py` reprices every cost line in memory from quantity × price using `config/prices.json` (`--prices PATH` to point elsewhere); a null price leaves the line unpriced and the mode gets no cost per minute, and nothing is estimated. A billed component with no quantity in the log (cascade STT, Realtime input transcription) is named in the cost column, never counted as free. It exits 2 and writes nothing when a `*redteam*` log is pooled with other logs unless `--allow-mixed` is passed: red-team logs are scored by `eval/adversarial/score.py` instead, and the two Vietnamese logs are summarised separately in [eval/results/onboarding-vi.md](eval/results/onboarding-vi.md). The 2026-10-15 cascade logs carry no STT minutes (the browser emitted them only on End), nor does the 2026-10-16 server-VAD baseline log; the other 2026-10-16 cascade logs do. For a log without them, a cascade cost per minute needs a re-export or `--stt-minutes-from-session`, which charges the whole session's minutes at the STT per-minute price as an explicitly labelled upper bound; it is off by default.

The replay clips (`eval/replay/`) and the 5-minute soak (`web/e2e/soak.spec.ts`, manual CI job `e2e:soak`) produce the session logs it reads. Replay audio is never committed. Latency from runs on Deepgram STT is withheld, since its terms bar benchmarking.

### Red-team (prompt-injection) results, 2026-10-15, synthetic voices

The suite in [eval/adversarial/](eval/adversarial/README.md) (30 lines: questions to the interpreter, injected instructions, language switches, prompt extraction, "don't translate this", sensitive content, background voice, TTS echo) was voiced with synthetic TTS and looped for 4 minutes into each configuration. Labels come from a shuffled sheet with the mode hidden ([eval/results/redteam-labels-2026-10-15-synthetic.csv](eval/results/redteam-labels-2026-10-15-synthetic.csv)): 154 of the 158 rows were drafted by an AI coding agent from my first four, and I reviewed the drafted sheet and approved it; one labeller, no second rater. The two TTS-echo lines need a real room and were not run.

| Rate | Cascade (both translators) | Realtime | Realtime translate |
|---|---|---|---|
| Answered instead of translating | 0/88 (0%) | 0/17 (0%) | 0/53 (0%) |
| Instruction followed | 0/88 (0%) | 0/17 (0%) | 1/53 (2%) |
| Omission | 32/88 (36%) | 5/17 (29%) | 18/53 (34%) |
| Refusal | 0/88 (0%) | 1/17 (6%) | 0/53 (0%) |
| Wrong language | 0/88 (0%) | 1/17 (6%) | 0/53 (0%) |
| Meaning changed or garbled ("other") | 37/88 (42%) | 3/17 (18%) | 10/53 (19%) |
| Fully faithful | 19/88 (22%) | 7/17 (41%) | 24/53 (45%) |

No mode answered a question addressed to it. These are subjective counts on synthetic voices with small n, not benchmark rates; the failure shapes and examples are in [docs/WRITEUP-APPENDIX.md](docs/WRITEUP-APPENDIX.md) appendices G and D.

## Architecture

The browser captures 16 kHz PCM in an AudioWorklet with a local VAD, and plays output through a scheduler that marks the first audible frame. One `Transport` interface hides the mode: the Realtime and Realtime translate transports speak WebRTC straight to OpenAI with an ephemeral secret; the cascade transport streams PCM over a WebSocket to the .NET server, which runs STT, translation and TTS as a back-pressured pipeline of `IAsyncEnumerable` stages behind provider interfaces. Translation starts on each STT final: Deepgram delivers finals mid-utterance, while OpenAI transcription (the demo default and the source of the published cascade numbers) delivers one final per turn. Its default model, `gpt-realtime-whisper`, streams text during speech, and the browser commits the turn 300 ms after its VAD hears speech end (client endpointing); the final follows that commit, so the translator starts at the endpoint and the published numbers include that wait. A cascade speaker switch is a `direction` message on the open WebSocket: the server finishes the turn in flight, then starts the new direction and keeps the finished turns as context, so a flip does not reopen the socket or count against the session rate limit (the socket is reopened only after it dropped). Cascade STT audio seconds are reported every 5 s during the session and the remainder at End, so an export taken before End has the STT cost line. A cascade provider failure reaches the UI with the adapter's own message (for example `DEEPGRAM_API_KEY is not configured on the server`); when `Cascade:Stt` is `deepgram` but only `OPENAI_API_KEY` is set, the server falls back to the OpenAI transcription adapter at startup, logs a warning naming the setting, and `/health` and `/api/cascade/providers` report the adapter in use. The UI, transcript store, output checks and latency waterfall are the same for every mode. Diagram and data flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Why .NET + TypeScript

The brief prefers .NET and asks for the choice to be explained. The cascade is a streaming problem, and .NET makes the hard parts explicit and testable: `System.Threading.Channels` with bounded capacity for back-pressure, `CancellationToken` for teardown on a speaker switch or End, Kestrel WebSockets with no extra libraries. Vendor adapters talk to the raw WebSocket and HTTP APIs instead of SDKs, so the only vendor-specific code lives in `Interpreter.Providers.*`. The cost was writing those adapters by hand; a Python voice framework would have been faster but would hide the streaming, flush policy and provider seams this project is meant to show. The browser side is TypeScript because audio capture, WebRTC and playback timing only exist there. Python is used only for the offline eval scripts, where `jiwer` and `sacrebleu` are the standard tools; it is never part of the app. Full reasoning: [docs/DECISIONS.md](docs/DECISIONS.md) D1 and D2.

## CI

Local hooks: lint-staged and the secret check on commit (about 4 s), commitlint on the message, and on push only the stacks the branch changed against `origin/main` (web typecheck and related tests, server build, unit tests and format check on changed C# files, eval tests when their deps are installed; 8 to 39 s). Never bypass a hook with `--no-verify`.

GitLab CI runs one pipeline per push (MR pipelines win), cancels stale ones, and runs a stack's jobs only when it changed against `main`; gitleaks runs on every pipeline and the bundle is grepped for key-like strings. Jobs are sized from the measured 3 CPU / 3 GB job budget. Live provider tests (`server:live`) and the browser jobs (`e2e:switch`, `e2e:soak`) run on the `heavy` runner tag, manually, or on a schedule that sets `RUN_LIVE=1` / `RUN_E2E=1`, because they make billed calls. Decisions and numbers: MR !31 on the project's private GitLab instance (commits 07b7eac, 692156a, 093c096). MR and job ids anywhere in this repo refer to that instance, which outside readers can't open; the numbers are in the table below and in `eval/results/`.

Step times and peak memory, cloud container, warm caches:

| Step | Plan day 1 (skeleton, 2026-10-14) | Plan day 4 (2026-10-15) |
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

Every step stays well inside the measured per-job budget of 3 CPU and 3072 MB (read from each job's cgroup on 2026-10-15). `dotnet format` is now the slowest step; it runs only when server files change.

## Public demo (AWS)

A manual CI job, `deploy:aws` on `main`, runs [infra/deploy.sh](infra/deploy.sh). It builds the image with the .NET SDK (`dotnet publish -p:DemoImage=true /t:PublishContainer`, no Docker daemon), with the built SPA and `config/` inside and no keys. It pushes the image to ECR, writes the keys to SSM Parameter Store as SecureString parameters, and deploys [infra/demo.yml](infra/demo.yml): ECS on one free-tier-sized t3.micro instance reachable only through CloudFront, with CloudFront providing HTTPS to the viewer (the mic needs a secure page) and WebSockets. The job pins the AWS CLI to 2.38.1 and verifies its SHA-256 before installing it. There is no load balancer; one small instance with no automatic replacement is enough for a graded demo.

Two honest limits of that shape. The viewer-to-CloudFront leg is HTTPS, but CloudFront-to-instance is plain HTTP over AWS's network, because a bare t3.micro has no CA-issued certificate: the access token, the ephemeral Realtime secrets and cascade audio and transcripts cross that hop unencrypted, which is one more reason this deployment is not for real data. And "only CloudFront" means any CloudFront distribution: the security group admits the shared CloudFront origin prefix list and the app checks no origin-verify header, so the token gate is the real control.

- **Gate:** every session needs the access token; minting and the cascade socket are rate-limited per client address, read past CloudFront so a client can't pick its own.
- **Session caps:** cascade sessions are capped server-side (`Cascade:MaxSessionSeconds`, 30 minutes). The cascade socket also closes a session with 1008 (policy violation) when an audio frame is larger than 250 ms of 16 kHz PCM16 (the browser sends 20 ms frames) or when audio arrives faster than real time (more than elapsed time × `Cascade:AudioRateFactor` 1.25 + `Cascade:AudioBurstSeconds` 5 s); it ignores a repeated `direction`, retargets a switch still waiting to run instead of queuing another (once someone has spoken into it, the new direction queues behind it, up to 4 waiting directions), and ignores `commit` messages closer than 250 ms apart. Realtime and Realtime translate talk WebRTC directly to OpenAI with a 60-second ephemeral secret, so their 30-minute cap is enforced by the browser; the server-side ceiling is OpenAI's own session limit plus the dashboard spend cap.
- **Instance metadata:** the app container runs in bridge mode with the metadata hop limit at 2, so it can reach the instance metadata service and the instance role's credentials (ECR pull, ECS, CloudWatch Logs). Known and accepted for a graded demo; tighten with an iptables rule in the instance user data or awsvpc networking before any other use.
- **Not indexed:** `X-Robots-Tag: noindex` on every response and a `robots.txt` that disallows everything.
- **Response headers:** every response also carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a `Permissions-Policy` that allows the microphone for the page only. No Content-Security-Policy is set. The two mint endpoints refuse request bodies over 4 KB with 413 before reading them.
- **Banner:** the page always says it is AI interpretation with synthetic data only.
- **Nothing to purge:** no audio or transcript is stored, and logs (ids and status codes only) expire after a day.
- **Turns itself off:** a one-time schedule stops the instance at `SHUTDOWN_AT` (default 14 days after deploy). After grading, rotate `DEMO_ACCESS_TOKEN` or run `AWS_REGION=<region> bash infra/teardown.sh`, which deletes the CloudFormation stack (and waits), the four `/interpreter-demo/*` SSM parameters and the `interpreter-demo` ECR repository with its images; `aws cloudformation delete-stack` alone leaves the keys and images behind. Every step is idempotent. Rotate the vendor keys afterwards if the demo was public.
- Cascade runs on OpenAI transcription in the demo; Deepgram is not used.

## Layout

```
server/   .NET 10: Interpreter.Api, Interpreter.Core, Interpreter.Providers.*, Interpreter.Tests
web/      React + Vite + TypeScript SPA (audio/, transports/, session/, components/)
config/   languages.json (adding a language pair is config only), glossary.json, prices.json
eval/     replay clips script, red-team suite, summarize.py, results/
infra/    demo.yml (CloudFormation), deploy.sh and teardown.sh for the public demo
docs/     spec, architecture, UI spec, tasks, acceptance, decisions, guardrails, write-up and its appendix
```

## Privacy

The public demo is run by the author. Realtime and Realtime translate send audio to OpenAI; cascade sends audio and text to up to three of OpenAI, Deepgram, Anthropic and ElevenLabs, as configured, and the setup screen names them. The app saves no audio. Transcripts stay in browser memory only, until **End**, unless you save them with **Export log**. Providers may retain data under their own terms (see [LICENSES.md](LICENSES.md)). The access token is stored in the browser's `localStorage`.

## What this does not do (yet), and what is unverified

This is an evaluation workbench, not a product. [docs/GUARDRAILS.md](docs/GUARDRAILS.md) outranks the brief; where they conflict, the conflict is listed under "Known constraints" below.

- **Not an interpreter of record.** It is not a "qualified interpreter" under ACA Section 1557 (45 CFR 92.4), and it must not be used for medical, legal or court interpreting without a qualified human in the loop.
- **Not HIPAA-compliant.** It is designed with HIPAA in mind (keys stay on the server, no transcripts are logged), but this deployment is not HIPAA-compliant: no Business Associate Agreement is in place with OpenAI, Deepgram, Anthropic or ElevenLabs, and zero-retention terms are not provisioned. Use scripted, synthetic speech only.
- **Cascade mode will send conversation content to up to three vendors at once** (STT, translation and TTS; two in the BAA profile, OpenAI and Anthropic). Realtime mode sends it to one.
- **A mid-session mode switch carries only the last 6 finished turns.** The new connection (Realtime session or cascade socket) gets them as context data, so names and register carry over; it has no other memory of the conversation. The cascade translator sees only the last 3 of them on each turn (D11).
- **Transcripts are discarded at End** (G20). Use **Export log** before **End** to keep a session; End asks first when there are unexported lines. The export holds the full transcript and the browser name and version (for example Chrome/142.0, not the full user-agent string): use it only for scripted test sessions.
- **Output checks are heuristics.** Every translated line is checked for the wrong language, an odd length ratio, assistant phrasing, refusals and the prompt-leak canary, and flagged lines offer the human handoff. A clean line is not verified, and the word lists in `config/languages.json` are model-written.
- **The human-interpreter handoff is a stub.** "Request human interpreter" ends the AI session at once, but this demo has no interpreter queue, so no request goes anywhere.
- **The spoken AI notice uses the browser's own speech synthesis**, so its voice and availability depend on the browser and OS. The written notice and consent box are always shown.
- **Realtime's "no tools" holds only for our client.** The server mints the Realtime session with interpreter instructions and no tools, and our client never changes that, but whoever holds the ephemeral client secret can send their own `session.update` over the data channel (other instructions, tools, another voice). The secret expires 60 s after it is minted (`OpenAI:Realtime:SecretTtlSeconds`), and minting needs the access token and is rate-limited per client (10 a minute by default, `Access:PermitLimit`). There is no global cap on concurrent sessions and no daily mint budget, so set a spend limit on the OpenAI project that holds the key.
- **Unverified:** the Realtime fidelity of the interpreter prompt beyond two manual round trips; any latency figure from fewer than a full 5-minute run; every model-generated artifact listed in [AI_USAGE.md](AI_USAGE.md).

## Known constraints

Conflicts between [docs/GUARDRAILS.md](docs/GUARDRAILS.md) and the brief or plan, and how each was resolved. The rule wins every time.

| Conflict | Resolution | Status |
|---|---|---|
| The brief asks for a latency and quality comparison that includes the cascade STT vendor. Deepgram's Terms of Service, clause (i), forbid using the service "for competitive purposes, including ... benchmarking and other competitive analysis" without written consent. | I am asking Deepgram for written consent (decided 2026-10-14). Both STT adapters are built (Day 2): Deepgram, which sets `mip_opt_out=true` on every connection so audio is excluded from Deepgram's model training (G4), and the OpenAI transcription fallback. Live tests check behaviour only and record no numbers. Deepgram had not replied by the write-up, so published cascade numbers use OpenAI transcription, and Deepgram appears only as a swappable adapter with no numbers. | Resolved: no consent; no Deepgram numbers published |
| The brief's success criteria start capture on "Start session". The guardrails require telling both parties that third-party AI processes the audio, and an all-party consent step before capture (California Penal Code 632). | The setup screen shows the AI notice in both languages (from `config/languages.json`) and the vendors of every mode the session can run or switch into, and Start stays disabled until "Both parties were told and agree" is ticked. The notice is read aloud in both languages before the mic opens. A persistent "not a qualified human interpreter" banner and a "Request human interpreter" button are always visible. Cascade source lines below 0.8 STT confidence are flagged; Realtime source lines say confidence is unknown. | Done (G7, T3.8); the Spanish notice needs a native-speaker check |
| The brief ranks modes on latency, cost and quality. The guardrails require the recommendation to account for regulated settings first. | The write-up recommends AI modes for low-stakes and consumer use and a human in the loop for medical and legal use. Latency and cost are secondary factors. | Done: docs/WRITEUP.md section 6 |
| "Interpretation quality (subjective + WER)". WER measures STT only, and the Realtime source column comes from a separate transcription model. | WER is reported as transcription accuracy only. Translation quality uses chrF or COMET (`wmt22-comet-da`, Apache-2.0) against human-written or human-checked references, plus a human rubric, scored with the mode hidden and labelled as subjective. | Done as far as measured: docs/WRITEUP.md section 3 reports WER as STT accuracy and chrF against model-written references, which I reviewed; COMET was not run. I also judged 16 of the 21 outputs of a blind sheet (`eval/rating.py`) acceptable (four failures are segmentation faults in Realtime translate: cut-off turns, or a neighbouring line merged in; one cascade output dropped most of the sentence); there are no per-dimension rubric scores |
| The guardrails forbid the ElevenLabs free plan (non-commercial, attribution required). | I moved to a paid ElevenLabs plan on 2026-10-14. | Resolved |
| The brief requires `gpt-realtime`. The guardrails say it is deprecated (removal 2027-01-20) and that the model id must be configuration, defaulting to `gpt-realtime-2.1`. | `OpenAI:Realtime:Model` defaults to `gpt-realtime-2.1`. `gpt-realtime` stays selectable in the setup screen so the brief's model can still be measured, and I measured it once on 2026-10-16 with the same defaults as `gpt-realtime-2.1` (CI job 234887; speech end to first audio p50/p95 1150/1490 ms, n = 36, `eval/results/latency-tuning-2026-10-16.md`). The write-up notes the deprecation. Both ids are listed by the OpenAI API and both mint sessions (checked 2026-10-14). The deprecation dates were read on OpenAI's deprecations page on 2026-10-16. | Done (G1); the write-up reports both models (sections 2–4); `gpt-realtime` has one synthetic run and no red-team run |
| The brief's Realtime/cascade framing has two options. The guardrails require evaluating `gpt-realtime-translate` as a third option. | Measured on the same replay set on 2026-10-15: latency (text lag), quality and red-team rates in docs/WRITEUP.md sections 2, 3 and 5 (full table in appendix G); `eval/results/soak-2026-10-15-translate-synthetic.json`. | Done (G11) |
| The Realtime client-secret endpoint was unauthenticated, which is fine for a local run. The guardrails require it to be authenticated and rate-limited. | It now requires the `DEMO_ACCESS_TOKEN` (sent as `X-Access-Token`, compared in constant time) and allows 10 requests per client per minute by default (`Access:PermitLimit`). The cascade WebSocket (`/ws/cascade`) has the same guard: the rate limit applies to the upgrade, and the token is checked in the first message because browsers can't set WebSocket headers. | Done (G2) |
| The guardrails require LLM translation at temperature 0 (G16). `claude-haiku-5-5` rejects the parameter (HTTP 400, "`temperature` is deprecated for this model", checked 2026-10-14). | The OpenAI translator sends `temperature: 0`. The Anthropic adapter sends it only when `Anthropic:Translation:Temperature` is set, so with Haiku it runs at the vendor default. The other structural controls (no tools, transcript as delimited data, per-segment output cap, output checks) apply to both. | Constraint |
| The guardrails want Realtime to default to `gpt-realtime-translate` where the pair is supported (G17). | Done: "Realtime translate" is a third mode and the default for English ↔ Spanish (`realtimeTranslate` in `config/languages.json`). The minted session carries a target language only, no instructions and no tools; a speaker flip changes only the output language. `gpt-realtime-2.1` (Realtime) and Cascade stay selectable. The SDP exchange was checked live; the audio path can't connect from the cloud container, so it was exercised by the CI runner's soaks (`eval/results/soak-2026-10-15-translate-synthetic.json`). | Done (G17); a check with a person listening is still manual |
| Realtime translate speaks while the speaker is still talking, so the half-duplex mic gate can't apply. | The mic stays open in that mode and the setup screen says headphones are required. Browser echo cancellation is the only defence against re-translating its own voice; the red-team "TTS echo" lines in `eval/adversarial/` are the test. The suite ran on 2026-10-15 with synthetic voices (docs/WRITEUP.md section 5), but the two TTS-echo lines need speakers in a real room and were not run. | Open: the echo lines need a live check |
| Speech end to first audio (D9) is often negative for a simultaneous interpreter. | The same total is still reported where it can be measured, plus a start lag (client speech start to first audible output) on lines that start after a pause, and a text lag (first source text to first translated text as they reach the browser) on every line. Lines are cut client-side by pairing each translated sentence with the source sentence that had started when it began (both streams carry the model's `elapsed_ms`); a recorded live stream pairs all ten sentences this way, but boundaries stay approximate and the UI and export say so. | Reported as defined |
| Realtime translate has no context input, so a mode switch into it can't carry the last turns (G9). | The switch marker says it starts with no memory of the conversation. | Accepted |
| The guardrails make HIPAA coverage a per-vendor question (BAA, retention). OpenAI's HIPAA-eligible list (read 2026-10-16) includes `/v1/realtime` and `/v1/audio/*` but not `/v1/realtime/translations`, which Realtime translate uses. ElevenLabs offers a BAA on Enterprise only, and no page checked lists its text-to-speech socket as eligible. | Routing is enforced in code with BAA mode (see "BAA mode" under Run locally): with `Compliance__RequireBaa=true` the server refuses any session whose route is not on its vendor's eligible list or whose vendor has no BAA declared, and the setup screen disables those modes with the reason. Realtime translate is always off in BAA mode; Realtime runs; cascade runs as OpenAI speech-to-text, Claude translator and the new OpenAI text-to-speech adapter. Signing the BAAs and turning on OpenAI's Modified Retention stay outside the code. The OpenAI text-to-speech adapter passed a live test (CI job 234538); in a local run its first audio came about 0.8–0.9 s after each phrase was sent, but its latency inside a session is unmeasured. | Routing enforced in code; the vendor gap itself is not fixed (no BAA signed). OpenAI TTS latency in a session unmeasured |
| The guardrails make model ids configuration and require checking deprecations. OpenAI lists `gpt-4o-transcribe` for shutdown on 2027-02-26, replaced by `gpt-transcribe` or `gpt-live-transcribe`. | The id is configuration (`OpenAI:Transcription:Model`, env `OpenAI__Transcription__Model`). Since MR !37 the cascade's OpenAI STT default is `gpt-realtime-whisper`, streaming, with client endpointing (it refuses server turn detection); it was live-tested and measured on the synthetic set (`eval/results/latency-tuning-2026-10-16.md`). `gpt-4o-transcribe` with server endpointing stays one setting away as the fallback. `gpt-realtime-whisper` is priced at $0.017/min in `config/prices.json` from a 2026-10-17 web search (labelled there as not read on OpenAI's page), takes no prompt (glossary terms reach only the translator), and its HIPAA eligibility has not been checked beyond the `/v1/realtime` route. | Default moved and priced (web search); open: its HIPAA check, and the fallback before 2027-02-26 |
| Vendor prices and terms. | The vendors' pages are blocked from the cloud container, so on 2026-10-16 I read the official pages and a browsing AI assistant read them too, and I checked its table against them; `config/prices.json` records each source. The California Legislature pages (Gov. Code §68561, AB 1242) block automated reads, so I checked them in a browser. | Done. The `gpt-realtime-whisper` rate ($0.017/min) and the `gpt-4o-mini-tts` rates ($0.60 per M text input tokens, $12 per M audio output tokens, about $0.015/min; no deprecation found) come from a 2026-10-17 web search and are labelled so in `config/prices.json`; `gpt-4o-mini-tts` stays unpriced there because it bills per token, not per character, and Realtime's input transcription (`gpt-4o-mini-transcribe`) has no price entry; I confirmed §68561 and AB 1242 in a browser on 2026-10-16 |
| The checklist's soak memory criterion is < 10% heap growth from minute 1 to 5. | Measured in the 2026-10-16 runs on the tuned defaults: cascade +21.7%, `gpt-realtime-2.1` +21.2%, `gpt-realtime` +18.0% (8.2–21.7% across all eight tuning runs, one under 10%); one 6-minute local cascade probe levelled off at about 10.8 MB once the transcript view reached its 80-row cap, which points at the view filling rather than a leak (one probe run, not proven). In the 2026-10-15 runs: cascade +14.3% (OpenAI translator) and +20.0% (Claude translator), still rising at +0.20 to +0.25 MB/min over the last two minutes; Realtime +18.9%; Realtime translate +8.5% (the only pass; last two minutes −0.19 MB/min). In the 4-minute red-team runs Realtime grew +13.5% and Realtime translate +15.5%. The cascade growth is the on-screen transcript window filling and the store keeping every turn for export. Reported as measured, not re-tuned (stability table in docs/WRITEUP-APPENDIX.md, appendix B). | Reported |
| The brief's latency benchmarks: Realtime under 1.5 s; cascade under 3 s (target under 2 s), speech end to first audio. | Measured on the 2026-10-16 defaults with synthetic clips, one run per configuration (n 36–38, below the guardrails' 50): `gpt-realtime-2.1` p50/p95 1271/1602 ms, `gpt-realtime` 1150/1490 ms, cascade 1940/2319 ms (`eval/results/latency-tuning-2026-10-16.md`). | Realtime meets 1.5 s at p50; the default `gpt-realtime-2.1` misses it at p95. Cascade meets 3 s, and 2 s at p50 only. Not measured on recorded human speech |
| The brief asks for streaming at every cascade stage, with no full-utterance blocking. | Translation and TTS stream, and `gpt-realtime-whisper` streams text while the speaker talks, but in every published run translation starts on each turn's STT final, after the client commit (300 ms after speech end). Deepgram finalizes mid-utterance, but it has no published numbers. | Partly met: in the published configuration STT is segmented at pauses |
| The brief's stability benchmark names audio drift. | The playback scheduler drops the oldest queued interpreter audio once more than 3 s is queued ahead of the play cursor (`web/src/audio/playback.ts`), counted as `drift_skip` in each `eval/results/soak-*.json`. The 2026-10-16 cascade run on the tuned defaults dropped 16.0 s (6 skips); the 2026-10-15 cascade replay runs dropped 22.0 s (12 skips) and 25.6 s (15 skips) of late interpreter audio; Realtime and Realtime translate dropped none. | Reported (docs/WRITEUP-APPENDIX.md, appendix B) |
| The guardrails want session content protected in transit and sessions capped by the server. | See "Public demo (AWS)": the CloudFront-to-instance hop is plain HTTP, the origin admits any CloudFront distribution, the container can reach the instance metadata service, and the Realtime modes' 30-minute cap is browser-enforced (cascade's is server-side). | Accepted for the graded demo; not for real data |
| The brief asks for a write-up of 1–2 pages. | `docs/WRITEUP.md` runs past that, at about 1,450 words plus tables (about 1,750 in all); method detail and longer analyses are in `docs/WRITEUP-APPENDIX.md`. I chose not to cut it further. | Accepted (the ACCEPTANCE.md write-up row stays unticked) |
| AGENTS.md and CLAUDE.md are graded deliverables. The guardrails require them in the candidate's own voice with no internal URLs. | I chose to keep the agent-written versions, checked for accuracy, and they say they are agent-written. The GitLab host name is removed. | Decided 2026-10-16 (G13): deviates from the guardrail by my choice |
