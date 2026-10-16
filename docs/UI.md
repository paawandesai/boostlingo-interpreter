# UI spec (T0.3)

> **Status: Day 1 design spec, kept as written.** Sections 1–4 are the research, flows, states and component plan from T0.3 (2026-10-14). The app was built to the v2 design and deviates from this page in several places; the "As built" section at the end lists the real components under `web/src/components/` and the differences. Where they disagree, the code and [ARCHITECTURE.md](ARCHITECTURE.md) describe what exists.

**Design:** [Interpreter Workbench UI v2](https://claude.ai/artifact/QXMtSYuAfM3QhBQfatd7W4) (Claude Design canvas, 2026-10-15: A setup, B live session, C failure states, B at phone width), built from the prompt in the project notes. It adds Realtime translate, the consent step and the human handoff. The Day 1 canvas is [Interpreter Workbench UI](https://claude.ai/artifact/DNKbvX67vqPjUKU6XWfZ5P). Both are private until I share them.

T1.4, T1.6, T2.6, T3.2 and T3.4 build to this page. Scope is three screens only: no animations, theming or design system. The brief scores function, not polish. Typeface in the design is IBM Plex Sans / Plex Mono; the app may fall back to `system-ui` and `ui-monospace`.

Deviations from the research below, decided in the design:
- Mic denied offers **Try again** plus **Use replay file** (one primary action, one fallback).
- Speaker side is never "Auto" in v1 (D10); the flow step mentioning Auto applies only to the later auto-detect experiment.
- Language pair is locked once a session starts; the mode is not.

Audience: engineers comparing **Realtime (voice-to-voice)** and **Cascade (STT -> MT -> TTS)** for Boostlingo. The brief scores function, not polish, so every pattern below has to help someone **measure, compare or recover**.

## 1. Reference patterns

| # | Pattern | Where seen | Adopt/Skip | Why |
|---|---|---|---|---|
| 1 | Two-pane conversation, one pane per speaker/language | Google Translate conversation, Apple Translate Side-by-Side | **Adopt** as two columns (Source, Target) | Puts source and translation side by side, so they can be checked against each other. |
| 2 | Face-to-face (top pane rotated 180°) | Google Translate, Apple Translate Face to Face | Skip | Made for one phone on a table. Our users sit at a laptop. |
| 3 | Explicit "who is speaking" mic buttons, one per side | Google Translate manual mode, Apple (tap mic per side) | **Adopt** as a speaker-side toggle (A=EN / B=ES) | Removes the uncertainty of language detection, so latency numbers stay comparable. |
| 4 | Auto language detect / auto-translate | Google Translate v8 auto mode, Apple "Detect Language" | Skip (v1) | Adds a variable we aren't measuring. Could be a later toggle. |
| 5 | Partial (greyed) text that firms up to final | Microsoft Translator live transcript, Wordly captions | **Adopt** | The partial-to-final step is the STT-final milestone in the waterfall. Show partials in italic/muted and finals in solid text. |
| 6 | Shared, saveable transcript | Microsoft Translator multi-device ("save for later") | **Adopt** as Export JSON | Engineers need raw per-utterance timings to analyse offline. |
| 7 | Join by code/QR, multi-device, 100 participants | Microsoft Translator, Wordly | Skip | Single-operator workbench. Out of scope. |
| 8 | Language selector changeable mid-session without a new feed | Wordly attendee view | **Adopt** the principle for the mode toggle | A mid-session switch should keep both transcripts and show a visible "switching" state. Language pair stays locked in-session. |
| 9 | Translated audio on/off (captions vs listen) | Wordly (unmute for audio), Boostlingo Zoom AI Pro captions | **Adopt** a mute toggle for the output audio | Lets you check whether playback is the bottleneck. Timings are still recorded while muted. |
| 10 | Hardware-console metaphor: in/out channel, relay, "channel busy" light | KUDO / Interprefy interpreter soft console | Partial: adopt the status lamp only | A single coloured state lamp (listening / translating / playing / error) reads at a glance. Relay and handover are skipped. |
| 11 | Escalate to human interpreter | Boostlingo AI Interpreter (phone workflow handoff) | Skip, but leave a disabled slot | This is Boostlingo's real product seam. Showing it signals awareness without building it. |
| 12 | Per-request stacked timing bar (Queueing, Waiting/TTFB, Download) | Chrome DevTools Network waterfall | **Adopt** as the core latency view | Engineers already read this layout. One row per utterance, one segment per stage, hover/focus for ms values. |
| 13 | Time-ordered request table with sortable columns | Chrome DevTools Network panel | **Adopt** (lite) | Utterance list sorted by time, with columns for total, mode and status. Lets you filter to errors. |
| 14 | Renamed or hatched segments when the source is ambiguous ("Waiting for server response", formerly "Waiting (TTFB)") | Chrome DevTools | **Adopt** | Label Realtime's model-internal span **"opaque"** (hatched), not as a measured stage. |
| 15 | Inline, recoverable error banners | Common to all (Translator session-expiry notice "recreate a new conversation") | **Adopt** | Each failure gets a banner in the live screen with one primary recovery action. No modal dead ends. |

## 2. User flow walkthrough

1. **Setup (state `idle`, screen A).** Choose:
   - Mode: Realtime or Cascade (segmented control).
   - Language pair: EN<->ES (select; the order sets side A/B).
   - Starting speaker side: A or B.
   - Input: Mic, or Replay with a file picker for wav/mp3 plus a "loop" checkbox.

   **Start** is disabled until the input is valid. Mic permission is requested here, when Start is pressed, not on page load.
2. **Start -> `connecting`.** Start becomes **Cancel**. The status lamp turns amber and shows "Connecting (WebRTC / STT socket)". If no connection is made within 10 s, go to `error:timeout`.
3. **`listening`.** The lamp turns green. A level meter shows mic or replay input. The speaker toggle, mode toggle, mute and End controls are all enabled.
4. **Speak -> `speaking/translating`.** A Source-column partial streams in italic and muted. When VAD fires, the endpointing tick is recorded. The STT final turns the text solid (Cascade), or the `response.created` tick is recorded (Realtime). Target-column text streams in (MT tokens, or the Realtime transcript delta).
5. **Translated audio -> `playing`.** The first flush or first audio chunk is played and the playback-start tick is recorded. The utterance row turns into a finished waterfall bar. If the side is set to Auto, the speaker toggle flips sides automatically. Otherwise the user presses `Space` or clicks to switch.
6. **Latency panel (always visible).**
   - Each utterance gets a stacked bar.
   - Cascade stages: endpointing -> STT final -> MT TTFT -> first flush -> TTS TTFB -> playback.
   - Realtime stages: endpointing -> response.created -> [opaque model-internal, hatched] -> first audio -> playback.
   - A header shows running **p50 / p95** for total time to first audio, broken out by mode. It also shows the n count.
   - The **cost meter slot** shows "$ — / min" until it is wired up (placeholder text, marked as an estimate).
7. **Mid-session toggle -> `switching`.**
   - Flipping the mode drains or cancels any in-flight utterance and marks it `aborted:switch`.
   - It tears down the old pipeline and brings up the new one.
   - Transcripts and stats are kept, and each row is tagged with its mode.
   - A divider line in both columns reads "Switched to Cascade at 00:42".
   - The state returns to `listening`.
8. **Failure states** (banner in screen B with one primary recovery):
   - `error:rate_limited` (429): "Rate limited, retrying in Ns". Shows a countdown using Retry-After or exponential backoff, plus a **Retry now** button. The utterance is kept and re-sent.
   - `error:timeout`: a stage went past its budget (e.g. STT final > 5 s). The stalled segment turns red. Actions: **Retry utterance** and **Skip**.
   - `error:empty_transcript`: "No speech recognised". The row is greyed out. Actions: **Dismiss**, with a hint to check the input level. The session stays listening.
   - `error:tts_failed` (mid-stream): the translated text is kept and audio stops. Actions: **Replay audio** (re-synthesise) and **Show text only**.
   - `error:mic_denied`: input is blocked. Actions: **How to allow** (browser instructions) and **Use replay file instead** (switches the input to Replay).
   - `error:webrtc_dropped`: the lamp turns red. It auto-reconnects up to 3 times with backoff, then offers **Reconnect** and **Switch to Cascade**. The transcript is preserved.
9. **End -> `ended`.** Audio stops and the connections close. The summary strip shows utterance count, p50/p95 per mode, error count and estimated cost.
10. **Export.** **Download session.json** contains config, utterances[] (text, mode, side, per-stage timestamps in ms relative to t0, status/error), aggregates and an app version. A **New session** button resets to `idle` with the previous settings kept.

## 3. Screens and states

**(A) Pre-session setup** is a single card with Mode, Language pair, Speaker side, Input source (Mic | Replay plus file), and Start.

**(B) Live session** contains:
- Top bar: mode toggle, status lamp, mute, End.
- Main area: Source | Target transcript columns, each with an `aria-live="polite"` region.
- Speaker-side toggle between the columns.
- Bottom panel: latency waterfall list, StatsBar (p50/p95, n) and the CostMeter slot.

**(C) Failure variants of B** keep the same layout and add an ErrorBanner above the columns. The failing row or segment is marked red with an icon and text, never colour alone. A per-kind recovery button gets focus when the banner appears.

| Control \ State | idle | connecting | listening | speaking/translating | playing | switching | error:\<kind\> | ended |
|---|---|---|---|---|---|---|---|---|
| Start / Cancel / End | Start (if valid) | Cancel -> idle | End | End (aborts utterance) | End | disabled | End | New session |
| Mode toggle | sets mode | disabled | switch -> switching | switch (aborts current) | switch (after audio cut) | disabled (shows spinner) | enabled (switching is a recovery) | disabled |
| Lang pair / Input | editable | locked | locked | locked | locked | locked | Input editable only for mic_denied | locked |
| Speaker toggle | sets first side | disabled | flips side | queued for next utterance | flips (stops playback if Barge-in on) | disabled | disabled | disabled |
| Mute output | n/a | enabled | enabled | enabled | enabled (stops sound, keeps timing) | enabled | enabled | disabled |
| Recovery button | n/a | n/a | n/a | n/a | n/a | n/a | per kind (see §2.8) | n/a |
| Export JSON | disabled | disabled | enabled (partial log) | enabled | enabled | enabled | enabled | **primary** |

## 4. Components (`web/src/components/`)

| File | Role |
|---|---|
| `App.tsx` | Session state machine (reducer), screen routing |
| `SetupScreen.tsx` | Screen A |
| `ModeToggle.tsx` | `role="radiogroup"`, arrow keys switch Realtime/Cascade |
| `LanguagePairSelect.tsx` | Native `<select>` EN->ES / ES->EN |
| `SpeakerSideToggle.tsx` | `aria-pressed` button pair; `Space` hotkey when focus is not in an input |
| `InputSourcePicker.tsx` | Mic / Replay radio plus file input |
| `LiveSession.tsx` | Screen B/C layout |
| `StatusLamp.tsx` | State dot plus text label, `role="status"` |
| `TranscriptColumn.tsx` | `aria-live="polite"`, `aria-relevant="additions"`; only finals are announced (partials are `aria-hidden`, so they aren't read repeatedly) |
| `UtteranceRow.tsx` | One utterance: text excerpt, mode tag, status |
| `LatencyWaterfall.tsx` | List of `WaterfallBar`s plus a stage legend |
| `WaterfallBar.tsx` | Stacked segments; each is focusable with `aria-label="TTS TTFB 182 ms"`; opaque segment hatched |
| `StatsBar.tsx` | p50/p95/n per mode |
| `CostMeter.tsx` | Placeholder slot, "estimate" label |
| `ErrorBanner.tsx` | `role="alert"`, message plus primary/secondary recovery buttons, retry countdown |
| `LevelMeter.tsx` | Input level, so an empty-transcript failure can be diagnosed |
| `ExportButton.tsx` | Builds and downloads `session-<iso>.json` |

### Design tokens

```css
:root {
  /* colour, light. Text contrast >= 4.5:1, segment fills >= 3:1 against --surface */
  --bg: #ffffff; --surface: #f5f6f8; --border: #d0d4da;
  --text: #16181d; --text-muted: #5b6270; --accent: #1d4ed8; --focus: #1d4ed8;
  --ok: #15803d; --warn: #b45309; --err: #b91c1c;
  --seg-endpoint: #6b7280; --seg-stt: #2563eb; --seg-mt: #7c3aed;
  --seg-flush: #0891b2; --seg-tts: #c2410c; --seg-play: #15803d; --seg-opaque: #9ca3af; /* hatched */
  /* type */
  --font-ui: system-ui, sans-serif; --font-mono: ui-monospace, monospace;
  --fs-xs: 12px; --fs-sm: 14px; --fs-md: 16px; --fs-lg: 20px; --fs-xl: 24px; --lh: 1.5;
  /* spacing (4px base) */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px; --sp-8: 32px;
  --radius: 6px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1115; --surface: #181b21; --border: #2e333c;
  --text: #e6e8eb; --text-muted: #9aa1ad; --accent: #7aa2ff; --focus: #7aa2ff;
  --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
  --seg-endpoint: #9ca3af; --seg-stt: #60a5fa; --seg-mt: #a78bfa;
  --seg-flush: #22d3ee; --seg-tts: #fb923c; --seg-play: #4ade80; --seg-opaque: #6b7280;
}}
:root[data-theme="dark"] { /* same values as the dark block above */ }
```

Accessibility rules:
- Visible `:focus-visible` outline (2px `--focus`) on every control.
- Every toggle can be reached with Tab and operated with Space/Enter or arrow keys.
- States always pair colour with a text label.
- Numbers use `--font-mono` with tabular-nums.
- Respect `prefers-reduced-motion` (no animated bar growth).


## As built (2026-10-15)

Real files under `web/src/components/` (the session state machine is `web/src/App.tsx` with `web/src/session/store.ts` and `useSession.ts`, not a component):

| File | Role |
|---|---|
| `SetupPanel.tsx` | Screen A: mode (three-way `ModeToggle` with a one-line description per mode), language pair, who speaks first, Realtime model select (`gpt-realtime-2.1` default, `gpt-realtime`), glossary toggle, replay files (loop) or mic, access token, consent step (`ConsentNotice`), Start |
| `ModeToggle.tsx` | `role="radiogroup"`: Realtime translate / Realtime / Cascade; translate is disabled when the pair is not supported |
| `ConsentNotice.tsx` | AI-use notice in both languages with the vendors the chosen mode sends audio to; Start stays disabled until "Both parties were told and agree" is ticked; the notice is read aloud before the mic opens (G7) |
| `AiBanner.tsx` | Persistent "AI interpretation, not a qualified human interpreter" banner |
| `BackendStatus.tsx` | `/health` round trip: backend version and which keys are not set on the server |
| `LiveSession.tsx` | Screen B/C: top bar (mode toggle, status lamp with text, pair, **Export log**, **Request human interpreter**, End with an "export first?" confirmation), Source / Target columns, speaker-side toggle, input level meter, `LatencyPanel`, `ErrorBanner` |
| `SpeakerSideToggle.tsx` | `aria-pressed` button pair |
| `TranscriptColumn.tsx` | `aria-live="polite"` column, last 40 lines rendered (the rest stay in the store and the export); Realtime source lines are labelled "approximate (separate ASR), confidence unknown"; low-confidence cascade lines are flagged; a refusal shows "[segment not interpreted — model declined]"; flagged lines offer the handoff |
| `LatencyPanel.tsx` | Per-utterance stacked bars (latest 20), the hatched opaque segment, running p50/p95 and n per mode, the VAD threshold note |
| `ErrorBanner.tsx` | `role="alert"`: one title and one recovery action per error kind, including mic denied ("Try again" with browser instructions) and WebRTC drop ("Reconnect") |
| `AudioCheck.tsx` | Day 1 audio check (mic level, VAD marks, test tone through the scheduler with mic gating); superseded by the live screen |

Deviations from sections 2–4 above:
- **Three modes, not two.** Realtime translate (`gpt-realtime-translate`, G17) is the third option and the default for EN↔ES; the mode toggle is three-way and describes each mode.
- **Consent step before Start** (G7): notice in both languages, vendor list per mode, a checkbox that gates Start, a spoken notice. Not in the Day 1 flow.
- **Human handoff is a button, not a disabled slot:** "Request human interpreter" ends the AI session and inserts a marker; this demo has no interpreter queue behind it.
- **No mute toggle and no cost meter.** The output-audio mute (pattern 9, §3 table) and the `CostMeter` slot were not built; cost is computed in the session log export from usage and `config/prices.json` instead (null prices show as unpriced). The status text shows when the mic is gated ("Interpreter speaking (mic muted)").
- **Export is "Export log"** in the top bar, not "Download session.json"; End asks to export first because transcripts are discarded at End (G20).
- **`LatencyPanel` replaces `LatencyWaterfall`, `WaterfallBar` and `StatsBar`;** the bars are not individually focusable. `StatusLamp` is a span inside `LiveSession`. `LanguagePairSelect`, `InputSourcePicker` and `LevelMeter` are inline inside `SetupPanel` and `LiveSession` (`<meter>` elements), and `ExportButton`, `UtteranceRow` and `SetupScreen` do not exist as files.
- **Error states:** the banner has one action per kind and, for a rate limit, a static "retry after N s" note from `Retry-After` rather than the §2.8 countdown; the "Retry utterance / Skip" and "Replay audio / Show text only" pairs were not built. A retry in progress and dropped late audio are notices, not errors. Mic denied offers "Try again"; replay as the fallback is chosen on the setup screen, not from the banner.
- **Extra controls** not in the design: Realtime model select, glossary toggle, access token field, replay-file loop.
- **Speaker side** is explicit only (D10); the mode switch marker says the new mode got the last 6 turns as context, or none for Realtime translate (G9).
- Design tokens: `web/src/index.css` carries the token names and colours from the block above, with IBM Plex Sans / Plex Mono ahead of the `system-ui` / `ui-monospace` fallbacks (v2 canvas).

## Sources
- Google Translate: https://9to5google.com/2024/02/01/google-translate-conversation-redesign/ · https://www.tomsguide.com/computing/mobile-apps/i-wish-id-known-about-these-google-translate-features-before-i-went-on-vacation · https://www.neowin.net/news/google-translate-adds-dual-screen-conversation-mode-for-foldables/
- Microsoft Translator: https://www.microsoft.com/en-us/translator/business/live/ · https://microsoft.com/translator/help/live-feature
- Apple Translate: https://www.techrepublic.com/article/how-to-use-apples-translate-app-to-translate-a-real-time-conversation/ · https://apps.apple.com/app/translate/id1514844618
- Boostlingo: https://www.boostlingo.com/ · https://boostlingo.com/?p=20810 (AI Interpreter in phone workflows, human handoff) · https://boostlingo.com/?p=19704 (Zoom AI Pro captions)
- Wordly: https://www.wordly.ai/attendee-faq · https://www.wordly.ai/live-captioning
- KUDO / Interprefy: https://fao.org/fileadmin/user_upload/reu/europe/documents/events2021/KUDO-Interfaces.pdf · https://gotranscript.com/public/in-depth-guide-to-kudo-navigating-interpreter-controls-and-features · https://knowledge.interprefy.com/how-to-set-up-language-channels-on-the-interpreters-soft-console
- Chrome DevTools waterfall: https://developer.chrome.com/docs/devtools/network/reference/#timing-explanation · https://debugbear.com/docs/metrics/time-to-first-byte · https://blog.openreplay.com/learn-chrome-network-tab/

Note: no public screenshots or layout descriptions of Boostlingo's AI Interpreter screen turned up. The Boostlingo rows are based on press releases and integration pages only.
