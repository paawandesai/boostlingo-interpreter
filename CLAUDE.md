# CLAUDE.md

Read [docs/GUARDRAILS.md](docs/GUARDRAILS.md) before any change; it outranks every other document, including the brief. Then read [AGENTS.md](AGENTS.md) for how this repo is run with agents and the rules that apply.

At the start of a task:

- Read the task in [docs/TASKS.md](docs/TASKS.md) and the decisions it touches in [docs/DECISIONS.md](docs/DECISIONS.md).
- Work on a branch named `t<id>-<slug>` for a task (`g<id>-<slug>` for a guardrail task) or `<type>/<slug>` (`fix/`, `docs/`, `ci/`, `bench/`) for a follow-up, and open a merge request; never push to `main`.
- Small Conventional Commits; never squash, never `--no-verify`.
- A task is done when tests and hooks pass, CI is green and its rows in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) are ticked with evidence.
- Mark any vendor fact you could not check as [VERIFY], and check it before code depends on it.
