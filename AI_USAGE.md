# AI usage

Required by [docs/GUARDRAILS.md](docs/GUARDRAILS.md): every model-generated artifact that was not independently verified, and the model that produced it. How the agents were directed is in [AGENTS.md](AGENTS.md).

**Model.** Claude, through Claude Code (executor) and Claude Projects (architect and reviewer). Exact model and version: _to be filled in by Paawan before submission_. Every commit an agent wrote carries a `Co-Authored-By` trailer, so `git log` shows which commits were model-written.

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
| `config/glossary.json` | Twelve English/Spanish medical term pairs for the glossary test | **Unverified.** Written by the model; a medical interpreter or native speaker should check them before glossary accuracy is quoted. |
| `config/prices.json` | Price entries | Only the Claude Haiku price was read from the vendor page (2026-10-14); every other price is null until Paawan checks it. |
| AI disclosure notices in `config/languages.json` (`disclosure.notice`, `disclosure.spoken`) | English and Spanish consent text | **Unverified.** The Spanish was written by the model; a native speaker should check it, and the wording has had no legal review. |
| `LICENSES.md` provider table | Summary of each provider's terms | The Deepgram clause was confirmed on the live page by Paawan (2026-10-14). The other providers' summaries come from search results and are unverified. |
| `eval/replay/scripts.jsonl` | 65 replay lines with reference translations (T3.6) | **Unverified.** References need a fluent Spanish speaker's check before chrF/COMET or glossary accuracy is quoted. |
| `eval/adversarial/suite.jsonl` | 30 red-team lines with their faithful renderings (G18) | **Unverified.** Same check needed; the sensitive lines were written to be rendered completely, not softened. |
| `outputChecks` in `config/languages.json` | Function-word lists and assistant/refusal phrases for the output checks (G15) | **Unverified** heuristics; tuned on the unit-test examples only. |
| `eval/replay/synthetic/` (not committed) | Synthetic TTS clips of the replay lines, made with OpenAI's speech endpoint by `eval/replay/synth.py` | Labelled synthetic; used only for the soak, never as the measured set. |
| `eval/results/soak-2026-10-14-cascade-synthetic.json` | Soak report from the Playwright run | Measured, not generated; the input audio was synthetic. |
| `web/src/transports/translate/` | Realtime translate transport and the line segmenter (gap rules: 800 ms source, 1500 ms target, 8 s no output) | Unit-tested against scripted event sequences; the gap values are guesses not yet tuned on real audio, and the data-channel event names are assumed to match the WebSocket ones checked live. |
| Design canvas (Claude Design, linked from `docs/UI.md`) | Screens and states | Reviewed by Paawan as a direction, not a verified spec. |
