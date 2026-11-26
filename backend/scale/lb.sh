#!/usr/bin/env bash
# Usage: scale/lb.sh up [round_robin|least_conn] | down | logs
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in
  up)
    algo="${2:-round_robin}"
    case "$algo" in round_robin) a="";; least_conn) a="least_conn;";; *) echo "unknown algorithm" >&2; exit 2;; esac
    sed "s/__ALGO__/$a/" nginx.conf.template > nginx.conf
    docker compose up -d --force-recreate lb >/dev/null
    for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8080/health && break; sleep 0.3; done
    [ "$(docker inspect -f '{{.State.Running}}' eventhub-lb)" = true ] || { docker logs eventhub-lb 2>&1 | tail -5 >&2; echo "proxy failed to start" >&2; exit 1; }
    echo "proxy up ($algo) on http://127.0.0.1:8080" ;;
  down) docker compose down >/dev/null; echo "proxy down" ;;
  logs) docker logs --tail "${2:-50}" eventhub-lb ;;
  *) echo "usage: $0 up [round_robin|least_conn] | down | logs" >&2; exit 2 ;;
esac
