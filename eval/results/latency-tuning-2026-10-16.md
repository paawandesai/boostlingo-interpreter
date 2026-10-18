# Latency tuning runs (2026-10-16)

**Superseded for cascade:** the balanced 5-minute cascade re-run after the 2026-10-18 fixes is in [rerun-2026-10-18.md](rerun-2026-10-18.md) (p50/p95 1761/2239 ms). Each run is a 5-minute soak on the synthetic clip set (except the cascade default row, `cascade-whisper-client300-ttswarm-openai`, which ended after 3.9 minutes; see README, Known constraints). The soak played every English clip before any Spanish one, so these rows are almost all English → Spanish (cascade default 37 of 37 turns). The clips are synthetic (`eval/replay/synth.py`, TTS voices, not people), played with the turn-taking replay (MR !33): each clip waits for the previous clip's interpretation. Latency is measured client-side, from the browser VAD's speech end to the first audible output (D9). The measurement is the same in every row. chrF is multi-reference (reference plus `alternatives`, model-drafted and unverified). WER is cascade STT only. Rows come from `python3 eval/summarize.py <log> --out /tmp/row.md` on the files named (`--out` keeps the committed `summary.md` from being overwritten). Cost/min is the same command's cost column, priced from `config/prices.json` (the default `--prices`) as of 2026-10-17: the `gpt-realtime-whisper` STT is priced at $0.017/min from a 2026-10-17 web search, not OpenAI's page; the baseline cascade log has no STT quantity, and no Realtime log has an input-transcription quantity, so those rows exclude them.

Cascade rows ran in the cloud container. Realtime rows ran on the CI runner (job ids in brackets). Realtime is `gpt-realtime-2.1` except the `gpt-realtime` row, which ran with the same defaults afterwards. The cascade translator is OpenAI and the TTS is ElevenLabs.

| Run | Endpointing | STT | Commit delay | n | p50 ms | p95 ms | Lines interpreted | chrF | WER | Cost/min | File |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Cascade baseline | server VAD 500 ms | gpt-4o-transcribe | – | 37 | 2540 | 4170 | 37/37 | 89.0 | 4.0% | $0.0147 excl. STT (no quantity in the log) | `logs/2026-10-16-cascade-replay-openai-turntaking-synthetic.json` |
| Cascade | client | gpt-realtime-whisper | 150 ms | 54 | 2071 | 2722 | 57/57 | 78.8 | 19.2% | $0.0284 | `logs/2026-10-16-cascade-whisper-client150-openai-synthetic.json` |
| Cascade | client | gpt-realtime-whisper | 300 ms | 45 | 2061 | 3058 | 46/47 | 88.6 | 7.7% | $0.0289 | `logs/2026-10-16-cascade-whisper-client300-openai-synthetic.json` |
| Cascade + early TTS connect | client | gpt-realtime-whisper | 300 ms | 36 | **1940** | **2319** | 37/37 | 89.1 | 8.3% | **$0.0290** | `logs/2026-10-16-cascade-whisper-client300-ttswarm-openai-synthetic.json` |
| Realtime baseline (2026-10-15, old replay) | server VAD 500 ms | – | – | 19 | 2251 | 3451 | 27/29 | – | – | $0.2023 excl. input transcription | `logs/2026-10-15-realtime-replay-synthetic.json` |
| Realtime [234661] | client | – | 150 ms | 41 | 1404 | 1754 | 43/53 | 75.0 | – | $0.1493 excl. input transcription | `logs/2026-10-16-realtime-client150-synthetic.json` |
| Realtime [234781] | client | – | 300 ms | 37 | 1459 | 1908 | 41/46 | 81.8 | – | $0.1263 excl. input transcription | `logs/2026-10-16-realtime-client300-synthetic.json` |
| Realtime + held commit [234812] | client | – | 300 ms | 38 | **1271** | **1602** | 48/48 | 82.9 | – | **$0.1145** excl. input transcription | `logs/2026-10-16-realtime-client300-held-synthetic.json` |
| Realtime `gpt-realtime`, same defaults [234887] | client | – | 300 ms | 36 | 1150 | 1490 | 43/44 | 83.3 | – | $0.2104 excl. input transcription | `logs/2026-10-16-realtime-gpt-realtime-client300-synthetic.json` |

Against the brief:
- Realtime under 1.5 s is met at p50 (1271 ms) but not at p95 (1602 ms).
- `gpt-realtime` (the brief's model) meets it at p50 (1150 ms) and, in this one run, at p95 (1490 ms, just under the line). Its 44th turn was cut by the end of the run, and its one `wrong_language` flag was a false positive on a correct Spanish line ("a" counted twice as an English marker; fixed in e6c712f). Its heap grew 18.0%.
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
- gpt-realtime-whisper takes no prompt, so glossary terms reach only the translator.
- Its HIPAA eligibility has not been checked beyond the `/v1/realtime` route.

Where the time goes on the three default rows (p50 / p95 ms, from the same command; final lines only, so n can be one below the soak report's):

| Stage | Cascade + early TTS connect | Realtime + held commit | Realtime `gpt-realtime` |
|---|---|---|---|
| Total (speech end → first audio) | 1940 / 2319 (n 36) | 1271 / 1602 (n 38) | 1150 / 1490 (n 36) |
| Endpointing | 489 / 545 (n 36) | 543 / 650 (n 39) | 546 / 629 (n 37) |
| STT final | 1005 / 1200 (n 36) | – | – |
| Translation first token | 578 / 817 (n 37) | – | – |
| First flush | 89 / 136 (n 37) | – | – |
| TTS first byte | 173 / 213 (n 37) | – | – |
| Network | 22 / 74 (n 37) | – | – |
| Playback buffer | 58 / 1539 (n 37) | – | – |
| Response created | – | 23 / 61 (n 48) | 25 / 58 (n 43) |
| Model + audio (opaque) | – | 675 / 1035 (n 47) | 560 / 901 (n 42) |
