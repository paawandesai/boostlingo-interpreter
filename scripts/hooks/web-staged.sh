#!/usr/bin/env sh
# lint-staged runner for web/ files: ESLint and Prettier must run from web/ to pick up its config.
set -e
cd "$(dirname "$0")/../../web"
npx eslint --fix --max-warnings 0 "$@"
npx prettier --write "$@"
