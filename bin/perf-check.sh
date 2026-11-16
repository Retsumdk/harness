#!/usr/bin/env bash
# Performance gate: cold start under a second, 100 concurrent chats bounded.
# Conventional entry point; the check itself lives in scripts/perf-check.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun run scripts/perf-check.ts "$@"
