#!/usr/bin/env bash
# The deterministic gate: types, unit tests, production build, package.
#   bash scripts/verify.sh          -> always runs everything (manual, before handing a build over)
#   bash scripts/verify.sh --hook   -> Stop hook: skips when nothing changed, never loops
# Exit 0 = green, exit 2 = red (the hook convention that feeds the failure back to Claude).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 0

if [ "${1:-}" = "--hook" ]; then
  INPUT="$(timeout 1 cat 2>/dev/null || true)"
  # Already in a forced continuation: do not block a second time.
  if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi
  # A turn that changed nothing (research, questions) costs one git status.
  [ -n "$(git status --porcelain 2>/dev/null)" ] || exit 0
fi

[ -d node_modules ] || { echo "verify: node_modules missing — run: npx npm@11 install" >&2; exit 2; }

run() {
  local label="$1"; shift
  local log; log="$(mktemp)"
  if ! "$@" >"$log" 2>&1; then
    echo "verify: $label FAILED — fix this before finishing." >&2
    tail -c 4000 "$log" >&2
    rm -f "$log"
    exit 2
  fi
  rm -f "$log"
}

run "tsc" npx tsc --noEmit
run "tests" npm test --silent
run "build" node esbuild.config.mjs production
run "package" node scripts/package.mjs

echo "verify: green — $(node -e "console.log(require('./release/vault-planner/manifest.json').version)") in release/vault-planner.zip"
