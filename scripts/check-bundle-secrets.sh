#!/usr/bin/env sh
# Fails if built web output contains a provider key or key name (docs/GUARDRAILS.md, Keys and transport).
# Usage: check-bundle-secrets.sh <dir> [<dir>...]   (defaults to web/dist and web/build)
set -e
[ "$#" -eq 0 ] && set -- web/dist web/build
pattern='OPENAI_API_KEY|DEEPGRAM|ASSEMBLY|ELEVEN|DEEPL|(^|[^A-Za-z0-9_-])sk-'
found=0
for dir in "$@"; do
  [ -d "$dir" ] || continue
  if grep -rEn "$pattern" "$dir"; then found=1; fi
done
if [ "$found" -ne 0 ]; then
  echo "Provider key or key name found in built web output" >&2
  exit 1
fi
echo "Bundle secret scan: clean ($*)"
