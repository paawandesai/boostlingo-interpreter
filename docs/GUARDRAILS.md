# Compliance, licensing & safety guardrails (read before any change)

> Set by Paawan and copied here verbatim (version 2, 2026-10-14; replaces version 1 from earlier the same day). Every agent reads this before any change. Facts in it that the executor checked or could not check are noted in [docs/TASKS.md](TASKS.md) under "Guardrail tasks".

These rules outrank the PRD, the rubric, and "make it work". If a rule conflicts with an
acceptance criterion, implement the rule and record the conflict in README.md under
"Known constraints". Never resolve the conflict silently in the criterion's favor.

## Reading the PRD
- The PRD is a hiring document, not a spec you may redistribute. Never commit the PRD, its
  PDF/docx, or long verbatim quotes into the repo (the Thesis brief is marked "Confidential -
  Thesis Internal"). Paraphrase requirements in your own words.
- Normalize the PRD's export artifacts; never copy them: `AI\_USAGE.md` is `AI_USAGE.md`,
  `https\://` is `https://`, `â€"` is an em dash, `â‰¥` is `≥`, `&lt;code&gt;` is `<code>`.
  Leftover editorial notes such as "(Raised from 2 days: ...)" are not requirements.
- Inputs the PRD describes but did not deliver (a `data/` folder, "provided parcels", a
  warehouse schema "reviewed at onboarding") are requested, not invented. If you must
  generate stand-ins, name them `fixtures/generated-*`, say so in the README, and never
  describe them as "provided".
- Every model name, API path, vendor tier, and legal citation in the PRD is checked against
  the vendor's current page before it is hard-coded. Model ids are configuration, never
  constants; check the provider's deprecations page first.
- Business-case figures in the PRD are the author's assumptions. Do not paste them into
  your README as findings; if you cite one, label it as the PRD's assumption.
- Free-text fields the PRD asks for (one-line description, project summary) are written by
  you, not generated.

## Secrets
- `.env` is in `.gitignore` before the first commit. Commit `.env.example` with placeholder
  values only. Never commit keys, tokens, or credentials; history cannot be cleaned later.
- Run a secret scanner (gitleaks or trufflehog) as a pre-commit hook and in CI. Before each
  commit also run `git diff --cached | grep -iE 'api[_-]?key|secret|token|passw|Bearer |sk-'`.
- Secrets reach the app only through environment or a secrets store. Never log them, never
  put them in client bundles, never pass them through IaC variables, state, or outputs.
- Framework-generated secrets (e.g., Django's `SECRET_KEY` in settings.py) are moved to
  environment before the first commit.

## Data
- Develop and test on synthetic data only. Never paste, query, log, or send real personal
  data (IDs, PHI, customer or member records) to any model, API, log, notebook, or this
  session. If a task appears to need real data, stop and ask.
- Never log request bodies, user text, names, emails, DOB, addresses, images, auth headers,
  or model transcripts. Log opaque IDs and status codes.
- No third-party analytics SDK (GA4, Mixpanel, PostHog cloud, Hotjar) on any page that
  carries personal or health data. Use a first-party events table (step_id, timestamp,
  anonymous session id).

## Public demo deployments
- A deployed demo must not accept data from strangers: gate sign-up and uploads behind an
  invite code or demo credentials, show a persistent "Demo — synthetic data only" banner,
  set `noindex`, purge stored data on a schedule, and rotate or disable demo accounts after
  grading.
- Demo videos and screenshots never show a real ID, a `.env`, a vendor dashboard, an API key,
  or an account ID. Any key that appears on screen is rotated immediately after recording.

## Dependencies
- Before adding a dependency, state its license and maintenance status in the commit
  message. Run a license audit before the first push (`pip-licenses`,
  `npx license-checker --summary`, `bundle exec license_finder`, `cargo-license`,
  `go-licenses`) and commit the output as `LICENSES.md`. Re-run before submission.
- Do not add: AGPL/GPL libraries linked into this app (a GPL *server* run as a separate
  process is fine); anything CC-BY-NC, "non-commercial", "research only", or with a
  revenue/funding cap (this applies to model weights and datasets, not just code);
  archived or unmaintained repos; packages with open critical CVEs. If the obvious choice
  is one of these, pick the alternative and note why.
- Pin versions and commit the lockfile. Use the latest patched framework release: Next.js
  must be at or above the fixes for CVE-2025-29927 (middleware auth bypass) and
  CVE-2025-66478 (App Router RCE), and authorization is enforced in route handlers or
  server components, never only in `middleware.ts`.
- Open-weight model notices travel with the app: "Built with Llama" where Llama is used;
  Gemma's use restrictions passed downstream where Gemma is used.

## Models and third-party AI APIs
- Use only the providers and tiers the project block allows. Never send personal or
  sensitive data to a free tier that uses inputs for product improvement, that bars personal
  data, or that is excluded from the vendor's data-processing / BAA terms.
- Never write prompts or schemas that force every field to be filled. Fields may be
  `null`/`unknown` and the UI shows that. Never fabricate data, citations, codes, IDs, or
  graph edges to satisfy a schema or a test.
- Any model output presented as fact (a citation, a code, "safe", "compliant",
  "bit-identical", a confidence number) is unverified until a deterministic check passes.
- Any end-user-facing output produced with AI says so (a disclosure line in the UI, email,
  or report). AI-generated speech is disclosed as AI-generated.
- Health-check endpoints report configuration and last-success timestamps; they never make
  live model calls or decrypt secrets. Monitoring must not consume the provider's quota.

## Honest measurement
- Benchmarks are measured, not staged: never stub a provider and report the stub's latency,
  never rotate keys or projects to multiply a free quota, never widen a test tolerance or
  hard-code a passing seed to make a flaky correctness test pass, never add keep-alive
  pingers to fake uptime. Report what was measured and the tier's real behavior.
- Targets the PRD sets that cannot be measured as stated (no holdout, no label definition,
  no horizon) are called out in README with the measurement you did instead.
- Git history is real: commit as you go; never backdate or synthesize commits.

## Honesty in docs
- README.md states what the system does NOT do and which parts are unverified. Never
  describe a demo deployment as HIPAA/PCI/GDPR "compliant"; write "designed with X in
  mind; this deployment is not X-compliant because ...".
- AI_USAGE.md lists every model-generated artifact (data, mappings, copy, tests) that was
  not independently verified, and names the model and version that produced it.
- Where a `CLAUDE.md`/`AGENTS.md` is itself a graded deliverable, it is written in your own
  voice and contains no secrets or internal URLs.

# Project guardrails — AI Interpreter Workbench

## The required model is deprecated — handle it, don't hard-code it
- The PRD requires "gpt-realtime". OpenAI deprecated it on July 20, 2026 (removal January 20,
  2027); the replacement is `gpt-realtime-2.1`. `gpt-4o-realtime-preview` and the
  `OpenAI-Beta: realtime=v1` header were shut down in May 2026 — never emit them (training
  data skews toward both). The model id is configuration, default `gpt-realtime-2.1`, and the
  write-up notes the deprecation.
- OpenAI also ships `gpt-realtime-translate`, a purpose-built streaming speech-to-speech
  translation model on `/v1/realtime/translations`, priced per minute ($0.034/min, no free
  tier). It collapses the PRD's two-architecture framing and dominates the cost-per-minute
  metric; the comparison write-up evaluates it as a third option or explains why not.
- Realtime models have no free tier; budget paid credits, cap spend in the OpenAI dashboard,
  and show a per-minute cost table in the write-up.

## Provider licensing and tiers (this is a commercial product)
- FORBIDDEN (non-commercial or unmaintained): SeamlessM4T and NLLB-200 (CC-BY-NC 4.0; NLLB's
  card says not for production deployment); Coqui/XTTS (CPML non-commercial; upstream dead,
  fork-only); Silero TTS and F5-TTS weights (NC); ElevenLabs FREE plan (no commercial license,
  attribution required) — use a paid ElevenLabs plan or another TTS vendor.
- DeepL API Free is FORBIDDEN: its license bars processing any personal data (8.3.11), lets
  DeepL store content perpetually (3.3.2), and live interpretation is personal data by
  definition. DeepL API Pro only, and the UI discloses DeepL machine translation (8.3.3).
- Deepgram and AssemblyAI train on customer content unless the per-request / per-plan opt-out
  is set, and neither accepts PHI without a BAA. Set the opt-out flags on every request and
  record each provider's retention in LICENSES.md and the write-up.
- Amazon Polly: only standard voices are always-free; neural/generative voices were a
  12-month offer that new accounts no longer receive. Price them.
- Allowed open source: Whisper / faster-whisper (MIT), Opus-MT (CC-BY, attribute), M2M100
  (MIT), MADLAD-400 (Apache), Kokoro (Apache 2.0). Piper only from an MIT-licensed release
  (piper1-gpl is GPL-3.0).
- Evaluation data: never commit CoVoST 2 (CC-BY-NC) or MuST-C (CC-BY-NC-ND) clips. Use Common
  Voice (CC0), FLEURS (CC-BY), or self-recorded scripted dialogues.

## Keys and transport
- No provider API key ever ships in the SPA bundle. Realtime mode: an authenticated,
  rate-limited backend `/session` route mints ephemeral client secrets
  (`POST /v1/realtime/client_secrets`; OpenAI: standard keys are server-only). Cascade mode:
  STT/translation/TTS calls go through the backend or use vendor temporary tokens. An
  unauthenticated mint endpoint is a credit-drain.
- CI fails if `dist/` or `build/` output contains `OPENAI_API_KEY`, `DEEPGRAM`, `ASSEMBLY`,
  `ELEVEN`, `DEEPL`, or any `sk-` prefix.
- If deploying: Lambda cannot host long-lived WebRTC/WebSocket relays; use App Runner/ECS or
  stay local-only as the PRD permits.

## Data flows and consent (required table in the comparison write-up)
- One row per vendor: retention default, zero-retention availability, BAA availability.
  OpenAI keeps abuse-monitoring logs up to 30 days by default; /v1/realtime and /v1/audio are
  BAA/ZDR-eligible only with the Healthcare Addendum and approved Modified Retention.
  ElevenLabs zero-retention is enterprise-only. Verify Deepgram / AssemblyAI / Soniox / DeepL
  current terms before quoting them.
- Cascade mode places conversation content with three vendors at once; state this plainly.
- Test only with synthetic or scripted dialogues. Both parties are told, on screen and
  spoken, that audio is processed by third-party AI and may be transcribed; all-party consent
  is required to record or transcribe in California (Penal Code 632) and other
  all-party-consent states; the UI has a consent step before capture starts. No audio is
  persisted by default.
- OpenAI's TTS policy requires disclosing to listeners that the voice is AI-generated; do it
  at session start in both modes.
- No voice cloning of the live speaker (prohibited by ElevenLabs without consent; voiceprints
  are biometric identifiers under Illinois BIPA).

## Transcripts, metrics, latency — measured honestly
- In Realtime mode the "source" transcript comes from a separate asynchronous ASR pass, not
  from what the model heard (OpenAI's own docs). Label it "approximate transcript (separate
  ASR)"; never present it as ground truth and never compute WER on it.
- WER measures STT only, against human reference transcripts. Translation quality uses COMET
  or chrF/BLEU against reference translations plus a bilingual human rating; label the
  subjective score as subjective. Comparing the two modes' outputs to each other is not a
  quality metric.
- Latency is measured client-side from the last voiced frame (local VAD) to first audible
  output, with the VAD silence threshold shown in the UI. Never start the timer at the
  server's `speech_stopped` event or at button release. Report p50/p95 per stage over at
  least 50 utterances in the full 5-minute run, not a best case.
- Mid-session mode switching does not carry Realtime context into the cascade; carry the
  transcript history across explicitly and state the limitation.

## The recommendation must account for regulated settings
- Healthcare: Section 1557 (45 CFR 92.201(c)) requires qualified human review of machine
  translation for critical content; "qualified interpreter" is a human standard; California
  AB 1242 would exclude unreviewed AI. Legal: court and deposition interpreting carry
  certification requirements.
- The Realtime model is prompted to interpret faithfully and never to answer, summarize, or
  omit; the UI carries an "AI interpretation — not for clinical or legal decisions" banner,
  flags low-confidence segments, and offers a one-click human-interpreter handoff.
- The write-up recommends AI modes for low-stakes and consumer scenarios and
  human-in-the-loop for medical and legal, with latency and cost as secondary factors. A
  recommendation ranked on latency/cost alone is incomplete.

## Dependencies and history
- Do not use `ffmpeg-static` (GPL builds). Resample PCM16 in an AudioWorklet/NAudio, or
  invoke a system/LGPL ffmpeg as a separate process.
- Audio helpers (VAD, resampling, Opus) must be MIT/BSD/Apache. silero-vad (MIT) is fine;
  Silero TTS is not.
- The git history is real and iterative: no backdated commits, and no `.env` in any commit
  (check with `git log -p --all -S 'sk-'` before submission). The AGENTS.md/CLAUDE.md you
  submit is graded: your own voice, no secrets.
