# Realtime vs cascade interpretation: comparison write-up

> Every number comes from a file under `eval/results/`. **[VERIFY]** and **[REPHRASE]** markers await
> Paawan: a vendor page, citation or figure to check, or an opinion to restate in their own words.
> Method detail and longer analyses: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes behind one UI: *Cascade* (streaming STT → LLM translator → streaming TTS on our server),
*Realtime* (`gpt-realtime-2.1` speech-to-speech over WebRTC, instructed only to interpret, no tools)
and *Realtime translate* (`gpt-realtime-translate`, which takes only a target language). The brief's `gpt-realtime` is deprecated (removal 2027-01-20 **[VERIFY]**); it is selectable
in the setup screen with no code change but is not the default, and all Realtime numbers here are for
`gpt-realtime-2.1`: `gpt-realtime` minted sessions (2026-10-14) but was never measured, because OpenAI
credit ran out on 2026-10-15 (`docs/ACCEPTANCE.md`). Stack: .NET 10 server, TypeScript SPA; the
reasoning is in the README under "Why .NET + TypeScript" and in `docs/DECISIONS.md` D1–D2.

Every run (T4.2, 2026-10-15) looped synthetic TTS clips of scripted English ↔ Spanish dialogue for
5 minutes per mode (4 per red-team configuration): no recorded people, so every quality number is a
synthetic-audio signal, not a finding. WER covers cascade STT only; chrF scores each translation
against a model-written, unverified reference **[VERIFY: Paawan checks references, then scores
blind]**. Deepgram's terms bar benchmarking, so every cascade number uses OpenAI transcription
(method: appendix A).

## 2. Latency (client ms, 5-minute synthetic replay, 2026-10-15)

| Mode | What is measured | n | p50 | p95 |
|---|---|---|---|---|
| Cascade, OpenAI STT + OpenAI translator | speech end → first audio | 46 | 2440 | 4097 |
| Cascade, OpenAI STT + Claude translator | speech end → first audio | 45 | 2521 | 5160 |
| Realtime (`gpt-realtime-2.1`) | speech end → first audio | 19 | 2251 | 3451 |
| Realtime translate | source text → translated text | 70 | 1984 | 5284 |

Sources: `eval/results/summary.md` and `eval/results/soak-2026-10-15-*.json`; regenerate with
`python3 eval/summarize.py eval/results/logs/2026-10-15-*-replay-*.json` (the red-team and Vietnamese
logs are summarised separately).

**Against the brief's targets.** Realtime (p50 2251 ms, p95 3451) misses the 1.5 s target: 0 of its
19 turns were under 1.5 s. Cascade (p50 2440 ms with the OpenAI translator, 2521 with Claude) meets
the 3 s requirement at p50, misses it at p95 (4097 / 5160), and misses the 2 s target on every turn.
Endpointing is the largest fixed component: 726–728 ms at p50 in cascade, 1266 ms in Realtime.

The next largest is STT finalisation (1195 ms at p50 in cascade), and part of it is specific to
OpenAI transcription: the pipeline translates on each STT final, Deepgram sends finals mid-utterance,
but OpenAI transcription sends one final per turn after its own server VAD, so these numbers include
that wait. The full stage breakdown is in appendix B.

**Sample sizes.** No run reached the 50 samples the guardrails ask for: cascade 46 and 45 of 63 and
57 utterances (turns the STT split without a client-VAD pause have no speech-end mark); Realtime 19
(the looped clips merged into 29 longer turns, and the mic is gated while it speaks); Realtime
translate 1 start-lag sample, because it speaks while the speaker still talks, and its 70-sample text
lag says how far it trails, not how long a listener waits (appendix B).

**Stability**, per 2026-10-15 run (replay 5 minutes, red-team 4):

| Run | Disconnects | Drift skips | Late audio dropped | Heap growth from minute 1 | Last-two-minute slope |
|---|---|---|---|---|---|
| Cascade replay, OpenAI translator | 0 | 12 | 22.0 s | 14.3% | +0.195 MB/min |
| Cascade replay, Claude translator | 0 | 15 | 25.6 s | 20.0% | +0.249 MB/min |
| Realtime replay | 0 | 0 | 0 s | 18.9% | +0.298 MB/min |
| Realtime translate replay | 0 | 0 | 0 s | 8.5% | −0.192 MB/min |
| Cascade red-team, OpenAI / Claude translator | 0 / 0 | 6 / 11 | 12.4 s / 24.8 s | 10.1% / 21.2% | −0.002 / +0.619 MB/min |

A drift skip is the playback scheduler dropping the oldest queued interpreter audio once more than
3 s is queued ahead of the play cursor (`web/src/audio/playback.ts`), so latency cannot creep up; in
cascade that cost 22–26 s of interpreter speech per 5-minute replay. Heap grew 8.5–20% from minute 1
across the four replay runs (criterion < 10%; only Realtime translate passed), 21.2% in the
Claude-translator red-team run.

## 3. Quality (synthetic audio, model-written references)

| Mode | Lines interpreted | Matched to a script line | chrF | STT WER | Glossary hits | Output-check flags |
|---|---|---|---|---|---|---|
| Cascade + OpenAI translator | 62 of 63 | 49 | 58.0 | 33.9% | 2 of 10 | none |
| Cascade + Claude translator | 56 of 57 | 48 | 59.1 | 36.0% | 1 of 10 | omission 3, wrong language 2 |
| Realtime | 27 of 29 | 13 | 70.9 | n/a | 0 of 2 | length ratio 1 |
| Realtime translate | 70 of 71 | 64 | 69.4 | n/a | 11 of 15 | length ratio 7, wrong language 1 |

**Cascade loses the ends of sentences in this replay, and that, not translation, drives its scores**
("Do you accept" for "Do you accept credit cards?"). The marks point at the replay harness, not
the pipeline: it started the next clip once the interpreter had been idle for 600 ms, so 12 of 56
(Claude translator) and 14 of 62 (OpenAI) turns ended at or before the previous turn's first
interpreter audio, and the half-duplex mic gate then cut the clip. A replay fix is in progress and
a re-run would change these numbers (appendix C). The Vietnamese onboarding run, with longer pauses, scored chrF 90.8 on the 8 of 13 translated lines the
matcher could pair, against references no Vietnamese speaker has checked, latency withheld because it
ran on Deepgram STT (`eval/results/onboarding-vi.md`, "Summary of the two logs"). Realtime's 13
matched lines are merged turns the matcher can't split. **This table is not a ranking** until there
is recorded speech, checked references and Paawan's own rubric, scored with the mode hidden.

## 4. Cost per minute

| Mode | Billing unit | Price | Per minute |
|---|---|---|---|
| Cascade | STT minutes + translator tokens + TTS characters | Claude translator $0.10 / $0.50 per M tokens in/out (checked 2026-10-14); STT and TTS **[VERIFY]** | not computed |
| Realtime | audio and text tokens in and out (cached input at the cached rate) + input transcription, billed separately | **[VERIFY]** | not computed |
| Realtime translate | session minutes | $0.034/min per the project guardrails **[VERIFY]** | $0.034 if confirmed |

OpenAI's and ElevenLabs' pricing pages could not be reached from the cloud container, and
`config/prices.json` never estimates, so these stay blank. Once Paawan fills the prices (including
`cachedInputPerMTok`, null today on both realtime entries), re-run
`python3 eval/summarize.py eval/results/logs/2026-10-15-*-replay-*.json` and the cost column fills
from the token, character and minute counts already in the logs; unpriced components stay listed.
Realtime's cached input tokens are priced at the cached rate (one cached count covers text and
audio, so it is taken off text input first, then audio), and its separately billed input
transcription is not captured in these logs. The cascade logs carry no STT minutes (the browser
emitted them only on End), so a cascade cost per minute needs a re-export or
`--stt-minutes-from-session`, an explicitly labelled upper bound that charges the whole session at
the STT per-minute price. Cascade costs three vendors; the Realtime modes cost one.

## 5. Controllability and compliance

**Prompt injection.** All speech is untrusted input to an instructed model. Realtime translate is
structurally the safest: no instructions and no tools, so "ignore your instructions" can only be
translated. Realtime (`gpt-realtime-2.1`) relies on its instructions and has no tools; cascade's
translator gets the transcript as delimited data with no tools. Every output line in every mode is
run through deterministic checks (target language, length ratio, assistant phrasing, refusal,
prompt-leak canary). The red-team suite (`eval/adversarial/`) ran in all four configurations on
synthetic voices (the two speaker-echo lines need a real room and were not run). Rates come from a
shuffled sheet on which the mode was hidden, each output judged against the line's intended
(faithful) rendering, not against what the app heard. Claude drafted 154 of the 158 labels from
Paawan's first four; Paawan reviewed the drafted sheet and approved it: one labeller, no second rater
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

No mode answered a question addressed to it. Cascade's weakness is not obedience but loss: its
sentence-tail loss (section 3) shows up as omitted or mangled lines (examples in appendix D). These
are subjective counts from synthetic voices and one labeller, with small n (Realtime merged clips
into 17 turns): failure shapes, not benchmark rates.

**Lock-in and observability.** Cascade spreads the session over three vendors, but each stage is a
config entry behind one interface: the STT swap (Deepgram to OpenAI transcription) and the translator
swap (OpenAI to Claude) were config-only, and every stage reports its own marks, so a slow or failing
vendor is visible per stage. Realtime and Realtime translate are one vendor each: the model's time is
opaque, no stage can be swapped, and leaving the vendor means a new transport, not a setting.

**Data flows.**

| Vendor | Used in | Default retention | Zero retention | BAA |
|---|---|---|---|---|
| OpenAI | Realtime, Realtime translate, cascade STT | abuse logs up to 30 days **[VERIFY]** | by approval **[VERIFY]** | realtime/audio only with Healthcare Addendum and Modified Retention **[VERIFY]** |
| Anthropic | cascade translator | **[VERIFY]** | **[VERIFY]** | **[VERIFY]** |
| ElevenLabs | cascade TTS | **[VERIFY]** | enterprise only **[VERIFY]** | **[VERIFY]** |
| Deepgram (adapter only) | cascade STT | **[VERIFY]**; `mip_opt_out=true` sent | **[VERIFY]** | **[VERIFY]** |

No BAA or zero-retention terms are in place for this project, and it is not HIPAA-compliant.
Cascade sends the conversation to three vendors at once, so a covered deployment needs three
agreements instead of one. No audio is stored; transcripts are discarded at End unless exported.

## 6. Recommendation by scenario **[REPHRASE]**

| Scenario | Recommendation | Why |
|---|---|---|
| Consumer and low-stakes (travel, retail, customer service) | Realtime translate where the pair is supported, else Realtime | Lowest structural injection risk, one vendor, simplest billing. Latency comparable on synthetic audio. |
| Pairs Realtime translate does not support, or a needed glossary/tone: the cost of onboarding | Cascade | Any language the STT/TTS support is a config entry: Vietnamese took about 5 minutes of configuration and about 50 lines of eval tooling, 0 application-code lines, timed by the agent (`eval/results/onboarding-vi.md`); glossary and register are controllable. |
| The same pairs: quality on the new pair | Cascade for low-stakes use only; a human interpreter, or a human relay, in regulated settings | Unverified: no Vietnamese speaker has checked the notices, word lists or references, and AI quality is expected to be lowest on rare pairs. Cheap onboarding says nothing about fidelity. |
| Medical and legal | A qualified human interpreter; AI only with a human reviewing it | AI here is not a "qualified interpreter" under ACA Section 1557 (45 CFR 92.4 and 92.201(c)) **[VERIFY]**, and the project guardrails read California AB 1242 as excluding unreviewed AI **[VERIFY: CA AB 1242]**; court and deposition work needs certified interpreters **[VERIFY: cite the federal (28 U.S.C. §1827) and state rule]**. Latency and cost are secondary. |

## 7. What this does not show

- No recorded human speech; the red-team labels come from synthetic TTS voices and one labeller
  (154 of 158 drafted by Claude, approved by Paawan), no second rater.
- All Realtime numbers are for `gpt-realtime-2.1`; the brief's `gpt-realtime` was never measured.
- No Deepgram numbers; one Realtime translate start-lag sample; no run reached 50 latency samples.
- No prices for STT, TTS or OpenAI models, so no cost per minute.
- Heap grew more than 10% from minute 1 in every mode but Realtime translate; cascade dropped
  22–26 s of late interpreter audio per 5-minute replay to stay in sync.
- Cascade's sentence-tail loss under replay (section 3) is most likely the replay's turn-taking;
  the cascade quality and omission numbers wait on a re-run with the fixed replay.
