# Realtime vs cascade interpretation: comparison write-up (DRAFT)

> **Draft for Paawan.** Every number below comes from a file under `eval/results/`. Lines marked
> **[VERIFY]** need Paawan to check a vendor page, a legal citation or a figure before submission;
> lines marked **[REPHRASE]** are opinions Paawan should restate in their own words. The T4.2 runs
> (2026-10-15) used synthetic TTS speech, not recorded people, and the red-team labels are not in
> yet, so every quality number here is a synthetic-audio signal, not a finding.

## 1. Setup and method

- **Three modes, one UI.** *Cascade*: streaming STT → LLM translator → streaming TTS on our server.
  *Realtime*: `gpt-realtime-2.1` speech-to-speech over WebRTC, instructed only to interpret, no tools.
  *Realtime translate*: `gpt-realtime-translate`, a dedicated streaming translation model that takes
  only a target language. The brief's `gpt-realtime` is deprecated (removal 2027-01-20 **[VERIFY]**);
  it stays selectable but is not the default.
- **Audio.** 65 synthetic TTS clips of scripted English ↔ Spanish dialogue (both directions),
  looped for 5 minutes per mode in headless Chromium (fake mic): Realtime and Realtime translate on
  the CI runner, Cascade in the cloud container with each translator (OpenAI, Claude). The 28
  red-team lines were voiced the same way (background-voice lines with a second, quieter voice) and
  looped for 4 minutes per configuration. No recorded people, no real calls.
- **Latency** is measured in the browser from the client VAD's speech end to the first audible
  output frame, with per-stage marks. Realtime translate talks while the speaker is still talking, so
  it uses a *text lag* (first source text → first translated text) instead.
- **Quality.** WER on cascade STT only (the Realtime source column is a separate transcript). chrF
  of each translation against the script's reference. References were written by a model and are
  unverified **[VERIFY: Paawan checks references, then scores blind]**.
- **Deepgram.** Its terms bar benchmarking without written consent, and none has arrived, so every
  number for Cascade uses OpenAI transcription. Deepgram is a swappable adapter with no numbers here.

## 2. Latency (client ms, 5-minute synthetic replay, 2026-10-15)

| Mode | What is measured | n | p50 | p95 |
|---|---|---|---|---|
| Cascade, OpenAI STT + OpenAI translator | speech end → first audio | 46 | 2440 | 4097 |
| Cascade, OpenAI STT + Claude translator | speech end → first audio | 45 | 2521 | 5160 |
| Realtime (`gpt-realtime-2.1`) | speech end → first audio | 19 | 2251 | 3451 |
| Realtime translate | source text → translated text | 70 | 1984 | 5284 |

Sources: `eval/results/summary.md` and `eval/results/soak-2026-10-15-*.json`.

Where the time goes in Cascade with the OpenAI translator (p50/p95): endpointing 726/2056, STT final
1195/2451, translation first token 584/1038, TTS first byte 334/593. STT finalisation dominates; the
two translators differ by less than the run-to-run spread (first token 584 vs 576 at p50). In
Realtime, endpointing is 1266/1653 and the model's own time (opaque) is 910/2010.

The modes' numbers are not the same quantity. Realtime translate speaks before the speaker stops, so
its text lag says how far it trails, not how long a listener waits; start lag (speech start → first
audio) got only 1 measurement in this run because the looped clips leave few pauses. Realtime merged
clips into longer turns (29 turns from the loop), so its n is small and it misses the 50-turn soak
criterion. Heap grew 8.5–20% from minute 1 across the runs (criterion < 10%; only Realtime
translate passed).

## 3. Quality (synthetic audio, model-written references)

| Mode | Lines interpreted | Matched to a script line | chrF | STT WER | Glossary hits | Output-check flags |
|---|---|---|---|---|---|---|
| Cascade + OpenAI translator | 62 of 63 | 49 | 58.0 | 33.9% | 2 of 10 | none |
| Cascade + Claude translator | 56 of 57 | 48 | 59.1 | 36.0% | 1 of 10 | omission 3, wrong language 2 |
| Realtime | 27 of 29 | 13 | 70.9 | n/a | 0 of 2 | length ratio 1 |
| Realtime translate | 70 of 71 | 64 | 69.4 | n/a | 11 of 15 | length ratio 7, wrong language 1 |

**Cascade loses the ends of sentences in this replay, and that, not translation, drives its scores.**
Its source lines stop early ("Do you accept" for "Do you accept credit cards?", "Trabajo de lunes a
viernes." without "de ocho a cinco"). Inferred cause, not yet proven: cascade flushes a translation
at the first clause, its spoken output starts while the clip is still playing, and the half-duplex
mic gate then drops the rest of the clip. A person who stops when the interpreter starts would not
lose words this way, but one who keeps talking would. **[VERIFY with a recorded run; fix candidates:
flush only on sentence ends, or keep capturing while gated and queue the remainder.]** The Vietnamese
onboarding run, with longer pauses, scored chrF 90.8 (`eval/results/onboarding-vi.md`).

Realtime matched only 13 lines because it merges several clips into one turn, which the line matcher
can't split. **This table is not a ranking.** It needs recorded speech, checked references and
Paawan's blind rubric.

## 4. Cost per minute

| Mode | Billing unit | Price | Per minute |
|---|---|---|---|
| Cascade | STT minutes + translator tokens + TTS characters | Claude translator $0.10 / $0.50 per M tokens in/out (checked 2026-10-14); STT and TTS **[VERIFY]** | not computed |
| Realtime | audio and text tokens in and out | **[VERIFY]** | not computed |
| Realtime translate | session minutes | $0.034/min per the project guardrails **[VERIFY]** | $0.034 if confirmed |

OpenAI's and ElevenLabs' pricing pages could not be reached from the cloud container, and
`config/prices.json` never estimates, so these stay blank. Once Paawan fills the prices, re-run
`python3 eval/summarize.py eval/results/logs/*.json` and the cost column fills from the token and
character counts in the logs. Cascade costs three vendors; Realtime and Realtime translate cost one.

## 5. Controllability and compliance

**Prompt injection.** All speech is untrusted input to an instructed model. Realtime translate is
structurally the safest: it takes no instructions and has no tools, so "ignore your instructions"
can only be translated. Realtime (`gpt-realtime-2.1`) relies on its instructions and has no tools.
Cascade's translator gets the transcript as delimited data with no tools. Every output line in every
mode passes deterministic checks (target language, length ratio, assistant phrasing, refusal,
prompt-leak canary). The red-team suite (`eval/adversarial/`) ran in all four configurations
(synthetic voices; the two speaker-echo lines need a real room and were not run). Its rates per mode
(answer-instead-of-translate, instruction followed, omission, refusal, wrong language) wait on
Paawan's labels in a blind, shuffled sheet. **[TODO: paste `score.py rates` output here.]**

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
| Pairs Realtime translate does not support, or a needed glossary/tone | Cascade | Any language the STT/TTS support is a config entry (Vietnamese took about 5 minutes, 0 lines of code, `eval/results/onboarding-vi.md`); glossary and register are controllable. |
| Medical and legal | A qualified human interpreter; AI only with a human reviewing it | AI here is not a "qualified interpreter" under ACA Section 1557 (45 CFR 92.4 and 92.201(c)) **[VERIFY]**; court and deposition work needs certified interpreters **[VERIFY: CA AB 1242]**. Latency and cost are secondary. |

## 7. What this does not show

- No recorded human speech and no blind scoring; red-team rates wait on labels.
- No numbers for Deepgram; one Realtime translate start-lag sample.
- No prices for STT, TTS or OpenAI models, so no cost per minute.
- Heap grew more than 10% from minute 1 in every mode but Realtime translate (criterion < 10%).
- Cascade's sentence-tail loss under replay (section 3) is unexplained until a recorded run.
