#!/usr/bin/env bash
# Usage: scale/replicas.sh start [n=3] | stop [n] | term <i> | kill <i> | restart <i> | status
# Replica i listens on 808<i>. Each is a plain `node` process (a signal sent to its pid reaches the app).
# Environment is read from backend/.env; override DATABASE_URL / DB_POOL_MAX / CACHE_ENABLED before calling.
set -euo pipefail
cd "$(dirname "$0")/.."
PRE_DB="${DATABASE_URL:-}"   # an explicit DATABASE_URL (e.g. the bench database) wins over .env
set -a; . ./.env; set +a
[ -n "$PRE_DB" ] && export DATABASE_URL="$PRE_DB"
RUN=/tmp/eventhub-replicas; mkdir -p "$RUN"
start_one() {
  local i=$1
  PORT=$((8080 + i)) SEED_DEMO_USERS=0 TRUSTED_PROXIES=127.0.0.2 LOG_LEVEL="${LOG_LEVEL:-warn}" \
    nohup node --import tsx src/server.ts >"$RUN/r$i.log" 2>&1 &
  echo $! >"$RUN/r$i.pid"
}
case "${1:-}" in
  start) n="${2:-3}"; for i in $(seq 1 "$n"); do start_one "$i"; done
         for i in $(seq 1 "$n"); do for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$((8080 + i))/health/ready" >/dev/null && break; sleep 0.2; done; done
         echo "started $n replicas (ports 8081..808$n)" ;;
  stop)  for f in "$RUN"/r*.pid; do [ -f "$f" ] && { kill -TERM "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }; done; echo stopped ;;
  term)  kill -TERM "$(cat "$RUN/r$2.pid")" ;;
  kill)  kill -KILL "$(cat "$RUN/r$2.pid")" ;;
  restart) start_one "$2"; for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$((8080 + $2))/health/ready" >/dev/null && break; sleep 0.2; done ;;
  status) for i in 1 2 3; do printf "r$i: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 1 "http://127.0.0.1:$((8080 + i))/health/ready" || true; done ;;
  *) echo "usage: $0 start|stop|term|kill|restart|status" >&2; exit 2 ;;
esac
