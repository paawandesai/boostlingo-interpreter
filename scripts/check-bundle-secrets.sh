#!/usr/bin/env sh
# Fails if built web output contains a provider key or key name (docs/GUARDRAILS.md, Keys and transport).
# Usage: check-bundle-secrets.sh <dir> [<dir>...]   (defaults to whichever of web/dist and web/build exist)
# A directory named on the command line must exist, and at least one directory must be scanned: a wrong
# path or a failed build is a failure, never "clean".
set -e
explicit=1
if [ "$#" -eq 0 ]; then
  explicit=0
  set -- web/dist web/build
fi
pattern='OPENAI_API_KEY|DEEPGRAM|ASSEMBLY|ELEVEN|DEEPL|(^|[^A-Za-z0-9_-])sk-'
found=0
scanned=0
for dir in "$@"; do
  if [ ! -d "$dir" ]; then
    if [ "$explicit" -eq 1 ]; then
      echo "Bundle secret scan: $dir is not a directory (missing build output?)" >&2
      exit 1
    fi
    continue
  fi
  scanned=$((scanned + 1))
  # File names only: printing the matching line would put a leaked key in the job log.
  if grep -rlE "$pattern" "$dir"; then found=1; fi
done
if [ "$scanned" -eq 0 ]; then
  echo "Bundle secret scan: no build output found in $* (run the build first)" >&2
  exit 1
fi
if [ "$found" -ne 0 ]; then
  echo "Provider key or key name found in built web output" >&2
  exit 1
fi
echo "Bundle secret scan: clean ($*)"
