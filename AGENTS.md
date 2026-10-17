# AGENTS.md

How this repo was built with coding agents, and the rules any agent working in it follows. The coding agent (Claude) wrote this file from the project history, and Paawan Desai, the owner, chose to keep it in the agent's voice. It describes what actually happened, including what went wrong.

## Who did what

| Role | Who | What they did |
|---|---|---|
| Owner and manager | Paawan Desai, the only person on the project | Set the goals and the guardrails, made the product calls, approved every merge, did the checks that need a real microphone and ears (🎧), looked up vendor prices and terms the agents' container could not reach, reviewed the red-team labels and the blind rating sheet |
| Planning and coordination | Claude, in Claude Projects | Turned the brief into the kickoff pack ([docs/SPEC.md](docs/SPEC.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TASKS.md](docs/TASKS.md), [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), [docs/DECISIONS.md](docs/DECISIONS.md)), audited the brief for legal, licensing and ethics traps, briefed the coding sessions and routed Paawan's questions to them |
| Coding | Claude Code cloud sessions, one per task thread | Cloned the repo, worked on a branch, ran the tests and hooks, opened merge requests, drove CI green, ran the soak and red-team jobs, and audited the result against the brief |

Agents also made calls where the brief was silent, on a stated default, so work did not stop waiting for an answer. Anything that changed a goal, spent money or could not be undone went to Paawan first.

## Source of truth

0. [docs/GUARDRAILS.md](docs/GUARDRAILS.md): compliance, licensing and safety rules. They outrank everything below, including the brief. A conflict is implemented in the rule's favour and recorded in README.md under "Known constraints".
1. The Boostlingo brief, restated in [docs/SPEC.md](docs/SPEC.md). It is confidential and is not in the repo.
2. [docs/TASKS.md](docs/TASKS.md): task list, budgets, repo layout, CI plan.
3. [docs/DECISIONS.md](docs/DECISIONS.md): decisions with rationale and trade-offs. Re-read before changing anything it covers, and update it when a decision changes.
4. [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): definition of done. A box is ticked only with evidence.

## Rules for agents in this repo

- Read [docs/GUARDRAILS.md](docs/GUARDRAILS.md) first, then the task's entry in TASKS.md and the decisions it touches.
- One task, one branch, one merge request, made of logically scoped Conventional Commits (`feat(cascade): …`, `fix(audio): …`, `docs: …`). Never squash: merge requests merge with a merge commit so every commit stays in history. Never force-push `main`, never `--no-verify`.
- A task is done when hooks pass, CI is green and its ACCEPTANCE.md rows are ticked with evidence.
- Keys stay on the server, in environment variables only. Never print or commit one. The backend mints short-lived Realtime client secrets, so no OpenAI key reaches the browser. CI fails if a provider key name or `sk-` appears in the built web output (`scripts/check-bundle-secrets.sh`), and gitleaks scans the full history on every pipeline.
- Synthetic data only. No real speech, names or patient details go to any provider, log or test.
- Vendor facts (endpoints, event names, model ids, prices, terms) are checked against the vendor's own page or SDK type definitions and cited, or marked [VERIFY]. Never guessed.
- Vendor code lives only in `server/Interpreter.Providers.*`; `Interpreter.Core` never references a provider; `web/src/components/**` never imports transport internals.
- Live-provider tests are tagged `Category=Live` and never run on the push path.
- Measure honestly: never stub a provider and report its latency, never widen a tolerance to pass, and report a missed benchmark as missed.
- Don't change GitLab project settings (protection, schedules, runners); recommend them in the merge request.

## Commands

```bash
# backend
dotnet build server
dotnet test --solution server/Interpreter.slnx --filter-not-trait "Category=Live"   # xunit.v3 on Microsoft.Testing.Platform
dotnet run --project server/Interpreter.Api

# frontend
cd web && npm ci && npm run dev      # Vite proxies /api and /ws to the backend
npm run lint && npm run typecheck && npm test

# eval
python3 eval/summarize.py eval/results/logs/2026-10-15-*-replay-*.json   # p50/p95, WER, chrF, cost per mode (writes eval/results/summary.md; --out elsewhere to keep it)
```

## Attribution in history

Commits are authored as Paawan. Every commit an agent made carries a `Co-Authored-By` trailer naming the model (36 from the evening of 2026-10-16 name only "Claude") and a `Claude-Session` trailer (a private link to the session that made it), and about half of the commits on `main` have Claude as committer. [AI_USAGE.md](AI_USAGE.md) lists which artifacts were model-generated and which were checked.

## What the history shows, honestly

- **Some branches carry more than one task**, against the one-task-one-branch rule: the Vietnamese-onboarding branch also carries the eval summary, write-up draft and README; the output-checks branch carries six guardrail tasks; the final-audit branch carries 46 commits of fixes.
- **Many commits landed in quick bursts.** On `main` as of 2026-10-17 (c46defa), 77 of the 237 non-merge commits have a committer time within 5 s of the previous commit, and 29 of the 44 merges came within 60 s of the previous merge. Agents prepared a series of commits and committed it at once, and stacked merge requests were merged one after another. The history was not rewritten or backdated.
- **`.gitignore` with `.env` arrived in the fifth commit**, the first code commit; the first four were docs only. No `.env` or key was ever committed.
- **The container could not reach OpenAI's, ElevenLabs' or Deepgram's websites.** Endpoint and event names were checked against the `openai` npm package's type definitions and live API calls; prices and data terms were read on the official pages on 2026-10-16 by Paawan and by a browsing AI assistant Paawan directed, whose table Paawan checked; two prices came from a web search on 2026-10-17 and are labelled as such.

## What went wrong

- **Translate-mode transcript lines were rewritten three times.** Pairing source and target lines by pauses, then by sentence count, both misattributed translations in the soak runs. The fix came from probing the live stream and finding that both transcripts share the model's `elapsed_ms` clock.
- **Realtime silently dropped 7 of 26 turns** ("conversation already has an active response") until the 5-minute soak exposed it. Turns are now queued, and a commit that arrives during a response waits for it.
- **The replay harness clipped about 1 in 4 cascade turns**, which a late recheck of the brief found: the next clip started before the previous interpretation, and the mic gate cut it. After the fix the cascade and both Realtime models were re-measured; Realtime translate, the Claude-translator cascade and the red-team suite were not, and the write-up says so.
- **Latency started over target.** Server-side end-of-turn detection cost about 500 ms per turn and merged turns. Moving endpointing to the browser and streaming speech-to-text brought Realtime to 1271/1602 ms and cascade to 1940/2319 ms (p50/p95). Realtime's p95 still misses 1.5 s.
- **OpenAI credit ran out mid-soak** on 2026-10-15, so some runs are smaller than planned. No run reached the guardrails' 50 latency samples.
- **Deepgram's terms forbid benchmarking without consent**, so an OpenAI speech-to-text adapter was added and no Deepgram number is published.
- **Heap growth from minute 1 misses the 10% criterion.** A 6-minute probe showed the heap levels off once the transcript view reaches its row cap, so it is reported as measured with that explanation, not re-tuned to pass.
- **Tooling slips:** an agent killed its own shell with `pkill -f` matching its own command line; a CI artifact upload failed (413) and hid a report; local runs tripped on `source .env` not exporting variables.

## What to do differently next time

Plan the whole UI as a wireframe first and build to it; here the UI took a second pass (UI v2). Run the full measurement suite once early, so harness bugs show up before the numbers are written up.
