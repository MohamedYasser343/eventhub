#!/usr/bin/env bash
# Lecture 21: start ONE API on the bench database, run one scenario matrix, stop it.
#   LABEL=baseline CACHE=true ./experiments/bench/run-single.sh scenario[:vus] ...
# Env: LABEL, CACHE (true|false), DB_POOL_MAX, DURATION_S, WARMUP_S, PORT (default 8090).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export DATABASE_URL="$BENCH_DATABASE_URL" CACHE_ENABLED="${CACHE:-true}" PORT="${PORT:-8090}" LOG_LEVEL=warn
node --import tsx src/server.ts >/tmp/bench-api.log 2>&1 &
API=$!
trap 'kill -TERM $API 2>/dev/null; wait $API 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health/ready" >/dev/null && break; sleep 0.2; done
for spec in "$@"; do
  sc="${spec%%:*}"; vus="${spec##*:}"; [ "$vus" = "$spec" ] && vus=10
  BASE_URL="http://127.0.0.1:$PORT" SCENARIO="$sc" VUS="$vus" LABEL="${LABEL:-run}" DURATION_S="${DURATION_S:-15}" WARMUP_S="${WARMUP_S:-4}" npx tsx experiments/bench/load.ts | grep -v '^JSON'
done
