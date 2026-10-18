# Realtime vs cascade interpretation: comparison write-up

> Every number comes from `eval/results/` (`eval/summarize.py <log>`, priced from `config/prices.json`). The prose is AI-written (AI_USAGE.md); I and a browsing AI assistant read the vendor pages on 2026-10-16. Method and full tables: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes share one UI. **Cascade** is streaming STT → LLM translator → streaming TTS on our server. **Realtime** is OpenAI speech-to-speech over WebRTC, instructed only to interpret, with no tools; it defaults to `gpt-realtime-2.1`, and the brief's `gpt-realtime` (deprecated, removal 2027-01-20) was measured too. **Realtime translate** is `gpt-realtime-translate`, which takes only a target language. In the measured configuration, the browser commits a turn 300 ms after its VAD hears speech end. Cascade STT is `gpt-realtime-whisper`: it streams text during speech, but translation starts on each turn's final. Input was synthetic TTS clips of scripted English and Spanish, so quality numbers are signals, not findings. Deepgram's terms bar benchmarking, so cascade uses OpenAI transcription.

**The 2026-10-18 audit found three limits in the 2026-10-16 runs.** The headline cascade run lasted 3.9 minutes, not 5 (every other run lasted 5.1). English clips all played before Spanish ones, so the runs are almost all English → Spanish (cascade 37 of 37 turns, Realtime 42–45 of 44–48). Cascade playback cut 16 s from the middle of long interpretations, which the text metrics don't see. All three are fixed in code since then (README, Known constraints); the numbers below have not been re-run.

## 2. Latency (client ms, speech end → first audio, 2026-10-16)

| Mode | n | p50 | p95 |
|---|---|---|---|
| Cascade (OpenAI STT + OpenAI translator + ElevenLabs; 3.9 min) | 36 | 1940 | 2319 |
| Realtime, `gpt-realtime-2.1` | 38 | 1271 | 1602 |
| Realtime, `gpt-realtime` | 36 | 1150 | 1490 |
| Realtime translate (2026-10-15; text lag) | 70 | 1984 | 5284 |

Realtime meets the brief's 1.5 s at p50 with both models; at p95 only `gpt-realtime` does. Cascade meets 3 s at p50 and p95, and the 2 s target at p50 only. Beyond 490–550 ms of endpointing, the largest stages are STT finalisation in cascade (1005 ms) and the model's opaque time in Realtime (560–675 ms).

Caveats: one synthetic run per configuration, with n below 50. In these runs cascade stopped its clock when its first chunk was scheduled and Realtime at the first audible frame; both now use the audible frame. Heap grew 18–22% from minute 1, against a target of under 10%. There were no disconnects.

## 3. Quality (synthetic audio, model-written references)

| Mode | Interpreted | chrF | STT WER | Flags |
|---|---|---|---|---|
| Cascade | 37/37 | 89.1 | 8.3% | none |
| Realtime, `gpt-realtime-2.1` | 48/48 | 82.9 | n/a | none |
| Realtime, `gpt-realtime` | 43/44 | 83.3 | n/a | 1 false positive |

WER covers cascade STT only; Realtime's source text comes from a separate model. chrF uses model-drafted alternative references. Those were added after earlier outputs existed, and 18 of 92 match an earlier output word for word, so chrF may be inflated. Blind review of 21 outputs (one rater, accept or reject, 2 Spanish → English): I accepted Realtime 7 of 7, cascade 6 of 7, Realtime translate 3 of 7 (segmentation faults).

## 4. Cost per minute

The default cascade costs $0.0290 per minute with STT, or $0.0193 without it ($0.0149 with the Claude translator). Realtime costs $0.1145 per minute with `gpt-realtime-2.1` and $0.2104 with `gpt-realtime`, both before input transcription. Realtime translate costs $0.034 per minute, or about $0.051 if its source transcript is billed.

Worked example for the cascade default: (2.63 STT min × $0.017 + 0.0185 M input tokens × $0.75 + 0.00044 M output tokens × $4.50 + 1.294 k chars × $0.04) ÷ 3.87 min = $0.0290/min (the $0.017 STT price is from a web search). Realtime costs four to seven times cascade.

## 5. Controllability and compliance

Speech is untrusted input. Realtime translate takes no instructions (structurally safest), Realtime relies on its instructions, and cascade's translator gets the transcript as delimited data with no tools. Deterministic checks flag suspect lines in every mode. On the 2026-10-15 red-team suite, no mode answered a question, and Realtime translate followed an instruction once in 53 lines. The main failure was loss. The fully faithful rate was 22% for cascade, 41% for Realtime and 45% for Realtime translate. Omission ran 36%, 29% and 34%, and meaning changed or unjudgeable ran 42%, 18% and 19%. One person labelled the outputs, and an AI agent drafted 154 of the 158 labels, so a Claude model labelled the Claude translator's outputs. Cascade stages swap by configuration; each Realtime mode is one vendor. No BAA is signed and the system is not HIPAA-compliant; BAA mode refuses ineligible routes.

## 6. Recommendation by scenario

**Consumer, low-stakes:** Realtime translate where the pair is supported, else Realtime. **Personal or health data, not clinical:** Realtime, or cascade (OpenAI STT + Claude + OpenAI TTS) with BAA mode and signed BAAs; never Realtime translate. **Unsupported pairs, glossary or register needs:** cascade; a new pair is configuration only (Vietnamese took about 5 minutes). **Medical and legal:** a qualified human interpreter, with AI only under human review. Reasons: appendix H.
