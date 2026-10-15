#!/usr/bin/env sh
# lint-staged runner for C#: whitespace only, in --folder mode (no solution load: about 3 s, not 8 s).
# Style and analyzer checks run in pre-push and CI (dotnet format --verify-no-changes).
set -e
cd "$(dirname "$0")/../../server"
dotnet format whitespace --folder --include "$@"
