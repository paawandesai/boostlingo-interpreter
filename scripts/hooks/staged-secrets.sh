#!/usr/bin/env sh
# Pre-commit secret check (docs/GUARDRAILS.md, Secrets).
# Fails on staged lines that look like a real credential.
# Lists broader keyword matches so the committer confirms nothing real is staged.
set -e

# Secret scanner (docs/GUARDRAILS.md). CI always runs it; locally it runs when installed.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --pre-commit --staged --redact --no-banner .
else
  echo "Secret check: gitleaks not installed, so only the pattern check runs here (CI runs gitleaks). Install: brew install gitleaks" >&2
fi

added=$(git diff --cached -U0 --no-color | grep -E '^\+' | grep -vE '^\+\+\+ ' || true)
[ -z "$added" ] && exit 0

strong='sk-[A-Za-z0-9_-]{16,}|ek_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|xi-api-key[^\n]*[0-9a-f]{32}|Bearer [A-Za-z0-9._-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
if printf '%s\n' "$added" | grep -qE "$strong"; then
  echo "Blocked: a staged line looks like a real credential." >&2
  echo "Remove it from the commit, then rotate the key if it was ever real." >&2
  exit 1
fi

broad=$(printf '%s\n' "$added" | grep -inE 'api[_-]?key|secret|token|passw|Bearer |sk-' || true)
if [ -n "$broad" ]; then
  echo "Secret check: $(printf '%s\n' "$broad" | wc -l | tr -d ' ') staged line(s) mention keys, secrets or tokens." >&2
  echo "None looks like a real credential. Run 'git diff --cached | grep -iE \"api[_-]?key|secret|token|passw|Bearer |sk-\"' to review them." >&2
fi
