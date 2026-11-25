# ADR-015: Dependency-failure mapping (503) and liveness/readiness probes

Status: Accepted (owner confirmed 2026-11-25)
Date: 2026-11-25
Related lecture: [16 — Error handling and fault tolerance](../lectures/16-error-handling-fault-tolerance.md)

## Context
An audit of the existing paths (see the lecture note's evidence section) found most of the lecture-16 assignment already in place: a central async error boundary, typed outcomes for 404/409/422, generic login failures, and the lecture-14 mock-provider lab (transient, permanent, slow, ambiguous reply, crash after send; stable idempotency key; bounded BullMQ backoff). Two real gaps remained: (1) any PostgreSQL failure, including "database unreachable", answered 500, which tells clients and load balancers "bug" rather than "try again later"; (2) only a single `/health` existed, which cannot say whether the instance can do its essential work.

## Options
1. Keep 500 for everything unexpected. Simple, but loses the retryable/non-retryable distinction.
2. Add a typed error class thrown by every repository. Precise but touches every repository and misses driver-level errors thrown elsewhere.
3. Classify at the boundary with a predicate (`isDbUnavailable`) and answer 503 + `Retry-After`. Small, covers every route including ones added later.
4. Build a generic retry utility for HTTP-path calls. Rejected: there is no synchronous external call in the HTTP path, and the note says to reuse the lecture-14 retry lab and avoid nested retries.

## Decision
- Option 3. `isDbUnavailable` (db/pool.ts) matches network errno codes, SQLSTATE class 08 and 57P01/57P02/57P03/53300, AggregateErrors of those (localhost IPv4+IPv6), and pg-pool's connect timeout. Constraint violations (23xxx), syntax errors and programmer errors are NOT matched and stay 500 / mapped as before.
- `errorBoundary` moved to `http/error-boundary.ts`. 503 carries `Retry-After: 5`, `Cache-Control: no-store`, generic body. Both 500 and 503 bodies gain a top-level `requestId` (same value as the `X-Request-Id` header) — an additive change to the `{ "error": "..." }` contract; the nested envelope of the lecture's illustration was NOT adopted.
- `GET /health` is unchanged. New `GET /health/live` (process answers) and `GET /health/ready` (`SELECT 1` bounded to 1 s; 200 or 503). Readiness depends on PostgreSQL only; the optional Redis cache and the isolated queue Redis do not affect it.
- Not done: a pool-level `statement_timeout`, and a mapping of `40P01` deadlock/`40001` serialization failures to a retry (no code path currently needs it). Recorded as deferred.

## Trade-offs and consequences
- The connect-timeout case is detected by message text because pg-pool gives it no code; a pg upgrade could change the text. A test uses the real pool timeout so such a change fails loudly.
- The readiness timer only stops waiting; it cannot cancel work already in the driver. Probe volume is not rate-limited.
- `Retry-After: 5` is a fixed hint, not a measurement of recovery time.
- Public event detail can still be served from the Redis cache while PostgreSQL is down (lecture 13 behavior, observed in the live experiment). That is acceptable for browsing; inventory/authorization paths use uncached reads and fail with 503.
- The 500 body change forced two older tests (layers, postgres) to be updated: the DB-outage test previously asserted 500 and now asserts 503.

## Evidence
See the lecture note's implementation evidence: new `test/error-handling.test.ts` (10 tests) and a live stop/start of the local PostgreSQL container. Untested: real connection-pool exhaustion, deadlock retry, timeout after a committed write in the HTTP path.
