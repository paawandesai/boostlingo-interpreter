# Realtime vs cascade interpretation: comparison write-up (DRAFT)

> **Draft for Paawan.** Every number below comes from a file under `eval/results/`. Lines marked
> **[VERIFY]** need Paawan to check a vendor page, a legal citation or a figure before submission;
> lines marked **[REPHRASE]** are opinions Paawan should restate in their own words. The blind human
> scoring and the recorded replay set (T4.2) have not run yet, so every quality number here is a
> synthetic-audio signal, not a finding.

## 1. Setup and method

- **Three modes, one UI.** *Cascade*: streaming STT → LLM translator → streaming TTS on our server.
  *Realtime*: `gpt-realtime-2.1` speech-to-speech over WebRTC, instructed only to interpret, no tools.
  *Realtime translate*: `gpt-realtime-translate`, a dedicated streaming translation model that takes
  only a target language. The brief's `gpt-realtime` is deprecated (removal 2027-01-20 **[VERIFY]**);
  it stays selectable but is not the default.
- **Audio.** 65 synthetic TTS clips of scripted English ↔ Spanish dialogue, looped for 5 minutes in
  headless Chromium (fake mic), on the CI runner and in the cloud container. No real speech, no real
  calls. Recorded human speech is T4.2 and not done.
- **Latency** is measured in the browser from the client VAD's speech end to the first audible
  output frame, with per-stage marks. Realtime translate talks while the speaker is still talking, so
  it uses a *text lag* (first source text → first translated text) instead.
- **Quality.** WER on cascade STT only (the Realtime source column is a separate transcript). chrF
  of each translation against the script's reference. References were written by a model and are
  unverified **[VERIFY: Paawan checks references, then scores blind]**.
- **Deepgram.** Its terms bar benchmarking without written consent, and none has arrived, so every
  number for Cascade uses OpenAI transcription. Deepgram is a swappable adapter with no numbers here.

## 2. Latency (client ms, 5-minute synthetic soaks)

| Mode | What is measured | n | p50 | p95 | Source |
|---|---|---|---|---|---|
| Cascade (OpenAI STT) | speech end → first audio | 47 | 2268 | 5178 | `soak-2026-10-14-cascade-synthetic.json` |
| Realtime (`gpt-realtime-2.1`) | speech end → first audio | 19 | 1825 | 3029 | `soak-2026-10-14-realtime-synthetic.json` |
| Realtime translate | source text → translated text | 74 | 1465 | 5456 | `soak-2026-10-14-translate-synthetic.json` |

Where the time goes in Cascade (p50/p95): endpointing 713/3874, STT final 1173/4271, translation
first token 477/950, TTS first byte 308/546. STT finalisation dominates; translation and TTS are
under a second together. In Realtime, endpointing is 722/1382 and the model's own time (opaque, not
decomposable) is 751/1130.

The modes' numbers are not the same quantity. Realtime translate starts speaking before the speaker
stops, so "speech end → first audio" is often negative for it; its text lag says how far it trails,
not how long a listener waits. Its start lag (speech start → first audio) was added after this soak
and has no numbers yet.

## 3. Quality (synthetic audio, model-written references)

| Mode | Lines interpreted | chrF | STT WER | Glossary hits | Output-check flags |
|---|---|---|---|---|---|
| Cascade (vi ↔ en onboarding run) | 13 of 14 | 90.8 | withheld (Deepgram) | – | none |
| Realtime | 28 of 29 | 70.5 | n/a | – | none |
| Realtime translate | 73 of 74 | 72.5 | n/a | 8 of 14 | length ratio 3 |

From `eval/results/summary.md`. The Cascade row is the Vietnamese onboarding run, not the English ↔
Spanish soak, so it is not comparable with the other two rows; the English ↔ Spanish cascade soak
predates the session-log export and has no chrF. **This table is not a ranking.** It needs T4.2: the
recorded replay set through every mode, checked references and Paawan's blind rubric.

Realtime merged short clips into longer turns (29 turns from 65 clips), so it misses the 50-turn
criterion; Realtime translate split them into 74 lines. Realtime translate's 6 missed glossary terms
and 3 length-ratio flags are the places to listen to first.

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
prompt-leak canary). The red-team suite (`eval/adversarial/`) is written but **not yet run**; its
rates per mode (answer-instead-of-translate, instruction followed, omission, refusal, wrong
language) are T4.2.

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

- No recorded human speech, no blind scoring, no red-team rates (T4.2).
- No numbers for Deepgram; no Realtime translate start lag; the current translate line-cutting
  (after commit 95256a4) has not been soaked.
- No prices for STT, TTS or OpenAI models, so no cost per minute.
- Heap grew 14–15% from minute 1 in all three modes (criterion < 10%).
