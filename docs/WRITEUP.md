# Realtime vs cascade interpretation: comparison write-up

> Every number comes from a file under `eval/results/`. No **[VERIFY]** markers remain: a vendor fact
> not read on the vendor's own page is labelled with where it came from. The prose is AI-written (AI_USAGE.md).
> I read the vendor prices, data terms and legal citations on the official pages on 2026-10-16, and a
> browsing AI assistant read them too; I checked its table against them (an AI coding agent read the Claude Haiku price on 2026-10-14).
> Method detail and longer analyses: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes behind one UI: *Cascade* (streaming STT → LLM translator → streaming TTS on our server),
*Realtime* (OpenAI speech-to-speech over WebRTC, instructed only to interpret, no tools) and *Realtime
translate* (`gpt-realtime-translate`, which takes only a target language). Realtime defaults to
`gpt-realtime-2.1`; the brief's `gpt-realtime` is deprecated (removal 2027-01-20 per OpenAI's
deprecations page) but selectable, and I measured both. Stack: .NET 10 server, TypeScript SPA; the
reasoning is in the README under "Why .NET + TypeScript" and in `docs/DECISIONS.md` D1–D2.

The measured configuration uses the defaults tuned in MR !37: the browser commits a turn 300 ms after its VAD hears
speech end (client endpointing), cascade STT is OpenAI transcription with its adapter's default model,
`gpt-realtime-whisper`, streaming (`Cascade__Stt=openai`; the code default is Deepgram, see below), and cascade opens
the TTS stream when translation starts. The STT streams text during speech, but translation starts
per committed turn, on the STT final. Each run looped synthetic TTS clips of scripted English ↔
Spanish dialogue for 5 minutes, each clip waiting for the previous interpretation (MR !33): no
recorded people, so every quality number is a synthetic-audio signal, not a finding. WER covers
cascade STT only; chrF scores each translation against a model-written, unverified reference and
its alternatives. I reviewed the references and a blind sheet of 21 outputs (7 per mode; 19 en → es and 2 es → en)
and judged 16 of 21 acceptable, without per-dimension scores; the five failures are one inserted assistant
phrase and four segmentation faults (cut-off or merged turns), noted on their rows
(`eval/results/rating-sheet-2026-10-16-synthetic.csv`, key in `rating-key-2026-10-16-synthetic.csv`). Deepgram's terms bar
benchmarking, so every cascade number uses OpenAI transcription (method: appendix A).

## 2. Latency (client ms, speech end → first audio, 2026-10-16)

| Mode | n | p50 | p95 |
|---|---|---|---|
| Cascade: `gpt-realtime-whisper` + OpenAI translator + ElevenLabs | 36 | 1940 | 2319 |
| Realtime, `gpt-realtime-2.1` | 38 | 1271 | 1602 |
| Realtime, `gpt-realtime` | 36 | 1150 | 1490 |
| Realtime translate (2026-10-15; text lag, source text → translated text) | 70 | 1984 | 5284 |

Sources: `eval/results/latency-tuning-2026-10-16.md` (one row per run, each from
`python3 eval/summarize.py <log> --out /tmp/row.md`, so the committed summary is not overwritten) and the `soak-2026-10-16-*.json` reports beside it. Before the
tuning, with server-side endpointing, cascade was 2540/4170 ms (2026-10-16 baseline run) and
`gpt-realtime-2.1` 2251/3451 (2026-10-15, older replay).

**Against the brief's targets.** Realtime meets 1.5 s at p50 with both models (1271 and 1150 ms).
At p95 only `gpt-realtime` meets it (1490 ms, one run, just under the line); `gpt-realtime-2.1`
misses (1602). Cascade meets 3 s at p50 and p95, and the 2 s target at p50 only (1940; p95 2319).
Endpointing is now 490–550 ms at p50 in every mode; in cascade the next largest stage is STT
finalisation (1005 ms at p50 from speech end, about 0.5 s after the commit), and in Realtime the
model's opaque time (560–675 ms). Stage breakdown: appendix B.

**Caveats.** One synthetic run per configuration; n is 36–38, below the 50 the guardrails ask for,
because each turn waits for its reply. Realtime translate and the Claude-translator cascade were not
re-run with the new defaults. Heap grew 8–22% from minute 1 (criterion < 10%); one 6-minute local
cascade probe levelled off at about 10.8 MB once the transcript view hit its 80-row cap, which points
at the view filling rather than a leak, but it is one run. 0 disconnects; cascade on the defaults
had 6 drift skips (16.0 s of late interpreter audio dropped), Realtime none; stability: appendix B.

## 3. Quality (synthetic audio, model-written references)

| Mode | Lines interpreted | Matched to a script line | chrF | STT WER | Glossary hits | Output-check flags |
|---|---|---|---|---|---|---|
| Cascade (defaults above) | 37 of 37 | 31 | 89.1 | 8.3% | 2 of 2 | none |
| Realtime, `gpt-realtime-2.1` | 48 of 48 | 36 | 82.9 | n/a | 7 of 9 | none |
| Realtime, `gpt-realtime` | 43 of 44 | 36 | 83.3 | n/a | 7 of 10 | wrong language 1 |

`gpt-realtime`'s 44th turn was cut by the end of the run, and its wrong-language flag was a false
positive on correct Spanish (a marker counted twice; fixed in e6c712f). chrF now also counts model-drafted alternative
references (on 59 of the 70 script lines), so it is **not comparable** with the single-reference
numbers of earlier drafts. Realtime translate was last run on 2026-10-15 with the old replay
(chrF 74.6 with the alternatives, 11 of 15 glossary hits, `eval/results/summary.md`). `gpt-realtime-whisper` takes no prompt, so
glossary terms reach only the translator. The 2026-10-15 cascade runs lost the ends of sentences
because the replay started the next clip too early; MR !33 fixed the harness (appendix C). The
Vietnamese onboarding run used Deepgram STT, so it has no published quality number
(`eval/results/onboarding-vi.md`). **This table is not a ranking:** the audio is synthetic. My
blind review judged 16 of 21 sampled outputs acceptable: Realtime 7 of 7, cascade 6 of 7 (one cut-off
turn) and Realtime translate 3 of 7 (an inserted "¿Cómo puedo ayudarte hoy?" and three cut-off or
merged turns). Seven rows per mode is a small sample, but the failures cluster in Realtime translate.

## 4. Cost per minute

| Mode | Billing unit | Price | Per minute |
|---|---|---|---|
| Cascade | STT minutes + translator tokens + TTS characters | Translator per M tokens in/out: Claude Haiku $0.10 / $0.50, `gpt-5.4-mini` $0.75 / $4.50; `gpt-realtime-whisper` $0.017/min (web search, 2026-10-17); ElevenLabs Flash $0.04 per 1,000 characters | $0.0149 (Claude) / $0.0193 (OpenAI translator), excluding STT; $0.0290 with STT on the 2026-10-16 default config (OpenAI translator) |
| Realtime | audio and text tokens in and out (cached input at the cached rate) + input transcription, billed separately | per M tokens: audio $32 in / $64 out, text $4 in, cached input $0.40 (both models); text out $24 (`gpt-realtime-2.1`) / $16 (`gpt-realtime`) | `gpt-realtime-2.1` $0.1145, `gpt-realtime` $0.2104, both excluding input transcription |
| Realtime translate | minutes of audio | $0.034/min | about $0.051 with the source transcript (assumed billed); $0.034 without |

Cascade and Realtime translate are from `eval/results/summary.md` (2026-10-15 logs); Realtime is
from the 2026-10-16 logs, priced from `config/prices.json`. Same audio-input price, but
`gpt-realtime` got far less prompt caching than `gpt-realtime-2.1`, so it cost almost twice as much.
Realtime costs about six to fourteen times cascade excluding cascade STT, or about four to seven
times the default cascade with STT ($0.0290). The `gpt-realtime-whisper` price comes from a web search
summary of OpenAI's pricing page, which this project could not open. Cascade bills up to three vendors (two in the
BAA profile); the Realtime modes bill one. The Realtime translate session also requests a
`gpt-realtime-whisper` source transcript. OpenAI's pages found by a 2026-10-17 web search don't say
whether it is billed on top of the $0.034; Realtime bills its input transcription separately, so this
write-up assumes the same and counts it at $0.017/min, about $0.051/min in total. What each figure leaves out: appendix B.

## 5. Controllability and compliance

Speech is untrusted input to an instructed model. Realtime translate takes no instructions and has
no tools, so it is structurally the safest; Realtime relies on its instructions; cascade's
translator gets the transcript as delimited data. Every output line is run through deterministic
checks. On the red-team suite (2026-10-15, synthetic voices, one labeller) no mode answered a
question addressed to it, and only Realtime translate followed an instruction once (1/53).
Cascade's failures were loss (36% omission), partly the old replay's fault. Cascade stages swap by
configuration; the Realtime modes are one vendor each, and leaving means a new transport. No BAA
is in place and this is not HIPAA-compliant; BAA mode refuses routes outside each vendor's
eligible list. Rates, examples and the data-flow table: [appendix G](WRITEUP-APPENDIX.md#g-controllability-and-compliance-in-full),
[D](WRITEUP-APPENDIX.md#d-red-team-failure-examples) and [E](WRITEUP-APPENDIX.md#e-vendor-data-flows).

## 6. Recommendation by scenario

- **Consumer and low-stakes:** Realtime translate where the pair is supported, else Realtime.
- **Personal or health data, not itself clinical or legal:** Realtime, or cascade on OpenAI STT +
  Claude + OpenAI TTS, with BAA mode on and the BAAs signed; never Realtime translate.
- **Pairs Realtime translate lacks, or a glossary or register is needed:** cascade; a new pair is
  configuration only (Vietnamese took about 5 minutes).
- **Quality on a rare pair:** cascade for low-stakes use only; unverified without a native speaker.
- **Medical and legal:** a qualified human interpreter; AI only with a human reviewing it.

Reasons for each: [appendix H](WRITEUP-APPENDIX.md#h-recommendation-by-scenario-in-full).

## 7. What this does not show

- No recorded human speech, and one synthetic run per configuration; no run reached 50 latency
  samples, and of the two Realtime models only `gpt-realtime-2.1` went through the red-team suite.
- No Deepgram numbers; the `gpt-realtime-whisper` price behind the $0.0290 cascade figure is from a web search, not OpenAI's page.
- Heap grew more than 10% from minute 1 in every 2026-10-16 run but one (8.2%).
- Cascade drops late audio to stay in sync: 6 drift skips and 16.0 s dropped on the defaults.
- Quality references are model-written; one person reviewed them and the 21-row blind sheet (16 acceptable,
  4 of the 5 failures in Realtime translate), with no per-dimension scores. The red-team labels have one labeller.
