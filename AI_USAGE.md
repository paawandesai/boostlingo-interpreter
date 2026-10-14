# AI usage

Required by [docs/GUARDRAILS.md](docs/GUARDRAILS.md): every model-generated artifact that was not independently verified, and the model that produced it. How the agents were directed is in [AGENTS.md](AGENTS.md).

**Model.** Claude, through Claude Code (executor) and Claude Projects (architect and reviewer). Exact model and version: _to be filled in by Paawan from the session details_. Every commit an agent wrote carries a `Co-Authored-By` trailer, so `git log` shows which commits were model-written.

**Verified** means a deterministic check passed (a test against a recorded or live vendor response, a type definition from the vendor's own SDK, or a measurement), or Paawan checked it by hand. Everything else is listed as unverified.

| Artifact | What the model produced | Verification status |
|---|---|---|
| `docs/SPEC.md`, `ARCHITECTURE.md`, `TASKS.md`, `ACCEPTANCE.md`, `DECISIONS.md`, `UI.md` | Kickoff pack, plan, decisions and UI spec | Decisions agreed by Paawan on 2026-10-14. Vendor facts in DECISIONS.md are unverified unless the row cites a source. |
| `config/languages.json` | Language codes, display names, voice choices | Codes unverified against each vendor's supported-language list except where DECISIONS.md cites a check (Vietnamese, 2026-10-14). |
| `server/Interpreter.Core/Interpretation/InterpreterInstructions.cs` | The interpreter system prompt ("translate, never answer") | Partly verified: two spoken round trips by Paawan on 2026-10-14. The adversarial fidelity lines are not yet run. |
| `server/Interpreter.Providers.OpenAI/*` request and response shapes | Realtime client-secret request body and parsing | Verified against the `openai` npm package's type definitions (v7.32.0) and a live call that returned a client secret (2026-10-14). |
| `web/src/transports/realtime/events.ts` and `__fixtures__/en-es-turn.json` | Realtime data-channel event names and a recorded-style event sequence | Event names verified against the same type definitions. **The fixture was written by the model, not captured from a live session**; replace it with a captured sequence. |
| `web/src/audio/*` | Resampler, energy VAD thresholds, playback scheduler, mic gate | Unit-tested by model-written tests. VAD thresholds were tuned on no real recordings. Mic behaviour was checked by Paawan by ear only. |
| All tests (`server/Interpreter.Tests`, `web/src/**/*.test.ts`) | Every test | Written by the model. They pass in CI, but nobody has independently reviewed that they test the right thing. |
| UI copy and error messages (`web/src/components/*`) | Labels, status text, error text | Unreviewed. |
| `LICENSES.md` provider table | Summary of each provider's terms | The Deepgram clause was confirmed on the live page by Paawan (2026-10-14). The other providers' summaries come from search results and are unverified. |
| Design canvas (Claude Design, linked from `docs/UI.md`) | Screens and states | Reviewed by Paawan as a direction, not a verified spec. |
