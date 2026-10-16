# Tasks

Hour budgets are caps: if a task overruns by 50%, stop and report before continuing. Each task is one MR of one or more logical commits. Status is tracked in [ACCEPTANCE.md](ACCEPTANCE.md).


## Day 1: foundations + UI design + Realtime end to end (6.5 h)

- **T0.1 Kickoff pack (1.0 h).** `docs/SPEC.md` (brief + must-haves + benchmarks), `docs/ARCHITECTURE.md` (Mermaid for both data paths + latency mark points), `docs/TASKS.md` (this list), `docs/ACCEPTANCE.md` (traceability tables as checkboxes), `docs/DECISIONS.md` (from notes/decisions.md), `AGENTS.md` + `CLAUDE.md` (commands, conventions, guardrails, "do not" list). *Do not* write code in this commit.
- **T0.2 Skeleton (1.0 h).** .NET 10 solution with the projects in Appendix A, `/health`; Vite React TS app calling `/health` via the Vite proxy; `config/languages.json` with en, es; README stub. *Do not* add vendor code.
- **T0.3 UI research → walkthrough → Claude Design (1.0 h; no repo dependency, can run in parallel with T0.2/T1.3).**
  1. *Research (20 min):* review 5–6 reference UIs and note the patterns worth copying. Conversation translators: Google Translate conversation mode, Microsoft Translator, Apple Translate face-to-face view. Interpretation products: Boostlingo's own app, Wordly, KUDO or Interprefy. Latency views: Chrome DevTools Network waterfall. Output: a one-page pattern table (pattern, where seen, adopt / skip, why).
  2. *Logical walkthrough (15 min):* the user flows as numbered steps, with the state and controls at each step: setup (mode, language pair, speaker side, input source mic/replay) → start → speak → partial/final transcripts → translated audio → latency waterfall → mid-session toggle → each failure state with its recovery → end → export log. Output: a flow list plus a screen and state inventory.
  3. *Claude Design (25 min):* generate the UI with the Claude Design artifact type from the walkthrough. Three screens only: (a) pre-session setup, (b) live session (two transcript columns, speaker toggle, mode toggle, per-utterance latency waterfall, running p50/p95, cost meter slot), (c) failure states as variants of (b). I pick or adjust it in one review pass.
  4. *Hand-off:* `docs/UI.md` with the chosen design link, the screen and state inventory, layout, a component list mapped to `web/src/components/*`, and design tokens (colours, type scale, spacing) as CSS variables. T1.4/T1.6/T2.6/T3.2/T3.4 build to it.
  *Do not* add screens beyond the three, animations, theming or a design system. The brief scores function, not visual polish. Accessibility basics only (contrast, keyboard-operable toggles, `aria-live` on transcripts).
- **T1.3 CI + hooks (1.5 h).** Appendix B.
- **T1.4 Audio I/O (1.0 h).** Capture worklet: native rate → 16 kHz PCM16 frames, RMS-based client VAD emitting `speech.start`/`speech.end` marks (back-dated to last voiced frame). Playback scheduler with a bounded queue (cap 3 s, logs `drift.skip`). `getUserMedia` with echoCancellation, noiseSuppression and autoGainControl on. Mic gating hook (mute while output plays + 150 ms tail). Tests: resampler output length/format, VAD on a synthetic tone + silence, queue cap.
- **T1.5 Realtime secret endpoint (0.5 h).** `POST /api/realtime/session` → OpenAI client-secret endpoint (**verify GA path and body in current docs**) with `gpt-realtime`, interpreter instructions templated from `languages.json` (D15), server VAD, input transcription enabled, voice. Unit test with a mocked HTTP handler; the key comes only from env.
- **T1.6 Realtime transport (1.5 h, may spill to Day 2).** WebRTC peer, SDP exchange with the ephemeral secret, data channel event parsing (**verify current event names**), transcripts into the store, remote track tapped for the first-audio probe, mic gating while the response plays. Recorded-event fixture tests for the parser. 🎧 me: EN→ES and ES→EN, plus 5 adversarial utterances logged.
- **T1.7 Session store + pre-session toggle (included in T1.6).** Mode and language selection before Start.

## Day 2: cascade end to end (5.0 h)

- **T2.1 Interfaces + error contract (0.5 h).** As D8. `ProviderException(Kind, RetryAfter)`. Architecture test.
- **T2.2 Pipeline + FlushPolicy + fakes (1.0 h).** Channels-based pipeline: STT events → translator on finals → FlushPolicy → TTS stream → audio out. Bounded channels (back-pressure), linked cancellation. Tests with fake providers: ordering across utterances, clause flushing (EN + ES table cases, "Dr.", "3.5", `¿…?`), cancellation mid-stream tears down all stages, back-pressure doesn't drop text, and the M3 no-blocking proof.
- **T2.3 Deepgram STT adapter (1.0 h).** Streaming WS, interim results, endpointing + `UtteranceEnd` (**verify params**), keyterms option. Contract tests against a fake WS server plus one `Category=Live` test.
- **T2.4 Translator adapters ×2 (1.0 h).** OpenAI small model and Claude Haiku, streaming (**verify current model IDs and prices**). Same contract test class runs against both. Record the time this task takes (flexibility metric).
- **T2.5 ElevenLabs TTS adapter (1.0 h).** WS input streaming, PCM 24 kHz output (**verify format option**). Contract tests (fake WS), mid-stream failure maps to `ProviderException`.
- **T2.6 Cascade transport + WS protocol (0.5 h).** Binary audio up/down, JSON events with server timestamps, same `Transport` interface. 🎧 me: both directions.

## Day 3: instrumentation, robustness, harness (5.5 h)

- **T3.1 Latency marks + clock offset + calculator (1.0 h).** Ping/pong offset (min-RTT sample, re-estimated every 30 s); pure `computeLatency(marks) → Breakdown`, unit tested (missing marks, offset applied, both modes).
- **T3.2 Waterfall UI (0.5 h).** Per-utterance stage bars, running p50/p95.
- **T3.3 Mid-session toggle (0.5 h).** `await stop()` then `start()`, transcript marker. Playwright check that no WS/peer stays open.
- **T3.4 Failure UX + error-path tests (1.0 h).** 429 (backoff with `RetryAfter`, visible "rate limited, retrying"), timeout, empty transcript, TTS mid-stream failure (text still shown, audio marked failed), mic denied (instructions to re-enable), WebRTC drop (reconnect button). Each state has a test (server) or a story/manual check (web).
- **T3.5 Session log export + cost capture (0.5 h).** JSON export: marks, transcripts, usage units, provider config, versions. Prices in `config/prices.json` with a `checkedOn` date.
- **T3.6 Replay harness + soak (1.5 h).** "Replay" input source (file → `MediaStreamDestination`, identical for both transports). Record the replay set: 20 EN + 20 ES utterances, plus 15 adversarial and 10 medical-glossary utterances, each with reference text and reference translations. Playwright soak, 5 min per mode, via the `e2e:soak` job or locally; report disconnects, drift skips and heap slope.
- **T3.7 Glossary injection (0.5 h).** `glossary.json` → Deepgram keyterms + translation prompt. Realtime gets the same terms in its instructions (fair comparison).

## Day 4: evidence + write-up (4.5 h)

- **T4.1 Onboard EN↔VI by config (0.5 h, timed).** Record minutes, config lines and code changes. 5 replay utterances. Optional: Haitian Creole Realtime probe (5 utterances, instructions only).
- **T4.2 Measurement runs (1.0 h).** Replay set through both modes × both directions × both translators; finals vs stable-partials flush variant. Exports go to `/eval/results/`. I do a blind rubric scoring (🎧).
- **T4.3 Eval scripts (0.5 h).** WER (`jiwer`), chrF (`sacrebleu`, stretch), latency tables, cost arithmetic, flexibility/onboarding numbers → `eval/results/summary.md`.
- **T4.4 Write-up draft (1.5 h).** `docs/WRITEUP.md`: setup and method → latency table → quality → cost/min → controllability/compliance (BAA/ZDR per vendor, **verify each**) → recommendation by scenario. Mark every place I must verify or rephrase.
- **T4.5 README + AGENTS.md final + CI Day-4 re-measure (1.0 h).** README: setup, keys, run, headphones advice, architecture, "Why .NET + TS". AGENTS.md: how the work was directed (architect/reviewer thread + cloud executor + review loop), with honest notes on what went wrong. CI before/after table refreshed with real numbers.

## T5 (optional, only if all ACCEPTANCE boxes are ticked): AWS deploy.

**Total ≈ 21.5 h** (T0.3 added 1 h). That's about 1.5 h over the top of the timebox, so the cut order below now matters. T0.3 partly pays for itself, because the UI tasks build to a spec instead of iterating on layout. **Cut order if behind:** chrF → Haitian Creole probe → auto-detect experiment → cost meter in UI → glossary set shrinks to 5 → Dockerfile.ci → T5. **Never cut:** any must-have, replay harness, soak, metrics tables, the CI required checks.

---


## Guardrail tasks (guardrails v3, added 2026-10-14; G15–G20 added with v3 the same day)

[docs/GUARDRAILS.md](GUARDRAILS.md) outranks this list. Each rule that needs work maps to a task below, slotted into the day where the code it touches is written. Rules already met are listed so nothing is re-done.

**Checked by the executor on 2026-10-14**
- `gpt-realtime`, `gpt-realtime-2.1` and `gpt-realtime-translate` all appear in `GET /v1/models` for this project's key.
- The `openai` npm package 7.33.0 types include `gpt-realtime-2.1` and the `/v1/realtime/translations` path.
- **Not verified** (OpenAI's docs are blocked from the container): the deprecation and removal dates for `gpt-realtime`, and the $0.034/min price of `gpt-realtime-translate`. I confirm them on OpenAI's deprecations and pricing pages before the write-up cites them.

**Already met (MR !7 or earlier)**
- `.env` ignored and `.env.example` committed.
- Bundle scan for provider key names and `sk-`.
- Staged-secret grep in the pre-commit hook.
- `LICENSES.md`, `AI_USAGE.md` and README "Known constraints".
- Pinned dependencies.
- No console logging in app code.
- Server logs carry status codes only.
- `/health` makes no provider calls.
- No analytics SDK.
- Ephemeral client secrets for Realtime.
- Latency is timed from client VAD, not `speech_stopped` (D9).

| Id | Slot | Task | Rule |
|---|---|---|---|
| G1 | Day 2 start (0.5 h) | Realtime model id from configuration, default `gpt-realtime-2.1`. Brief's `gpt-realtime` stays selectable. Known constraint and DECISIONS entry. Test that no request carries an `OpenAI-Beta` header or a `*-preview` model. | Deprecated model |
| G2 | Day 2 (0.5 h) | Authenticate and rate-limit `POST /api/realtime/session` and the cascade WebSocket. A demo access token from env, checked server-side, plus the ASP.NET Core rate limiter per client. Endpoint tests for 401 and 429. | Unauthenticated mint endpoint |
| G3 | Day 2 (0.5 h) | gitleaks (MIT, pinned release) as a pre-commit hook and a CI job. Add `sk-` to the staged grep. | Secret scanner |
| G4 | T2.3 | Deepgram: set the training opt-out (`mip_opt_out=true`) on every request. A contract test asserts it. Record retention in LICENSES.md. | Vendor training opt-out |
| G5 | T2.5 | ElevenLabs on the paid plan (done 2026-10-14). Stock voices only, no cloning of the live speaker. | Free plan, BIPA |
| G6 | T2.4 | DeepL is not in scope. If it is ever added: API Pro only, with a UI disclosure. | DeepL Free forbidden |
| G7 | Day 3, new T3.8 (1.0 h) | Consent and disclosure before the mic opens. <ul><li>On-screen notice in both languages that third-party AI processes and may transcribe the audio.</li><li>Spoken AI-voice notice at session start in both modes.</li><li>Persistent "AI interpretation — not for clinical or legal decisions" banner.</li><li>One-click human-interpreter handoff.</li><li>Low-confidence flags: cascade uses STT confidence; Realtime shows "unknown" because it exposes none.</li><li>No audio persisted.</li></ul> | Consent, disclosure, regulated settings |
| G8 | T3.1, T3.2 | Show the VAD silence threshold in the UI. Label the Realtime source column "approximate transcript (separate ASR)". The eval scripts refuse to compute WER on it. | Honest latency and transcripts |
| G9 | T3.3 | On a mid-session switch, carry the transcript history into the new mode explicitly, and state the limitation in the UI and the write-up. | Mode switching |
| G10 | T3.6, T4.2 | At least 50 utterances in each 5-minute run. p50/p95 per stage. Replay data only from Common Voice, FLEURS or self-recorded scripts, never CoVoST 2 or MuST-C. | Measurement, eval data |
| G11 | T4.2, T4.4 (+1.0 h) | <ul><li>Measure `gpt-realtime-translate` on the same replay set as a third option, or explain why not.</li><li>Per-minute cost table.</li><li>Vendor data-flow table (retention, zero retention, BAA).</li><li>Deprecation note.</li><li>I set an OpenAI spend cap.</li></ul> | Third option, cost, data flows |
| G12 | T3.4 | `/health` adds configuration and last-success timestamps, with still no live calls. | Health checks |
| G13 | T4.5 | <ul><li>Paawan rewrites AGENTS.md and CLAUDE.md in Paawan's own voice.</li><li>Remove internal URLs from them (the GitLab host is currently named in AGENTS.md).</li><li>~~Paraphrase the few near-verbatim brief sentences in docs/SPEC.md.~~ Done 2026-10-16 (SPEC.md lines on the problem, the M2 row, the UI separation and the test focus were rewritten; GUARDRAILS.md now stated as outranking the brief).</li><li>Paawan writes the free-text summaries.</li><li>Run `git log -p --all -S 'sk-'` before submission.</li></ul> | PRD handling, graded docs, history |
| G14 | T5 only | If deployed: invite code, "Demo — synthetic data only" banner, `noindex`, scheduled purge, App Runner or ECS (not Lambda). Rotate demo access after grading. | Public demo |
| G15 | Day 3, new T3.9 (1.0 h) | Deterministic checks on every output segment, both modes: output language matches the target, length ratio within bounds, no assistant-style patterns, the instructions' canary never appears. A failed check marks the segment "possibly not a translation" and offers the handoff; a refusal shows "[segment not interpreted — model declined]" in place. Never dropped or replayed silently. | Prompt injection, omission |
| G16 | T3.9 | Structural defences: LLM translators run at temperature 0 with no tools, transcript as delimited data in the user turn (done in D15); the Realtime session has no tools; session settings come only from the UI and server, never from speech. Tests assert the request bodies. | Prompt injection |
| G17 | Day 3/4 (1.0 h) | Realtime defaults to `gpt-realtime-translate` (`/v1/realtime/translations`) where the pair is supported; `gpt-realtime-2.1` stays selectable. Red-team suite runs against both. | Structural defence, third option. Built 2026-10-14 (third mode, default for en↔es); audio path is a manual check |
| G18 | T3.6, T4.2 | Red-team suite in `eval/adversarial/` (interpreter questions, injections, language-switch, prompt extraction, "don't translate", profanity/threat/clinical, background voice, TTS echo), each with its faithful rendering. Report per mode: answer-instead-of-translate, instruction-followed, omission, refusal and wrong-language rates. I record and score. | Controllability evidence |
| G19 | T3.9 | Maximum session duration enforced by the server for cascade and by the client plus the shortest secret lifetime for Realtime; per-user session rate (G2). | Cost exhaustion |
| G20 | T3.9 | Transcripts are discarded at session end unless exported first. No audio is persisted. | Data minimisation |

**Budget.** G1–G3 and G7 add about 2.5 h, and G11 adds about 1 h, on top of the 21.5 h plan. Cut order is unchanged. Guardrail tasks are never cut.

## Definition of done (every task)

1. Builds, hooks and CI are green; no `--no-verify`.
2. The task's tests exist and fail without the change (write the test first for the pipeline, flush and calculator).
3. Acceptance rows ticked in `docs/ACCEPTANCE.md`, with evidence (test name, screenshot, log path).
4. No key or secret in the repo or bundle; no vendor type outside `Providers.*`; no transport import in `components/`.
5. Resources closed on stop: every `start()` has a matching teardown test or check.
6. Decisions log updated if anything changed; MR description says what and why.

## Do not

- Don't polish the UI before every must-have works end to end.
- Don't add providers beyond those in D7 without approval.
- Don't run live-provider tests on the push path.
- Don't guess vendor endpoints, event names, model IDs or prices: check current docs and cite the URL in the commit or PR.
- Don't squash, force-push `main`, or bundle unrelated changes into one commit.
- Don't change GitLab project settings (registry cleanup, schedules, runner config) without asking. Recommend them in the MR instead.


## Appendix A: repo layout

```
/server
  Interpreter.Api/            # minimal API, WS endpoint, realtime secret endpoint
  Interpreter.Core/           # interfaces, pipeline, FlushPolicy, errors, no vendor code
  Interpreter.Providers.Deepgram/
  Interpreter.Providers.OpenAI/      # translator (+ realtime secret minting client)
  Interpreter.Providers.Anthropic/   # translator #2
  Interpreter.Providers.ElevenLabs/
  Interpreter.Tests/          # xUnit: pipeline, flush, contracts, errors, architecture
/web
  src/audio/                  # capture + playback worklets, resampler, client VAD
  src/transports/realtime/    # WebRTC transport
  src/transports/cascade/     # WS transport
  src/session/                # mode-agnostic store, latency calculator
  src/components/             # UI only
/config/languages.json
/eval                         # Python: WER, chrF, tables, cost arithmetic; replay set
  replay/                     # wav + reference transcripts + reference translations
/docs  SPEC.md ARCHITECTURE.md TASKS.md ACCEPTANCE.md DECISIONS.md WRITEUP.md
AGENTS.md  CLAUDE.md  README.md  .gitlab-ci.yml  Dockerfile.ci (if justified)
```

---


## Appendix B: CI and local gates (T1.3)

**When:** T1.3, right after the skeleton exists, so every later commit is gated. Timebox **1.5 h**. The prompt's full scope (prebuilt image, sharding, measured before/after) would take 3+ hours on a repo with almost no code. Do the lean version now and revisit on Day 4 with real numbers.

**Inputs (from the prompt):** the project's private GitLab instance; shared runner 4 vCPU / 8 GB; per-job 2 vCPU / 2 GB; 2 concurrent slots; heavy lane tag `heavy`; default branch `main`; required merge checks: lint, typecheck, unit tests, build (both stacks).

**Stack detected:** polyglot, .NET 10 + Node (Vite). Node is present, so use **Husky + lint-staged** (per the prompt's rule).

**Phase 0 (baseline):** run it, but on a skeleton it's mostly empty. Record times and peak RAM (`/usr/bin/time -v`) for `npm ci`, eslint, prettier check, `tsc --noEmit`, vitest, `vite build`, `dotnet restore`, `dotnet format --verify-no-changes`, `dotnet build`, `dotnet test`. Print the baseline table. Re-run Phase 0 measurements on Day 4 for the real before/after.

**Phase 1 (hooks):**
- `pre-commit` (< 10 s): lint-staged. `*.{ts,tsx}` → eslint --fix + prettier; `*.cs` → `dotnet format whitespace --include <files>` (style/analyzer passes are too slow for pre-commit; they run in pre-push/CI).
- `pre-push` (< 60 s): `tsc --noEmit` + `vitest run --changed origin/main` + `dotnet build -m:2 --no-restore` + `dotnet test --no-build --filter Category!=Live`. If .NET build+test exceeds the budget once the code grows, move it to CI only and say so.
- `commit-msg`: commitlint (conventional). It keeps the iterative history readable for the brief's reviewers.
- Never `--no-verify`.

**Phase 2 (`.gitlab-ci.yml`):** the prompt's `workflow:` block verbatim (MR pipelines win, auto-cancel). Global vars: `HUSKY: "0"`, `GIT_DEPTH: "20"`, `FF_USE_FASTZIP: "true"`, `CACHE_COMPRESSION_LEVEL: fast`, `ARTIFACT_COMPRESSION_LEVEL: fast`, `NODE_OPTIONS: --max-old-space-size=1536`, `DOTNET_GCHeapHardLimit: "0x60000000"` (1.5 GB), `DOTNET_CLI_TELEMETRY_OPTOUT: "1"`, `DOTNET_NOLOGO: "1"`. `default: timeout: 15m, interruptible: true`.

DAG (all `needs:`, `rules: changes:` with `compare_to: refs/heads/main`):

| Job | Runs when | needs | Notes |
|---|---|---|---|
| `web:install` | `web/**` | — | `npm ci`; cache keyed on `web/package-lock.json`; `node_modules` as artifact (expire 1 h) unless > 300 MB or slower than a warm-cache reinstall (measure, state numbers) |
| `web:lint` | `web/**` | web:install | eslint + prettier check |
| `web:typecheck` | `web/**` | web:install | `tsc --noEmit` |
| `web:test` | `web/**` | web:install | `vitest run --maxWorkers=2` (shard with `--shard` only if > 5 min, which is unlikely) |
| `web:build` | `web/**` | web:install | `vite build`; artifact `web/dist` expire 1 day; CI grep fails if `sk-` or `OPENAI_API_KEY` appears in `dist` (M2 key rule) |
| `server:restore` | `server/**` | — | `dotnet restore --locked-mode` (enable `RestorePackagesWithLockFile`); cache `~/.nuget/packages` keyed on `**/packages.lock.json` |
| `server:format` | `server/**` | server:restore | `dotnet format --verify-no-changes --no-restore` |
| `server:build` | `server/**` | server:restore | `dotnet build -c Release -m:2 --no-restore`; pass `bin/obj` as artifact (1 h) |
| `server:test` | `server/**` | server:build | `dotnet test --no-build --filter Category!=Live` with JUnit report (expire 1 week) |
| `eval:lint` | `eval/**` | — | `ruff check` (tiny job; skip if no Python changed) |
| `live:smoke` | manual on MR / schedule | — | `tags: [heavy]`. Real provider calls (`Category=Live`) with masked, protected CI vars; never on the push path (costs money, flaky) |
| `e2e:soak` | manual / schedule | web:build, server:build | `tags: [heavy]`. Playwright + Chromium fake audio, 5-min soak per mode, `--workers=1`; uploads heap/latency report (1 week) |

No deploy jobs unless T5 happens; then `resource_group: production`.

**Phase 3 (prebuilt image): skipped, justified (runner checked 2026-10-14).** The Vultr runner has `privileged = false` on all four runner entries, so Docker-in-Docker is unavailable, and its default image is `python:3.12-slim`, so **every job must set `image:` explicitly**. Plan: `node:22-slim` for `web:*`; `mcr.microsoft.com/dotnet/sdk:10.0` for `server:*`; `python:3.12-slim` (the runner default) for `eval:*`; the official Playwright image (`mcr.microsoft.com/playwright:<pinned version>`) for `e2e:soak`, which installs the .NET runtime with `dotnet-install.sh` at job start (a manual/scheduled job, so ~30–60 s of install is acceptable). No `Dockerfile.ci` and no registry image, so no builder (buildah/kaniko) is needed. Pin image versions by tag (digest if time allows). State this in the MR scorecard as "Prebuilt CI image: ✗ skipped, justified".

**Phase 4 (verify):** `glab ci lint`; deliberate lint error blocks a commit; one pipeline per push; a second push cancels the first; a README-only change skips lint/test; record per-job duration and peak RAM; fix any job > 80% of 2 GB.

**Deliverable:** one MR (multiple commits: hooks, CI yaml, lockfiles) with the prompt's before/after table, scorecard (✓/✗ with reasons) and runner assumptions.

---

