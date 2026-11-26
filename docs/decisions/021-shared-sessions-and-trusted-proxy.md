# ADR-021: Shared PostgreSQL sessions and a trusted-proxy client address (horizontal scaling)

Status: Proposed (awaiting owner confirmation)
Date: 2026-11-26
Related lecture: [22 — Backend Scaling & Performance (Part 2)](../lectures/22-backend-scaling-performance-part2.md)

## Context
Inspection of the single-process API found state that breaks with more than one replica:
1. **Sessions** lived in a per-process `Map` (lecture 08). Demonstrated: login on replica A, `GET /auth/me` on replica B returned **401**.
2. **Rate limiters** (lecture 20) are per-process: the effective limit is N x the configured one.
3. **Client address** for the limiters was `req.socket.remoteAddress`; behind a proxy that is the proxy for every client.
4. `ticketsByUser` (synthetic tickets) is a process-local Map, so ticket data diverges between replicas.
Unaffected: users, events and the public-event cache (PostgreSQL / shared Redis), the BullMQ queue (own Redis), migrations (advisory lock).

## Options
Sessions: (a) sticky sessions at the proxy: not durable, breaks on replica replacement; (b) Redis sessions: new dependency, and the lecture said not to add Redis sessions if unnecessary; (c) signed stateless tokens: changes the auth design and loses immediate revocation; (d) **PostgreSQL `sessions` table** keyed by `sha256(token)` (chosen): no new infrastructure, same opaque-token design, immediate logout revocation on every replica, sessions survive restarts.
Client address: (a) trust `X-Forwarded-For` always: spoofable; (b) never trust it: every client shares one bucket behind a proxy; (c) **trust it only from configured proxy IPs** (chosen).
Rate-limit sharing across replicas: deliberately deferred (a shared atomic store is a separate step; the lecture 20 note already said so).

## Decision
- Migration `005_sessions.sql`; `SessionStore` interface with `PgSessionStore` (server) and `InMemorySessionStore` (unit tests). TTL and token format unchanged; expiry is checked with the service clock; expired rows are swept at most once a minute in the background and deleted when presented.
- `TRUSTED_PROXIES` (comma-separated literal IPs, default empty = never trust). `clientAddress()` believes `X-Forwarded-For` only when the socket peer is listed, reads it from the right, skips trusted hops, and falls back to the peer on garbage.
- `DB_POOL_MAX` (default 10) makes the per-process pool bound configurable so the connection budget can be computed: replicas x max (+ worker, admin, tests) must stay below PostgreSQL `max_connections` (default 100).

## Trade-offs and consequences
- Every authenticated request now costs one more PostgreSQL query (session lookup) before the user lookup. Not isolated in a benchmark here (see evidence); a join or short-lived cache are later options.
- Behaviour change: sessions survive a process restart (previously lost). The old test asserting 401 was updated deliberately.
- Rate limits remain **per replica**: with 3 replicas a login key is allowed 3 x 5 failures (measured: lockout at the 16th attempt through the proxy).
- Loopback is trusted in the local lab: anything that can open a connection to a replica from a trusted address can spoof `X-Forwarded-For` (measured). Real deployments must make replicas reachable only via the proxy.
- Tickets stay replica-local and synthetic; booking is out of scope.
- Reversible: use `InMemorySessionStore` in `server.ts`, `DROP TABLE sessions`.

## Evidence
Lecture 22 implementation evidence; tests `test/scaling.test.ts`, updated `test/auth.test.ts`, `test/security.test.ts`, `test/postgres.test.ts`.
