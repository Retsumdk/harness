#!/usr/bin/env bash
# Turns the Vite demo build into the exact shape a static host serves:
# index.html at the site root, plus a 404.html that boots the app from any depth
# so a deep link or a reload lands on the route instead of a host error page.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f demo/demo.html ] && mv demo/demo.html demo/index.html
if [ ! -f demo/index.html ]; then
  echo "finalize-demo: no demo/index.html after the build" >&2
  exit 1
fi
# A copy of index.html would resolve its relative asset URLs against the *deep* path
# (/<repo>/runs/run_123/assets/app.js -> 404 -> blank page), so the 404 document is
# generated instead: it finds the deploy prefix at runtime and boots the app from it.
bun run src/demo/fallback.ts demo/index.html demo/404.html || exit 1
if grep -qE '(src|href)="\./assets/' demo/404.html; then
  echo "finalize-demo: 404.html still carries relative asset paths" >&2
  exit 1
fi

# A publisher may pass DENY_PATTERN (an extended regexp) to refuse a bundle that
# carries vendor strings; the pattern comes from the caller so this script does
# not contain those strings itself.
if [ -n "${DENY_PATTERN:-}" ] && grep -qE "$DENY_PATTERN" demo/index.html; then
  echo "finalize-demo: the bundle contains strings that must not ship" >&2
  exit 1
fi

echo "finalize-demo: $(find demo -type f | wc -l) files, $(du -sh demo | cut -f1)"
