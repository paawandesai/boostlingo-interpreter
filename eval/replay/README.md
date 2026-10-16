# Replay set (T3.6, G10)

`scripts.jsonl` holds 70 utterances: 65 English/Spanish lines (20 English and 20 Spanish conversation lines, 15 adversarial lines with questions to the interpreter, instructions, fillers and one-word turns, and 10 medical lines that use the glossary terms in `config/glossary.json`) plus 5 Vietnamese onboarding lines with English references (T4.1, `eval/results/onboarding-vi.md`). `python3 eval/replay/check.py` prints the count per group. Each row has the source `text`, the `reference` translation and, for medical rows, the glossary `terms` it should contain.

**Unverified.** The model wrote every line and every reference translation. On 2026-10-16 a second model pass reviewed each reference and added `alternatives` (other acceptable renderings: the other register, Latin American and Peninsular word choices, natural paraphrases) to 59 rows; chrF counts any of them, so a correct paraphrase is not scored as an error, while the glossary check still uses `reference`. A fluent Spanish speaker must check the references and alternatives (and a Vietnamese speaker the 5 onboarding lines) before any quality number (chrF, COMET, glossary accuracy) is quoted; until then they are listed in AI_USAGE.md as unverified. The 2026-10-15 replay runs (`eval/results/summary.md`, docs/WRITEUP.md) used synthetic clips of these lines, so their numbers are labelled synthetic. Register is mixed (usted vs tú) on purpose in a few adversarial lines.

## Audio

Audio is never committed. Two sources are allowed (docs/GUARDRAILS.md, G10):

1. **Self-recorded (the measured set).** Record yourself, or a speaker who has agreed in writing, reading each line. Save as `audio/<id>.wav` (or `.webm`), e.g. `audio/en-conversation-01.wav`. The `en-`/`es-` prefix tells the app which speaker side the clip is.
2. **Synthetic (labelled extra set, not the measured set).** `python3 eval/replay/synth.py` writes TTS clips to `synthetic/` with OpenAI's speech endpoint (`OPENAI_API_KEY`, billed). Results from these clips are labelled synthetic wherever they appear; TTS speech is cleaner than a person and flatters STT.

Never use CoVoST 2, MuST-C, TED-LIUM, Europarl-ST, LDC sets, copyrighted recordings or real patient audio.

## Using it

In the app, pick the clips under **Input** on the setup screen. They play in a loop instead of the mic; each clip waits for the interpreter to finish speaking. The same clips can then be replayed in the other mode, or across a mid-session mode switch.

`python3 eval/replay/check.py` validates the script file (ids, languages, glossary terms present in the references).
