#!/usr/bin/env sh
# lint-staged runner for non-TS web/ files (json, css, html, md): Prettier only.
set -e
cd "$(dirname "$0")/../../web"
npx prettier --write --ignore-unknown "$@"
