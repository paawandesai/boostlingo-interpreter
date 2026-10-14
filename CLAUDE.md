# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first: roles, workflow, commands, guardrails and the "do not" list all live there. This file adds only what Claude Code needs at the start of a session.

- Start each task by reading its entry in [docs/TASKS.md](docs/TASKS.md) and the decisions it touches in [docs/DECISIONS.md](docs/DECISIONS.md).
- Work on a feature branch named `t<id>-<slug>` (for example `t1.4-audio-io`) and open an MR with `glab mr create`. Never push to `main` after the bootstrap commit.
- Keep commits small and Conventional; never squash, never `--no-verify`.
- Before calling a task done: tests and hooks pass, CI is green, and the task's rows in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) are ticked with evidence.
- Say "verify" next to any vendor fact you could not check, and check it before code depends on it.
