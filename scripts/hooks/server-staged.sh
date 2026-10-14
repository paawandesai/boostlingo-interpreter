#!/usr/bin/env sh
# lint-staged runner for C#: whitespace only, so pre-commit stays fast.
# Style and analyzer checks run in pre-push and CI (dotnet format --verify-no-changes).
set -e
cd "$(dirname "$0")/../../server"
dotnet format whitespace Interpreter.slnx --include "$@"
