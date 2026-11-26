#!/usr/bin/env bash
# Lecture 22 failure drill. Usage: scale/drill.sh kill|term|all-down
# Sends ~20 GET /api/v1/events/1 per second through the proxy for 14 s; at t=3 s it hits replica 2 (kill = SIGKILL,
# term = SIGTERM, all-down = SIGKILL all three), restarts it at t=9 s (not for all-down), and prints a per-second table
# of statuses/upstreams. 'time to exclusion' = time of the last non-2xx response after the fault.
set -uo pipefail
cd "$(dirname "$0")/.."
mode=${1:?kill|term|all-down}
out=$(mktemp)
t0=$(date +%s.%N)
( for i in $(seq 280); do
    s=$(date +%s.%N)
    curl -s -o /dev/null --max-time 5 -w "%{http_code} %{header_json}" http://127.0.0.1:8080/api/v1/events/1 2>/dev/null | node -e 'let d=require("fs").readFileSync(0,"utf8");const c=d.slice(0,3);let u="-";try{u=JSON.parse(d.slice(4))["x-upstream"]?.[0]??"-"}catch{};console.log(c,u)' | sed "s/^/$(printf '%.2f' "$(echo "$s - $t0" | bc)") /" >>"$out"
    sleep 0.05
  done ) &
gen=$!
sleep 3; echo "t=3s: fault ($mode)"
case $mode in
  kill) ./scale/replicas.sh kill 2 ;;
  term) ./scale/replicas.sh term 2 ;;
  all-down) for i in 1 2 3; do ./scale/replicas.sh kill $i; done ;;
esac
if [ "$mode" != all-down ]; then sleep 6; echo "t=9s: restarting replica 2"; ./scale/replicas.sh restart 2; else sleep 6; echo "t=9s: restarting all"; for i in 1 2 3; do ./scale/replicas.sh restart $i; done; fi
wait $gen
echo "--- per-second summary (second status upstream count)"
awk '{printf "%d %s %s\n", $1, $2, $3}' "$out" | sort | uniq -c | awk '{print $2, $3, $4, $1}' | sort -n -k1,1 -k2,2 | awk '{k=$1; a[k]=a[k] " " $2 "@" $3 "x" $4} END{for(k in a) print k "s:" a[k]}' | sort -n
echo "--- totals"; awk '{print $2}' "$out" | sort | uniq -c
echo "--- non-2xx timeline (seconds since start)"; awk '$2 !~ /^2/ {print $1, $2}' "$out" | sed -n '1p;$p'
rm -f "$out"
