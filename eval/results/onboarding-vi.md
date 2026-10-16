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
| en → vi (5 conversation lines, and a sixth that was never finalised) | 6 | 5 | 0 | 0 |

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

`--out` keeps it from overwriting the committed `eval/results/summary.md`. On 2026-10-16 it reported 13 of the 14 lines final and translated (8 vi → en from the 5 onboarding lines looped, 6 en → vi, the last of which never became final), with no output-check flags, and $0.0140/min excluding STT (the log has no STT quantity).

No latency, WER or chrF is published for this run. It used Deepgram STT, whose terms bar benchmarking without written consent (docs/GUARDRAILS.md), so it counts as a functional check that the pair works end to end, not a measurement. The Vietnamese references were also written by the model and no Vietnamese speaker has checked them.
