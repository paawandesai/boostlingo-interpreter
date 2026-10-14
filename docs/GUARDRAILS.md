# Compliance, licensing & safety guardrails (read before any change)

> Set by Paawan on 2026-10-14 and copied here verbatim. Every agent reads this before any change.

These rules outrank the PRD, the rubric, and "make it work". If a rule conflicts with an
acceptance criterion, implement the rule and record the conflict in README.md under
"Known constraints". Never resolve the conflict silently in the criterion's favor.

## Secrets
- `.env` is in `.gitignore` before the first commit. Commit `.env.example` with placeholder
  values only. Never commit keys, tokens, or credentials; history cannot be cleaned later.
- Before each commit run: `git diff --cached | grep -iE 'api[_-]?key|secret|token|passw|Bearer '`
  and confirm nothing real is staged.
- Secrets reach the app only through environment or a secrets store. Never log them, never
  put them in client bundles, never pass them through IaC variables or state.

## Data
- Develop and test on synthetic data only. Never paste, query, log, or send real personal
  data (IDs, PHI, customer or member records) to any model, API, log, notebook, or this
  session. If a task appears to need real data, stop and ask.
- Never log request bodies, user text, names, emails, DOB, addresses, images, or model
  transcripts. Log opaque IDs and status codes.

## Dependencies
- Before adding a dependency, state its license and maintenance status in the commit
  message. Run a license audit before the first push (`pip-licenses`,
  `npx license-checker --summary`, `bundle exec license_finder`, `cargo-license`,
  `go-licenses`) and commit the output as `LICENSES.md`. Re-run before submission.
- Do not add: AGPL/GPL libraries linked into this app (a GPL *server* run as a separate
  process is fine); anything CC-BY-NC, "non-commercial", "research only", or with a
  revenue/funding cap; archived or unmaintained repos; packages with open critical CVEs.
  If the obvious choice is one of these, pick the alternative and note why.
- Pin versions and commit the lockfile.

## Models and third-party AI APIs
- Use only the providers and tiers the project block allows. Never send personal or
  sensitive data to a free tier that uses inputs for product improvement or that is
  excluded from the vendor's data-processing / BAA terms.
- Never write prompts or schemas that force every field to be filled. Fields may be
  `null`/`unknown` and the UI shows that. Never fabricate data, citations, codes, IDs, or
  graph edges to satisfy a schema or a test.
- Any model output presented as fact (a citation, a code, "safe", "compliant",
  "bit-identical", a confidence number) is unverified until a deterministic check passes.

## Honesty in docs
- README.md states what the system does NOT do and which parts are unverified. Never
  describe a demo deployment as HIPAA/PCI/GDPR "compliant"; write "designed with X in
  mind; this deployment is not X-compliant because ...".
- AI_USAGE.md lists every model-generated artifact (data, mappings, copy, tests) that was
  not independently verified, and names the model and version that produced it.
- No keep-alive pingers or similar tricks to fake uptime or performance numbers. Report
  what was measured and the tier's real behavior.

# Project guardrails — AI Interpreter Workbench

## Provider licensing (this is a commercial product)
- FORBIDDEN (non-commercial or unmaintained): SeamlessM4T and NLLB-200 (CC-BY-NC 4.0);
  Coqui/XTTS (CPML non-commercial; upstream dead, fork-only); Silero TTS and F5-TTS weights
  (NC); ElevenLabs FREE plan (non-commercial, attribution required) — use a paid ElevenLabs
  plan or another TTS vendor.
- Allowed open source: Whisper / faster-whisper (MIT), Opus-MT (CC-BY, attribute), M2M100
  (MIT), Kokoro (Apache 2.0). Piper only from an MIT-licensed release (piper1-gpl is GPL-3.0).
- Record every provider's license and plan tier in LICENSES.md and in the write-up's cost
  section.

## Keys and transport
- No provider API key ever ships in the SPA bundle. Realtime mode: the server mints ephemeral
  client tokens. Cascade mode: STT/translation/TTS calls go through the backend or use vendor
  temporary tokens.
- CI fails if `dist/` or `build/` output contains `OPENAI_API_KEY`, `DEEPGRAM`, `ASSEMBLY`,
  `ELEVEN`, `DEEPL`, or any `sk-` prefix.

## Data flows (required table in the comparison write-up)
- One row per vendor: retention default, zero-retention availability, BAA availability.
  OpenAI: /v1/realtime and /v1/audio are BAA-eligible only with the Healthcare Addendum and
  Modified Retention provisioned. ElevenLabs zero-retention is enterprise-only. Verify
  Deepgram / AssemblyAI / Soniox / DeepL current terms before quoting them.
- Cascade mode places conversation content with three vendors at once; state this plainly.
- Both parties are told that audio is processed by third-party AI and may be transcribed.
  All-party consent is required to record or transcribe in California (Penal Code §632) and
  other all-party-consent states; the UI has a consent step before capture starts.
- No voice cloning of the live speaker (prohibited by ElevenLabs without consent; voiceprints
  are biometric identifiers under Illinois BIPA).

## The recommendation must account for regulated settings
- Healthcare: Section 1557 (45 CFR 92.201(c)) requires qualified human review of machine
  translation for critical content; "qualified interpreter" is a human standard; California
  AB 1242 would exclude unreviewed AI. Legal: court and deposition interpreting carry
  certification requirements.
- The write-up recommends AI modes for low-stakes and consumer scenarios and
  human-in-the-loop for medical and legal, with latency and cost as secondary factors. A
  recommendation ranked on latency/cost alone is incomplete.

## Metrics
- WER measures STT only. Translation quality uses COMET or BLEU against reference
  translations plus a human rating rubric; label the subjective score as subjective.
- Latency is reported per stage with p50/p95 over the 5-minute stability run, not a single
  best case.

## Dependencies (project)
- Do not use `ffmpeg-static` (GPL builds). Use system ffmpeg or an LGPL build and record it.
- Audio helpers (VAD, resampling, Opus) must be MIT/BSD/Apache. silero-vad (MIT) is fine;
  Silero TTS is not.
- Git history reflects iterative work: no `.env` in any commit (check with
  `git log -p --all -S 'sk-' -- .env` before submission).
