# AGENTS.md

How this repo is built with coding agents, and the rules any agent working in it follows. This file is kept honest: it says what actually happened, including what went wrong. The final account is written on Day 4 (T4.5).

## Who does what

| Role | Who | Responsibilities |
|---|---|---|
| Manager / owner | Paawan Desai | Sets goals, approves and merges MRs, makes product calls, runs the 🎧 checks that need a real mic and ears, scores quality blind |
| Architect / reviewer | Claude, in a Claude Projects thread | Wrote the kickoff pack and the decisions log, writes task briefs, reviews MRs as blocking / should-fix / nit tied to a requirement, enforces the timebox |
| Executor | Claude Code cloud session (a separate Claude Projects thread), cloned into this repo | Implements tasks from [docs/TASKS.md](docs/TASKS.md) one MR at a time, runs tests and hooks, opens MRs with `glab` |

Commits are authored as Paawan (the executor sets `user.name`/`user.email` from environment variables). Every commit made by an agent carries a `Co-Authored-By` trailer so the agent's share of the work is visible in history.

## Source of truth

0. [docs/GUARDRAILS.md](docs/GUARDRAILS.md): compliance, licensing and safety rules. They outrank everything below, including the brief's acceptance criteria. A conflict is implemented in the rule's favour and recorded in README.md under "Known constraints".
1. The Boostlingo brief (summarised in [docs/SPEC.md](docs/SPEC.md)). It wins on any conflict; conflicts are recorded in [docs/DECISIONS.md](docs/DECISIONS.md).
2. [docs/TASKS.md](docs/TASKS.md): task list, hour budgets, repo layout, CI plan.
3. [docs/DECISIONS.md](docs/DECISIONS.md): D1–D16 with rationale and trade-offs. Re-read before changing anything it covers, and update it when a decision changes.
4. [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): definition of done. A box is ticked only with evidence.

## Workflow

- One task = one feature branch = one MR, made of one or more logically scoped commits.
- Conventional Commits: `feat(cascade): …`, `fix(audio): …`, `test(pipeline): …`, `docs: …`, `ci: …`, `chore: …`.
- **Never squash.** MRs merge with a merge commit so every commit stays in history (the brief judges iterative development).
- Never force-push `main`. Never commit with `--no-verify`.
- Every task ends with: hooks pass, CI green, acceptance rows ticked with evidence, decisions log updated if needed.
- If a task overruns its budget by 50%, stop and report in the thread.

## Commands

Filled in as the skeleton and CI land (T0.2, T1.3).

```bash
# backend
dotnet build server
dotnet test server --filter "Category!=Live"
dotnet run --project server/Interpreter.Api

# frontend
cd web && npm ci && npm run dev      # Vite proxies /api and /ws to the backend
npm run lint && npm run typecheck && npm test
```

## Guardrails

- **Secrets.** Never commit or print a key. Keys come only from environment variables on the server. The OpenAI key never reaches the browser: the backend mints short-lived Realtime client secrets. CI fails if `sk-` or `OPENAI_API_KEY` appears in the web bundle.
- **Boundaries.** Vendor SDK/HTTP/WS code lives only in `server/Interpreter.Providers.*`. `Interpreter.Core` never references a provider assembly. `web/src/components/**` never imports transport internals.
- **Vendor facts.** Don't guess endpoints, event names, model IDs or prices. Check current docs (or the vendor SDK's type definitions when docs are unreachable) and cite the source in the commit or MR.
- **Tests.** Write the test first for the pipeline, FlushPolicy and latency calculator. Live-provider tests are tagged `Category=Live` and never run on the push path.
- **Resources.** Every `start()` has a matching teardown and a test or check for it.

## Do not

- Polish the UI before every must-have works end to end.
- Add providers beyond those in D7 without approval.
- Squash, force-push `main`, or bundle unrelated changes into one commit.
- Change GitLab project settings (protection, schedules, runners); recommend them in the MR instead.
- Write code in a docs-only task, or docs-only changes in a code task's commit.

## Environment notes (honest log)

- The repo lives on a self-hosted GitLab (labs.gauntletai.com). Claude Projects attaches only github.com repos, so the cloud session clones over HTTPS with a token from its environment and uses `glab` for MRs. On 2026-10-14 the environment's setup script did not run its GitLab steps, so the first session connected by hand (credential helper, per-repo identity, `glab auth login`).
- The cloud container has no microphone or speakers. Automated audio checks use Chromium fake-audio flags with replay files; anything that needs ears is a 🎧 task for Paawan.
- The container's network policy blocks OpenAI's docs sites, so Realtime endpoint and event names were checked against the `openai` npm package's type definitions (v7.32.0) and confirmed with live API calls.
