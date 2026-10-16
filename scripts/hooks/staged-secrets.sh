#!/usr/bin/env sh
# Pre-commit secret check (docs/GUARDRAILS.md, Secrets).
# Fails on staged lines that look like a real credential.
# Lists broader keyword matches so the committer confirms nothing real is staged.
set -e

# Secret scanner (docs/GUARDRAILS.md). CI runs gitleaks over the full history on every pipeline.
# Locally it runs when installed; without it the commit still goes through on the pattern check
# below, and this notice (printed once per commit, this hook runs once) says so. It never fails
# the commit for a missing gitleaks: not every machine has it.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --pre-commit --staged --redact --no-banner .
else
  cat >&2 <<'EOF'
Secret check: gitleaks is not installed, so this commit gets the pattern check only.
  CI still runs gitleaks over the full history on every pipeline. To scan locally, install it once:
    macOS: brew install gitleaks
    Linux: a release binary from https://github.com/gitleaks/gitleaks/releases
           (gitleaks_<version>_linux_x64.tar.gz; unpack it onto your PATH)
EOF
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
