#!/usr/bin/env bash
# Lecture 22 functional checks through the proxy (8080) and directly on replicas (8081-8083). Synthetic data only.
# Requires: scale/replicas.sh start, scale/lb.sh up, backend/.env. It creates two throwaway organizer users.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
H='Content-Type: application/json'; P=http://127.0.0.1:8080/api/v1; PW=synthetic-pass-12345
jq_() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
echo "== E1 distribution: 30 GET /health through the proxy"
for i in $(seq 30); do curl -s -D - -o /dev/null http://127.0.0.1:8080/health | tr -d '\r' | grep -i '^x-upstream'; done | sort | uniq -c
U=lab_$RANDOM
echo "== E2 auth across replicas"
curl -s -o /dev/null -w "register via proxy: %{http_code}\n" -X POST $P/auth/register -H "$H" -d "{\"username\":\"$U\",\"password\":\"$PW\"}"
psql "$DATABASE_URL" -qXc "UPDATE users SET role='organizer' WHERE username='$U'"   # trusted synthetic setup: there is no HTTP route to set a role
TOK=$(curl -s -X POST http://127.0.0.1:8081/api/v1/auth/login -H "$H" -d "{\"username\":\"$U\",\"password\":\"$PW\"}" | jq_ token)
echo "token minted on replica 1; GET /auth/me x9 through the proxy:"
for i in $(seq 9); do curl -s -D - -o /dev/null $P/auth/me -H "Authorization: Bearer $TOK" | tr -d '\r' | grep -iE '^(HTTP|x-upstream)' | paste -sd' '; done | sort | uniq -c
printf "negative, bad token: "; curl -s -o /dev/null -w "%{http_code}\n" $P/auth/me -H "Authorization: Bearer nope"
echo "== E3 write on replica 1, read on replica 2"
ID=$(curl -s -X POST http://127.0.0.1:8081/api/v1/events -H "$H" -H "Authorization: Bearer $TOK" -d '{"name":"Scale lab event","seats":7}' | jq_ id)
echo "created id=$ID on :8081"; printf "read on :8082 -> "; curl -s http://127.0.0.1:8082/api/v1/events/$ID; echo
printf "owner PATCH via :8083 -> "; curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://127.0.0.1:8083/api/v1/events/$ID -H "$H" -H "Authorization: Bearer $TOK" -d '{"seats":8}'
U2=lab_$RANDOM; curl -s -o /dev/null -X POST $P/auth/register -H "$H" -d "{\"username\":\"$U2\",\"password\":\"$PW\"}"; psql "$DATABASE_URL" -qXc "UPDATE users SET role='organizer' WHERE username='$U2'"
T2=$(curl -s -X POST http://127.0.0.1:8083/api/v1/auth/login -H "$H" -d "{\"username\":\"$U2\",\"password\":\"$PW\"}" | jq_ token)
printf "negative, WRONG OWNER PATCH via :8082 -> "; curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://127.0.0.1:8082/api/v1/events/$ID -H "$H" -H "Authorization: Bearer $T2" -d '{"seats":1}'
printf "negative, unauthenticated PATCH via proxy -> "; curl -s -o /dev/null -w "%{http_code}\n" -X PATCH $P/events/$ID -H "$H" -d '{"seats":1}'
echo "== E4 restart replica 1 (SIGKILL): session and event survive"
./scale/replicas.sh kill 1; ./scale/replicas.sh restart 1
printf "me via restarted :8081 -> "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/api/v1/auth/me -H "Authorization: Bearer $TOK"
printf "event via restarted :8081 -> "; curl -s http://127.0.0.1:8081/api/v1/events/$ID; echo
echo "== E5 logout on replica 3 revokes on replica 1"
printf "logout via :8083 -> "; curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8083/api/v1/auth/logout -H "Authorization: Bearer $TOK"
printf "me via :8081 after logout -> "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/api/v1/auth/me -H "Authorization: Bearer $TOK"
