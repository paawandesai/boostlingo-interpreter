# Replay set (T3.6, G10)

`scripts.jsonl` holds 70 utterances: 65 English/Spanish lines (20 English and 20 Spanish conversation lines, 15 adversarial lines with questions to the interpreter, instructions, fillers and one-word turns, and 10 medical lines that use the glossary terms in `config/glossary.json`) plus 5 Vietnamese onboarding lines with English references (T4.1, `eval/results/onboarding-vi.md`). `python3 eval/replay/check.py` prints the count per group. Each row has the source `text`, the `reference` translation and, for medical rows, the glossary `terms` it should contain.

**Model-written; Spanish reviewed by the owner.** The model wrote every line and every reference translation. On 2026-10-16 a second model pass reviewed each reference and added `alternatives` (other acceptable renderings: the other register, Latin American and Peninsular word choices, natural paraphrases) to 59 rows; chrF counts any of them, so a correct paraphrase is not scored as an error, while the glossary check still uses `reference`. Paawan reviewed the English/Spanish references and a 21-row blind sheet (one reviewer, no per-dimension rubric scores; AI_USAGE.md). The 5 Vietnamese lines are still unverified and need a Vietnamese speaker. The write-up (docs/WRITEUP.md) uses the 2026-10-16 replay runs (`eval/results/latency-tuning-2026-10-16.md`) for cascade and both Realtime models, and the 2026-10-15 runs (`eval/results/summary.md`) for Realtime translate; all of them used synthetic clips of these lines, so their numbers are labelled synthetic. Register is mixed (usted vs tú) on purpose in a few adversarial lines.

## Audio

Audio is never committed. Two sources are allowed (docs/GUARDRAILS.md, G10):

1. **Self-recorded (allowed; none recorded yet).** Record yourself, or a speaker who has agreed in writing, reading each line. Save as `audio/<id>.wav` (or `.webm`), e.g. `audio/en-conversation-01.wav`. The `en-`/`es-` prefix tells the app which speaker side the clip is.
2. **Synthetic (the only set measured so far).** `python3 eval/replay/synth.py` writes TTS clips to `synthetic/` with OpenAI's speech endpoint (`OPENAI_API_KEY`, billed). Results from these clips are labelled synthetic wherever they appear; TTS speech is cleaner than a person and flatters STT.

Never use CoVoST 2, MuST-C, TED-LIUM, Europarl-ST, LDC sets, copyrighted recordings or real patient audio.

## Using it

In the app, pick the clips under **Input** on the setup screen. They play in a loop instead of the mic; each clip waits for the interpreter to finish speaking. The same clips can then be replayed in the other mode, or across a mid-session mode switch.

`python3 eval/replay/check.py` validates the script file (ids, languages, glossary terms present in the references).
