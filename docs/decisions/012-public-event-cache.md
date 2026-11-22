# ADR-012: Redis cache-aside for the public event detail

Status: Accepted (owner confirmed 2026-11-22)
Date: 2026-11-22
Related lecture: [13 - Caching, the Secret Behind It All](../lectures/13-caching.md)

## Context
`GET /events/:id` repeats the same PostgreSQL read for data that rarely changes. Lecture 13 asks for an optional cache with hit/miss, TTL, invalidation and outage behavior, without letting a cache decide anything authoritative.

## Decision
- **Redis via the `redis` npm client (6.3.1).** Redis is the lecture's subject and gives a shared cache with native TTL; an in-process Map would be wrong with more than one server process and would not show the failure modes. A client library is used because hand-writing RESP adds nothing to the lesson. Local container `eventhub-redis` on `127.0.0.1:56379`, no persistence, `maxmemory 64mb`, `allkeys-lru` (compose service; never another project's Redis).
- **Optional.** No `REDIS_URL` means a no-op cache and identical behavior to lecture 12. Tests use `TEST_REDIS_URL` only; helpers delete only the `event:public:v1:` prefix (SCAN + DEL, never FLUSHALL).
- **Scope: one read path.** Only `EventService.getPublic` (used by `GET /events/:id`) is cached. `authorizeEdit`, `replace`, `patch`, `remove` and `TicketService` keep reading PostgreSQL directly, so a stale copy cannot affect authorization or ticket logic. Lists/search are not cached (high-cardinality keys, deferred).
- **Key and value:** `event:public:v1:<id>` holding exactly `{id,name,seats}` (today's whole public DTO). Anything personalized or organizer-only needs its own key family. A cached value that is malformed, has extra/missing fields or a different id is a miss and is replaced.
- **TTL:** `CACHE_TTL_SECONDS`, default 60, whole seconds 1..86400, validated at startup (60 s is an arbitrary learning default, not a product freshness requirement).
- **Invalidation:** delete the key after a successful `replace`/`patch`/`remove`; never on a throw (failed write, forbidden, invalid). Creation needs none because not-found is **not cached** (ids are serial; a cached 404 would go stale when that id is created).
- **Failure policy:** every cache error or 100 ms timeout is swallowed and counted, and the request is served from PostgreSQL. A DEL failure after commit still returns success; the stale copy lives at most one TTL. The client has no offline queue (fails immediately while disconnected), reconnects in the background with backoff capped at 2 s, never blocks startup, and an `error` listener prevents a process crash.
- **Observability:** in-process counters (`hits, misses, corrupt, errors, sourceReads, invalidations, invalidationErrors`); no response header and no metrics endpoint.

## Trade-offs and consequences
- A DB commit and a Redis DEL are not atomic. A reader that fetched the old row before an update can re-cache it after the DEL (reproduced deterministically in a test); the window is bounded by the TTL. Not fixed (versioning/locking deferred).
- No stampede protection: N parallel cold reads cause N database reads (characterized in a test, not mitigated).
- The public GET can serve data up to one TTL stale when invalidation fails; seats shown are advisory and no booking decision may use them.
- Adds a dependency, a container and three env vars; reversible by unsetting `REDIS_URL`.

## Evidence
`backend/test/caching.test.ts`, `docs/evidence/lecture-13-cache-latency.txt`, and the lecture note's implementation section. A local microbenchmark on one synthetic row says little about production behavior.
