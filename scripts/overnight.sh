#!/usr/bin/env bash
# Overnight Token Factory comparison: preflight → stage 1 (baseline) → stage 2 (hygiene, proxy, hooks)
# → summary. Runbook: docs/eng/overnight-runbook.md.
#
#   caffeinate -i ./scripts/overnight.sh            # full run
#   ./scripts/overnight.sh --preflight-only         # checks only, ~2 min
#   ./scripts/overnight.sh --fresh                  # forget finished stages and start over
#
# Resumable: each finished step leaves .measurements/overnight/<step>.done and is skipped on the next
# start. A failed step does not stop the night — the next step runs and the failure is logged.
# Every bench attempt is written to .measurements/metrics.jsonl as soon as it ends, so a crash mid-step
# loses at most the attempt in flight.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT=.measurements/overnight
mkdir -p "$OUT"
STATUS="$OUT/status.log"

TF="zai-org/GLM-5.3-Flash,MiniMaxAI/MiniMax-M3.1-Flash,deepseek-ai/DeepSeek-V4-Pro-0813"
SOL="gpt-6.1-sol"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$STATUS"; }
fail() { log "PREFLIGHT FAIL: $*"; exit 1; }

[ "${1:-}" = "--fresh" ] && rm -f "$OUT"/*.done && log "fresh start: cleared finished steps"

# ── preflight ─────────────────────────────────────────────────────────────
log "preflight start ($ROOT)"
[ "$(git rev-parse --abbrev-ref HEAD)" = "token-factory" ] || fail "not on branch token-factory"
npm run --silent agents:reset >/dev/null && npm run --silent hooks:reset >/dev/null && npm run --silent proxy:reset >/dev/null \
  || fail "lever reset failed"
# Agent edits under apps/angular-demo/src are wiped by bench before every attempt; anything else is not.
dirty=$(git status --porcelain | grep -vE ' (package-lock\.json|apps/angular-demo/TASK\.md)$| apps/angular-demo/src/' || true)
[ -z "$dirty" ] || fail "uncommitted changes outside the app (commit or stash them):"$'\n'"$dirty"
command -v node >/dev/null || fail "node not found"
command -v codex >/dev/null || fail "codex not found"
[ -d node_modules/tsx ] || fail "node_modules missing — run npm install"
grep -qE '^NEBIUS_API_KEY=.+' .env 2>/dev/null || fail "NEBIUS_API_KEY empty in .env"
[ -f apps/angular-demo/TASK.md ] || fail "apps/angular-demo/TASK.md missing — run: npm run task -- codex"
docker info >/dev/null 2>&1 || fail "Docker API not answering — restart Docker Desktop"
for s in jira github confluence sentry testrail proxy; do
  h=$(docker inspect -f '{{.State.Health.Status}}' "plata-mcp-$s" 2>/dev/null || echo missing)
  [ "$h" = "healthy" ] || fail "container plata-mcp-$s is $h — run: docker compose up -d"
done
free_gb=$(df -g . | awk 'NR==2{print $4}')
[ "${free_gb:-0}" -ge 5 ] || fail "only ${free_gb} GB free on disk"
pmset -g batt 2>/dev/null | grep -q "AC Power" || log "WARN: not on AC power — plug in the charger"
pmset -g assertions 2>/dev/null | grep -q "PreventUserIdleSystemSleep *1" || log "WARN: no sleep assertion — start this script under caffeinate -i"

ping_out=$(npm run --silent bench -- --ping --models "$TF" 2>&1)
pongs=$(grep -c PONG <<<"$ping_out")
[ "$pongs" -ge 3 ] || fail "Token Factory ping: $pongs/3 models answered"$'\n'"$(tail -20 <<<"$ping_out")"
ping_sol=$(npm run --silent bench -- --ping --provider openai --models "$SOL" 2>&1)
grep -q PONG <<<"$ping_sol" || fail "OpenAI ping for $SOL failed"$'\n'"$(tail -20 <<<"$ping_sol")"
log "preflight OK"
[ "${1:-}" = "--preflight-only" ] && exit 0

# ── steps ─────────────────────────────────────────────────────────────────
step() { # step <name> <bench args…>
  local name=$1; shift
  if [ -f "$OUT/$name.done" ]; then log "skip $name (done)"; return; fi
  if ! docker info >/dev/null 2>&1; then
    log "Docker API down before $name — waiting up to 5 min"
    for _ in $(seq 30); do sleep 10; docker info >/dev/null 2>&1 && break; done
  fi
  log "start $name: bench $*"
  local t0=$SECONDS
  npm run --silent bench -- "$@" 2>&1 | tee "$OUT/$name.log"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then touch "$OUT/$name.done"; log "done $name in $(( (SECONDS - t0) / 60 )) min"
  else log "FAILED $name (exit $rc) after $(( (SECONDS - t0) / 60 )) min — see $OUT/$name.log; continuing"; fi
}

step stage1-tf  --models "$TF" --conditions baseline --attempts 4
step stage1-sol --provider openai --models "$SOL" --effort medium --attempts 2
step stage2-tf  --models "$TF" --conditions hygiene,proxy,hooks --attempts 5
step stage2-sol --provider openai --models "$SOL" --effort medium --conditions hygiene,proxy --attempts 3

npm run --silent agents:reset >/dev/null; npm run --silent hooks:reset >/dev/null; npm run --silent proxy:reset >/dev/null
npx tsx e2e/summarize.ts > "$OUT/summary.log" 2>&1 && log "summary → .measurements/overnight-summary.md" || log "FAILED summary — see $OUT/summary.log"
log "night finished"
