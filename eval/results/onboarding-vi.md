# T4.1: English ↔ Vietnamese onboarded by configuration (2026-10-15)

**Time:** about 5 minutes from the first edit to both directions working end to end (13:16 to 13:21 UTC), including writing the Vietnamese text. Timed by the agent that did it, not by a person.

**What changed**

| Change | Lines | Kind |
|---|---|---|
| `config/languages.json`: one `vi` entry (name, AI-use notice and spoken notice, Deepgram `nova-3`/`vi`, ElevenLabs default voice, flush punctuation, `wer`, output-check word lists, `realtimeTranslate: false`) and the pair `["en", "vi"]` | +81 | Configuration |
| Application code (server and web) | 0 | None needed |
| `eval/replay/check.py`: read language codes from `config/languages.json` instead of a hard-coded `{en, es}` | +8 −2 | Eval tooling |
| `eval/replay/synth.py`: `--provider elevenlabs` and `--only`, to make Vietnamese clips while the OpenAI account had no credit | +40 −3 | Eval tooling |
| `eval/replay/scripts.jsonl`: five Vietnamese lines with English references | +5 | Eval data |

**Check:** Cascade mode (Deepgram STT, Claude translator, ElevenLabs Flash v2.5), replaying synthetic ElevenLabs clips through the browser in Chromium:

| Direction | Lines | Translated | Output-check flags | Audio failures |
|---|---|---|---|---|
| vi → en (the 5 onboarding lines, looped) | 8 | 8 | 0 | 0 |
| en → vi (5 conversation lines) | 5 | 5 | 0 | 0 |

Example: "Tôi bị đau đầu từ hôm qua." → "I've had a headache since yesterday."; "I'm looking for the train station." → "Tôi đang tìm ga tàu."

**Not done or not verified**
- No latency numbers: this run used Deepgram, whose terms bar benchmarking (docs/GUARDRAILS.md), and was a functional check only.
- Realtime and Realtime translate were not tried: the OpenAI account had no credit. `realtimeTranslate` stays false until a live check.
- The Vietnamese notices, output-check word lists and references were written by the model and have not been checked by a Vietnamese speaker.
- The medical glossary has no Vietnamese terms, so the glossary option does nothing for this pair.
- The clips are synthetic (ElevenLabs stock voice), not recorded speech.

## Summary of the two logs

The two session logs are summarised separately from `eval/results/summary.md`, which covers only the
four English ↔ Spanish replay runs:

```bash
python3 eval/summarize.py --out /tmp/onboarding-vi-summary.md eval/results/logs/2026-10-15-cascade-en-vi-synthetic.json eval/results/logs/2026-10-15-cascade-vi-en-synthetic.json
```

`--out` keeps it from overwriting the committed `eval/results/summary.md`. It wrote (2026-10-16):

**Cascade (anthropic translator):** latency withheld for 13 utterances run on Deepgram STT (its terms bar benchmarking).

| Mode | Lines (final) | Matched to script | chrF | STT WER | Glossary | Output-check flags | Cost/min |
|---|---|---|---|---|---|---|---|
| Cascade (anthropic translator) | 13 of 14 | 8 | 90.8 | withheld (Deepgram) | – | none | $0.0140 (excludes STT: no quantity in the log) |

Read the chrF with these caveats:

- **Matched-line counts.** The two logs hold 14 final lines (8 vi → en from the 5 onboarding lines looped, 6 en → vi), 13 of them translated; the line matcher paired 8 of those with a script line, and chrF 90.8 is computed on those 8 only.
- **Synthetic clips.** ElevenLabs stock-voice TTS, not recorded speech; TTS speech is cleaner than a person and flatters STT.
- **Deepgram STT, so no latency and no WER.** Its terms bar benchmarking (docs/GUARDRAILS.md); `summarize.py` withholds both.
- **Model-written references.** The Vietnamese references were written by the model and no Vietnamese speaker has checked them, so chrF here measures agreement with the model's own rendering, not with a human one. It is a functional signal that the pair works, not a quality number for the pair.
