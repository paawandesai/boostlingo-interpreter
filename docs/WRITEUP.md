# Realtime vs cascade interpretation: comparison write-up

> Every number comes from `eval/results/` (`eval/summarize.py <log>`, priced from `config/prices.json`). The prose is AI-written (AI_USAGE.md); I and a browsing AI assistant read the vendor pages on 2026-10-16. Method and full tables: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes share one UI. **Cascade** is streaming STT → LLM translator → streaming TTS on our server. **Realtime** is OpenAI speech-to-speech over WebRTC, instructed only to interpret, with no tools; it defaults to `gpt-realtime-2.1`, and the brief's `gpt-realtime` (deprecated, removal 2027-01-20) was measured too. **Realtime translate** is `gpt-realtime-translate`, which takes only a target language. In the measured configuration, the browser commits a turn 300 ms after its VAD hears speech end. Cascade STT is `gpt-realtime-whisper`: it streams text during speech, but translation starts on each turn's final. Input was synthetic TTS clips of scripted English and Spanish, so quality numbers are signals, not findings. Deepgram's terms bar benchmarking, so cascade uses OpenAI transcription.

**The 2026-10-18 audit found three limits in the 2026-10-16 runs:** the cascade run lasted 3.9 minutes, English clips all played first (Realtime 42–45 of 44–48 turns English → Spanish), and cascade playback cut 16 s from long turns. After the fixes, cascade was re-run for 5.1 minutes with 26 turns each way and no audio cut (`eval/results/rerun-2026-10-18.md`); Realtime was not re-run.

## 2. Latency (client ms, speech end → first audio)

| Mode | n | p50 | p95 |
|---|---|---|---|
| Cascade (OpenAI STT + OpenAI translator + ElevenLabs; 2026-10-18) | 47 | 1761 | 2239 |
| Realtime, `gpt-realtime-2.1` (2026-10-16) | 38 | 1271 | 1602 |
| Realtime, `gpt-realtime` (2026-10-16) | 36 | 1150 | 1490 |
| Realtime translate (2026-10-15; text lag) | 70 | 1984 | 5284 |

Realtime meets the brief's 1.5 s at p50 with both models; at p95 only `gpt-realtime` does. Cascade meets 3 s at p50 and p95, and the 2 s target at p50 only (English → Spanish 1841/2249, Spanish → English 1676/2018). Beyond about 500 ms of endpointing, the largest stages are STT finalisation in cascade (955 ms) and the model's opaque time in Realtime (560–675 ms).

Caveats: one synthetic run per configuration, with n below 50. Both modes stop at the first audible frame; the 2026-10-16 cascade runs stopped at the first scheduled chunk. Heap grew 15–21% from minute 1, against a target of under 10%.

## 3. Quality (synthetic audio, model-written references)

| Mode | Interpreted | chrF | STT WER | Flags |
|---|---|---|---|---|
| Cascade (2026-10-18) | 52/52 | 80.7 | 12.0% | 1 true positive |
| Realtime, `gpt-realtime-2.1` | 48/48 | 82.9 | n/a | none |
| Realtime, `gpt-realtime` | 43/44 | 83.3 | n/a | 1 false positive |

WER covers cascade STT only; Realtime's source text comes from a separate model. Cascade's run adds Spanish and adversarial sources, so it doesn't compare with 2026-10-16 (chrF 89.1, WER 8.3%); its flag is a real failure, an injection left untranslated. chrF uses model-drafted alternative references. Those were added after earlier outputs existed, and 18 of 92 match an earlier output word for word, so chrF may be inflated. Blind review of 21 outputs (one rater, accept or reject, 2 Spanish → English): I accepted Realtime 7 of 7, cascade 6 of 7, Realtime translate 3 of 7 (segmentation faults).

## 4. Cost per minute

Cascade costs $0.0280 per minute: 3.25 STT minutes at $0.017 (a web-searched price), 0.0257 M input tokens at $0.75, 0.00056 M output tokens at $4.50 and 1.638 k characters at $0.04, over 5.09 minutes. Realtime costs $0.1145 per minute with `gpt-realtime-2.1` and $0.2104 with `gpt-realtime`, before input transcription: four to eight times cascade. Realtime translate costs $0.034, or about $0.051 if its source transcript is billed.

## 5. Controllability and compliance

Speech is untrusted input. Realtime translate takes no instructions (structurally safest), Realtime relies on its instructions, and cascade's translator gets the transcript as delimited data with no tools. Deterministic checks flag suspect lines in every mode. On the 2026-10-15 red-team suite, no mode answered a question, and Realtime translate followed an instruction once in 53 lines. The main failure was loss: fully faithful 22% (cascade), 41% (Realtime), 45% (translate); omission 36%, 29%, 34%; meaning changed or unjudgeable 42%, 18%, 19%. One person labelled the outputs, and an AI agent drafted 154 of the 158 labels, so a Claude model labelled the Claude translator's outputs. No BAA is signed and the system is not HIPAA-compliant; BAA mode refuses ineligible routes.

## 6. Recommendation by scenario

**Consumer, low-stakes:** Realtime translate where the pair is supported, else Realtime. **Personal or health data, not clinical:** Realtime, or cascade (OpenAI STT + Claude + OpenAI TTS) with BAA mode and signed BAAs; never Realtime translate. **Unsupported pairs, glossary or register needs:** cascade; a new pair is configuration only (Vietnamese took about 5 minutes). **Medical and legal:** a qualified human interpreter, with AI only under human review. Reasons: appendix H.
