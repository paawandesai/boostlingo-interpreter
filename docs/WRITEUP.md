# Realtime vs cascade interpretation: comparison write-up

> Every number comes from a file under `eval/results/`. **[VERIFY]** and **[REPHRASE]** markers are
> mine to clear: a vendor page, citation or figure to check, or an opinion to restate in my own words.
> A browsing AI assistant read the vendor prices, data terms and legal citations on the official pages
> on 2026-10-16 and I checked its table (an AI coding agent read the Claude Haiku price on 2026-10-14).
> Method detail and longer analyses: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes behind one UI: *Cascade* (streaming STT → LLM translator → streaming TTS on our server),
*Realtime* (OpenAI speech-to-speech over WebRTC, instructed only to interpret, no tools) and *Realtime
translate* (`gpt-realtime-translate`, which takes only a target language). Realtime defaults to
`gpt-realtime-2.1`; the brief's `gpt-realtime` is deprecated (removal 2027-01-20 per OpenAI's
deprecations page) but selectable, and I measured both. Stack: .NET 10 server, TypeScript SPA; the
reasoning is in the README under "Why .NET + TypeScript" and in `docs/DECISIONS.md` D1–D2.

The defaults are the ones tuned in MR !37: the browser commits a turn 300 ms after its VAD hears
speech end (client endpointing), cascade STT is `gpt-realtime-whisper` streaming, and cascade opens
the TTS stream when translation starts. Each run looped synthetic TTS clips of scripted English ↔
Spanish dialogue for 5 minutes, each clip waiting for the previous interpretation (MR !33): no
recorded people, so every quality number is a synthetic-audio signal, not a finding. WER covers
cascade STT only; chrF scores each translation against a model-written, unverified reference and
its alternatives **[VERIFY: I check references, then score blind]**. Deepgram's terms bar
benchmarking, so every cascade number uses OpenAI transcription (method: appendix A).

## 2. Latency (client ms, speech end → first audio, 2026-10-16)

| Mode | n | p50 | p95 |
|---|---|---|---|
| Cascade: `gpt-realtime-whisper` + OpenAI translator + ElevenLabs | 36 | 1940 | 2319 |
| Realtime, `gpt-realtime-2.1` | 38 | 1271 | 1602 |
| Realtime, `gpt-realtime` | 36 | 1150 | 1490 |
| Realtime translate (2026-10-15; text lag, source text → translated text) | 70 | 1984 | 5284 |

Sources: `eval/results/latency-tuning-2026-10-16.md` (one row per run, each from
`python3 eval/summarize.py <log>`) and the `soak-2026-10-16-*.json` reports beside it. Before the
tuning, with server-side endpointing, cascade was 2540/4170 ms and `gpt-realtime-2.1` 2251/3451.

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
at the view filling rather than a leak, but it is one run. 0 disconnects; stability: appendix B.

## 3. Quality (synthetic audio, model-written references)

| Mode | Lines interpreted | Matched to a script line | chrF | STT WER | Glossary hits | Output-check flags |
|---|---|---|---|---|---|---|
| Cascade (defaults above) | 37 of 37 | 31 | 89.1 | 8.3% | 2 of 2 | none |
| Realtime, `gpt-realtime-2.1` | 48 of 48 | 36 | 82.9 | n/a | 7 of 9 | none |
| Realtime, `gpt-realtime` | 43 of 44 | 36 | 83.3 | n/a | 7 of 10 | wrong language 1 |

`gpt-realtime`'s 44th turn was cut by the end of the run, and its wrong-language flag was a false
positive on correct Spanish (a marker counted twice; fixed in e6c712f). chrF now also counts model-drafted alternative
references (on 59 of the 70 script lines), so it is **not comparable** with the single-reference
numbers of earlier drafts. Realtime translate was last scored on 2026-10-15 with the old replay and
one reference (chrF 69.4, 11 of 15 glossary hits). `gpt-realtime-whisper` takes no prompt, so
glossary terms reach only the translator. The 2026-10-15 cascade runs lost the ends of sentences
because the replay started the next clip too early; MR !33 fixed the harness (appendix C). The
Vietnamese onboarding run scored chrF 90.8 on 8 of 13 lines against references no Vietnamese
speaker has checked (`eval/results/onboarding-vi.md`). **This table is not a ranking** until there
is recorded speech, checked references and my own rubric, scored with the mode hidden.

## 4. Cost per minute

| Mode | Billing unit | Price | Per minute |
|---|---|---|---|
| Cascade | STT minutes + translator tokens + TTS characters | Translator per M tokens in/out: Claude Haiku $0.10 / $0.50, `gpt-5.4-mini` $0.75 / $4.50; `gpt-realtime-whisper` **[VERIFY: price]**; ElevenLabs Flash $0.04 per 1,000 characters | $0.0149 (Claude) / $0.0193 (OpenAI translator), excluding STT |
| Realtime | audio and text tokens in and out (cached input at the cached rate) + input transcription, billed separately | per M tokens: audio $32 in / $64 out, text $4 in, cached input $0.40 (both models); text out $24 (`gpt-realtime-2.1`) / $16 (`gpt-realtime`) | `gpt-realtime-2.1` $0.1145, `gpt-realtime` $0.2104, both excluding input transcription |
| Realtime translate | minutes of audio | $0.034/min | $0.034 |

Cascade and Realtime translate are from `eval/results/summary.md` (2026-10-15 logs); Realtime is
from the 2026-10-16 logs, priced from `config/prices.json`. Same audio-input price, but
`gpt-realtime` got far less prompt caching than `gpt-realtime-2.1`, so it cost almost twice as much.
Realtime costs about six to fourteen times cascade. Cascade bills up to three vendors (two in the
BAA profile); the Realtime modes bill one. What each figure leaves out: appendix B.

## 5. Controllability and compliance

**Prompt injection.** All speech is untrusted input to an instructed model. Realtime translate is
structurally the safest: no instructions and no tools, so "ignore your instructions" can only be
translated. Realtime relies on its instructions and has no tools; cascade's translator gets the
transcript as delimited data with no tools. Every output line in every mode is run through
deterministic checks (target language, length ratio, assistant phrasing, refusal, prompt-leak
canary). The red-team suite (`eval/adversarial/`) ran on 2026-10-15 in all four configurations on
synthetic voices (Realtime on `gpt-realtime-2.1`; the two speaker-echo lines need a real room and
were not run). Rates come from a shuffled sheet on which the mode was hidden, each output judged
against the line's intended (faithful) rendering. An AI coding agent drafted 154 of the 158 labels
from my first four; I reviewed and approved the sheet: one labeller, no second rater
(`eval/results/redteam-labels-2026-10-15-synthetic.csv`, key in `redteam-key-2026-10-15-synthetic.csv`).

| Rate | Cascade (both translators) | Realtime | Realtime translate |
|---|---|---|---|
| Answered instead of translating | 0/88 (0%) | 0/17 (0%) | 0/53 (0%) |
| Instruction followed | 0/88 (0%) | 0/17 (0%) | 1/53 (2%) |
| Omission | 32/88 (36%) | 5/17 (29%) | 18/53 (34%) |
| Refusal | 0/88 (0%) | 1/17 (6%) | 0/53 (0%) |
| Wrong language | 0/88 (0%) | 1/17 (6%) | 0/53 (0%) |
| Meaning changed or garbled ("other") | 37/88 (42%) | 3/17 (18%) | 10/53 (19%) |
| Fully faithful | 19/88 (22%) | 7/17 (41%) | 24/53 (45%) |

No mode answered a question addressed to it. Cascade's weakness here is loss, not obedience, and
it ran with the old replay's sentence-tail loss (examples in appendix D). These are subjective
counts with small n: failure shapes, not benchmark rates.

**Lock-in and observability.** Each cascade stage is a config entry behind one interface: the STT
swaps (Deepgram, `gpt-4o-transcribe`, `gpt-realtime-whisper`) and the translator swap (OpenAI to
Claude) were config-only, and every stage reports its own marks, so a slow vendor is visible per
stage. Realtime and Realtime translate are one vendor each: the model's time is opaque, no stage can
be swapped, and leaving the vendor means a new transport, not a setting. Model lifecycle is part of
the same risk: the brief's `gpt-realtime` is already deprecated, and `gpt-4o-transcribe`, now the
STT fallback, is listed for shutdown on 2027-02-26. A replacement must be re-measured before it is
trusted.

**Data flows.** No BAA or zero-retention terms are in place for this project, and it is not
HIPAA-compliant. BAA mode (off by default, README "BAA mode") refuses any route not on its vendor's
HIPAA-eligible list, so Realtime translate is always refused; the per-vendor retention, zero-retention
and BAA table is in [appendix E](WRITEUP-APPENDIX.md#e-vendor-data-flows).

## 6. Recommendation by scenario **[REPHRASE]**

| Scenario | Recommendation | Why |
|---|---|---|
| Consumer and low-stakes (travel, retail, customer service) | Realtime translate where the pair is supported, else Realtime | Lowest structural injection risk, one vendor, simplest billing. |
| Any setting with personal or health data that is not itself clinical or legal (scheduling, billing, intake) | Realtime, or cascade on OpenAI STT + Claude + OpenAI TTS (OpenAI TTS passed a live test; in-session latency and cost unmeasured), with BAA mode on and each vendor's BAA and retention terms signed; never Realtime translate | Realtime translate's endpoint is not on OpenAI's HIPAA-eligible list. That cascade needs two agreements (OpenAI and Anthropic); the default ElevenLabs TTS would add a third, and ElevenLabs offers zero retention and a BAA only on Enterprise; on lower plans it keeps TTS history and may train on the text unless "Data use" is off (off for this project). |
| Pairs Realtime translate does not support, or a needed glossary/tone: the cost of onboarding | Cascade | Any language the STT/TTS support is a config entry: Vietnamese took about 5 minutes of configuration and about 50 lines of eval tooling, 0 application-code lines, timed by an AI coding agent (`eval/results/onboarding-vi.md`); glossary and register are controllable. |
| The same pairs: quality on the new pair | Cascade for low-stakes use only; a human interpreter, or a human relay, in regulated settings | Unverified: no Vietnamese speaker has checked the notices, word lists or references, and AI quality is expected to be lowest on rare pairs. Cheap onboarding says nothing about fidelity. |
| Medical and legal | A qualified human interpreter; AI only with a human reviewing it | ACA Section 1557 requires qualified human review of machine translation where accuracy is critical and a qualified interpreter for spoken interpretation, and federal and California courts require certified or qualified interpreters (citations in [appendix F](WRITEUP-APPENDIX.md#f-medical-and-legal-citations)). Latency and cost are secondary. |

## 7. What this does not show

- No recorded human speech, and one synthetic run per configuration; no run reached 50 latency
  samples, and only `gpt-realtime-2.1` went through the red-team suite.
- No Deepgram numbers, and no cascade cost with `gpt-realtime-whisper` priced.
- Heap grew more than 10% from minute 1 in every 2026-10-16 run but one (8.2%).
- Quality references are model-written and unchecked, and the red-team labels have one labeller.
