# Latency tuning runs (2026-10-16)

Each run is a 5-minute soak on the synthetic clip set (`eval/replay/synth.py`, TTS voices, not people), with the turn-taking replay (MR !33): each clip waits for the previous clip's interpretation. Latency is measured client-side, from the browser VAD's speech end to the first audible output (D9). The measurement is the same in every row. chrF is multi-reference (reference plus `alternatives`, model-drafted and unverified). WER is cascade STT only. Rows come from `python3 eval/summarize.py <log>` on the files named.

Cascade rows ran in the cloud container. Realtime rows ran on the CI runner (job ids in brackets). Realtime is `gpt-realtime-2.1`. The cascade translator is OpenAI and the TTS is ElevenLabs.

| Run | Endpointing | STT | Commit delay | n | p50 ms | p95 ms | Lines interpreted | chrF | WER | File |
|---|---|---|---|---|---|---|---|---|---|---|
| Cascade baseline | server VAD 500 ms | gpt-4o-transcribe | – | 37 | 2540 | 4170 | 37/37 | 89.0 | 4.0% | `logs/2026-10-16-cascade-replay-openai-turntaking-synthetic.json` |
| Cascade | client | gpt-realtime-whisper | 150 ms | 54 | 2071 | 2722 | 57/57 | 78.8 | 19.2% | `logs/2026-10-16-cascade-whisper-client150-openai-synthetic.json` |
| Cascade | client | gpt-realtime-whisper | 300 ms | 45 | 2061 | 3058 | 46/47 | 88.6 | 7.7% | `logs/2026-10-16-cascade-whisper-client300-openai-synthetic.json` |
| Cascade + early TTS connect | client | gpt-realtime-whisper | 300 ms | 36 | **1940** | **2319** | 37/37 | 89.1 | 8.3% | `logs/2026-10-16-cascade-whisper-client300-ttswarm-openai-synthetic.json` |
| Realtime baseline (2026-10-15, old replay) | server VAD 500 ms | – | – | 19 | 2251 | 3451 | 27/29 | – | – | `logs/2026-10-15-realtime-replay-synthetic.json` |
| Realtime [234661] | client | – | 150 ms | 41 | 1404 | 1754 | 43/53 | 75.0 | – | `logs/2026-10-16-realtime-client150-synthetic.json` |
| Realtime [234781] | client | – | 300 ms | 37 | 1459 | 1908 | 41/46 | 81.8 | – | `logs/2026-10-16-realtime-client300-synthetic.json` |
| Realtime + held commit [234812] | client | – | 300 ms | 38 | **1271** | **1602** | 48/48 | 82.9 | – | `logs/2026-10-16-realtime-client300-held-synthetic.json` |

Against the brief:
- Realtime under 1.5 s is met at p50 (1271 ms) but not at p95 (1602 ms).
- Cascade under 3 s is met at p50 and p95. The 2 s target is met at p50 (1940 ms) but not at p95 (2319 ms).

What changed:
- **Client endpointing.** The vendor's silence detector waited 500 ms plus its own detection. The replay also showed that the server VAD often never heard the gaps between clips, which merged Realtime turns. Now the browser commits the turn 300 ms after its VAD reports speech end, which is about 500 ms after the last voiced frame.
- **gpt-realtime-whisper.** It streams words during speech. Its final arrives about 0.5 s after the commit; gpt-4o-transcribe took about 0.9 s.
- **Early TTS connect.** TTS first byte went from 299 to 173 ms at p50.
- **Held commit.** In Realtime, a turn that ends while a response is active waits for that response instead of failing. This was the cause of the 10 uninterpreted turns at 150 ms.

Limits:
- Synthetic voices and one run per row.
- n stays below the soak's 50 turns because each turn waits for its reply.
- Heap grew 8–22% from minute 1, against a criterion of under 10%.
- The 150 ms delay split sentences at short pauses, which shows as the WER and chrF drop, so 300 ms is the default.
- gpt-realtime-whisper has no price in `config/prices.json` yet, so the cascade cost column here is not its real cost.
- gpt-realtime-whisper takes no prompt, so glossary terms reach only the translator.
- Its HIPAA eligibility has not been checked beyond the `/v1/realtime` route.
