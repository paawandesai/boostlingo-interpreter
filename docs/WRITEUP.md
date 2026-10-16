# Realtime vs cascade interpretation: comparison write-up

> Every number comes from a file under `eval/results/`. **[VERIFY]** and **[REPHRASE]** markers await
> Paawan: a vendor page, citation or figure to check, or an opinion to restate in their own words.
> Vendor prices, data terms and legal citations were read on the official pages on 2026-10-16 (the
> Claude Haiku price on 2026-10-14).
> Method detail and longer analyses: [WRITEUP-APPENDIX.md](WRITEUP-APPENDIX.md).

## 1. Setup

Three modes behind one UI: *Cascade* (streaming STT → LLM translator → streaming TTS on our server),
*Realtime* (`gpt-realtime-2.1` speech-to-speech over WebRTC, instructed only to interpret, no tools)
and *Realtime translate* (`gpt-realtime-translate`, which takes only a target language). The brief's `gpt-realtime` is deprecated (removal 2027-01-20 per OpenAI's deprecations page); it is selectable
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
interpreter audio, and the half-duplex mic gate then cut the clip. With the replay fixed to wait for
each interpretation (MR !33), one cascade re-run on 2026-10-16 (OpenAI STT and translator, 37 turns,
`eval/results/logs/2026-10-16-cascade-replay-openai-turntaking-synthetic.json`) gave STT WER 4.0%
(was 33.9%), chrF 82.5 (was 58.0), 36 of 37 lines matched and 3 of 8 glossary terms, at total
p50/p95 2540/4170 ms (was 2440/4097). The table above keeps the 2026-10-15 set because only this one
configuration was re-run; the other modes wait on OpenAI credit (appendix C). The Vietnamese onboarding run, with longer pauses, scored chrF 90.8 on the 8 of 13 translated lines the
matcher could pair, against references no Vietnamese speaker has checked, latency withheld because it
ran on Deepgram STT (`eval/results/onboarding-vi.md`, "Summary of the two logs"). Realtime's 13
matched lines are merged turns the matcher can't split. **This table is not a ranking** until there
is recorded speech, checked references and Paawan's own rubric, scored with the mode hidden.

## 4. Cost per minute

| Mode | Billing unit | Price | Per minute |
|---|---|---|---|
| Cascade | STT minutes + translator tokens + TTS characters | Translator per M tokens in/out: Claude Haiku $0.10 / $0.50, `gpt-5.4-mini` $0.75 / $4.50; OpenAI STT about $0.006/min (OpenAI's estimate); ElevenLabs Flash $0.04 per 1,000 characters; Deepgram Nova-3 streaming $0.0077/min list ($0.0048 under a current promotion) | Claude $0.0149–0.0209; OpenAI translator $0.0193–0.0253 |
| Realtime | audio and text tokens in and out (cached input at the cached rate) + input transcription, billed separately | `gpt-realtime-2.1` per M tokens: audio $32 in / $64 out, text $4 in / $24 out, cached input $0.40 | $0.2023 plus input transcription |
| Realtime translate | minutes of audio | $0.034/min | $0.034 |

Costs are `eval/summarize.py` on the four 2026-10-15 replay logs, priced from `config/prices.json`
(`eval/results/summary.md`). Neither range is complete. The cascade logs carry no STT minutes (the
browser emitted them only on End), so the low end leaves STT out and the high end
(`--stt-minutes-from-session --out /tmp/summary-stt-upper.md`, so the committed summary is not
overwritten) charges STT for the whole session, an upper bound. Realtime's
separately billed input transcription (`gpt-4o-mini-transcribe`) is not in the logs and has no
price entry, so its figure is a floor; its cached input tokens are priced at the cached rate (one
cached count covers text and audio, so it is taken off text input first, then audio). On these
runs Realtime costs about ten times either cascade, and Realtime translate about twice. Cascade
bills up to three vendors (two in the BAA profile); the Realtime modes bill one.

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

**Lock-in and observability.** Cascade spreads the session over up to three vendors (two in the BAA profile), but each stage is a
config entry behind one interface: the STT swap (Deepgram to OpenAI transcription) and the translator
swap (OpenAI to Claude) were config-only, and every stage reports its own marks, so a slow or failing
vendor is visible per stage. Realtime and Realtime translate are one vendor each: the model's time is
opaque, no stage can be swapped, and leaving the vendor means a new transport, not a setting.
Model lifecycle is part of the same risk: the brief's `gpt-realtime` is already deprecated, and the
cascade's OpenAI STT fallback (`gpt-4o-transcribe`) is listed for shutdown on 2027-02-26. Both are
config entries here, but a replacement must be re-tested and re-measured before it is trusted.

**Data flows.**

| Vendor | Used in | Default retention | Zero retention | BAA |
|---|---|---|---|---|
| OpenAI | Realtime, Realtime translate, cascade STT, cascade translator (default), cascade TTS (BAA mode) | abuse-monitoring logs up to 30 days by default (30 days listed for `/v1/realtime`; none for `/v1/audio/transcriptions`); API data not used for training by default | Zero Data Retention or Modified Abuse Monitoring, by OpenAI's prior approval | `/v1/realtime` and `/v1/audio/{transcriptions,translations,speech}` are eligible with an executed BAA and Modified Retention, unless OpenAI specifies otherwise; **`/v1/realtime/translations` (Realtime translate) is not on the eligible list** |
| Anthropic | cascade translator | prompts and outputs not retained by default (Covered Models 30 days; flagged sessions up to 2 years); never used for training without permission (fetched 2026-10-16) | per organization, through Anthropic sales (fetched 2026-10-16) | available: executed in the Claude Console for HIPAA-enabled organizations, eligible API features only (fetched 2026-10-16) |
| ElevenLabs | cascade TTS (default; refused in BAA mode) | TTS text and audio kept by default (history on), no period stated; deleted items stay in backups up to 30 days; non-enterprise data used to improve models unless the account turns off "Data use" | Zero Retention Mode, select enterprise customers only | listed as an Enterprise plan feature |
| Deepgram (adapter only) | cascade STT | audio retained by default to improve models, no period stated; `mip_opt_out=true` is sent, so audio is kept only as long as needed to process the request | none published beyond the opt-out | on request for covered entities (docs); the pricing page lists it for Enterprise |

No BAA or zero-retention terms are in place for this project, and it is not HIPAA-compliant. The
code closes the routing gap instead: BAA mode (off by default, README "BAA mode") refuses any session
whose route is not on its vendor's HIPAA-eligible list or whose vendor has no declared BAA. Realtime
translate is always refused; Realtime runs; cascade runs on OpenAI speech-to-text, the Claude
translator and an OpenAI text-to-speech adapter added for this (unit-tested, not yet run live).
Cascade sends the conversation to up to three vendors at once (two in the BAA profile: OpenAI and
Anthropic), so a covered deployment needs two agreements instead of one. No audio is stored; transcripts are discarded at End unless exported.

## 6. Recommendation by scenario **[REPHRASE]**

| Scenario | Recommendation | Why |
|---|---|---|
| Consumer and low-stakes (travel, retail, customer service) | Realtime translate where the pair is supported, else Realtime | Lowest structural injection risk, one vendor, simplest billing. |
| Any setting with personal or health data that is not itself clinical or legal (scheduling, billing, intake) | Realtime, or cascade on OpenAI STT + Claude + OpenAI TTS (not yet run live; latency and cost unmeasured), with BAA mode on and each vendor's BAA and retention terms signed; never Realtime translate | Realtime translate's endpoint is not on OpenAI's HIPAA-eligible list. That cascade needs two agreements (OpenAI and Anthropic); the default ElevenLabs TTS would add a third, and ElevenLabs offers zero retention and a BAA only on Enterprise; on lower plans it keeps TTS history and may train on the text unless "Data use" is off (off for this project). |
| Pairs Realtime translate does not support, or a needed glossary/tone: the cost of onboarding | Cascade | Any language the STT/TTS support is a config entry: Vietnamese took about 5 minutes of configuration and about 50 lines of eval tooling, 0 application-code lines, timed by the agent (`eval/results/onboarding-vi.md`); glossary and register are controllable. |
| The same pairs: quality on the new pair | Cascade for low-stakes use only; a human interpreter, or a human relay, in regulated settings | Unverified: no Vietnamese speaker has checked the notices, word lists or references, and AI quality is expected to be lowest on rare pairs. Cheap onboarding says nothing about fidelity. |
| Medical and legal | A qualified human interpreter; AI only with a human reviewing it | Under ACA Section 1557, machine translation must be reviewed by a qualified human translator when the text is critical to rights, benefits or meaningful access, when accuracy is essential, or when the source is complex or technical (45 CFR 92.201(c)(3)); 92.4 defines machine translation as text-based, and spoken interpretation falls under the separate qualified-interpreter requirement in (c)(1). California AB 1242 (2025–26) is a CalHHS language-access bill, not a court or healthcare-interpreting rule; it would exclude unreviewed machine translation, but it was held in committee and may not become law. In proceedings instituted by the United States, federal courts use the most available certified interpreter, or an otherwise qualified one (28 U.S.C. §1827(d)(1)); California courts require certified or registered interpreters (Gov. Code §68561), with narrow provisional and temporary exceptions (Cal. Rules of Court 2.893). Latency and cost are secondary. |

## 7. What this does not show

- No recorded human speech; the red-team labels come from synthetic TTS voices and one labeller
  (154 of 158 drafted by Claude, approved by Paawan), no second rater.
- All Realtime numbers are for `gpt-realtime-2.1`; the brief's `gpt-realtime` was never measured.
- No Deepgram numbers; one Realtime translate start-lag sample; no run reached 50 latency samples.
- Cost per minute is a range for cascade (no STT minutes in the logs) and a floor for Realtime
  (input transcription not captured); STT is priced at OpenAI's own per-minute estimate.
- Heap grew more than 10% from minute 1 in every mode but Realtime translate; cascade dropped
  22–26 s of late interpreter audio per 5-minute replay to stay in sync.
- Cascade's sentence-tail loss under replay (section 3) was the replay's turn-taking; only one
  cascade configuration has been re-run with the fixed replay, so the quality table is still the
  2026-10-15 set.
