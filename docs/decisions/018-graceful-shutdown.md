# ADR-018: Bounded, idempotent graceful shutdown for the API and the worker

Status: Proposed (implemented; awaiting owner confirmation)
Date: 2026-11-25
Related lecture: [19 — Graceful Shutdown](../lectures/19-graceful-shutdown.md)

## Context
The API (`src/server.ts`) had no signal handling: SIGTERM or Ctrl+C killed it mid-request. The worker (`src/jobs/worker-main.ts`) handled both signals but had no deadline, no guard against a second signal, and called `process.exit(0)` whatever the cleanup did. The API and the worker are separate OS processes with separate resources.

## Options
1. Do nothing; rely on the supervisor's SIGKILL. Rejected: in-flight requests are cut for no reason.
2. Handle signals separately in each entry point. Rejected: the deadline, repeat-signal and failure rules would drift apart.
3. One small coordinator (`src/lifecycle/shutdown.ts`) that both entry points configure with their own ordered steps. Chosen.

## Decision
- **Sequence** = enter draining -> run steps in dependency order, each awaited -> `exit(code)` only after the cleanup. SIGINT and SIGTERM run the same sequence. SIGKILL cannot be handled and is not pretended to be.
- **API order:** (optional `drain-delay`) -> `http-close` -> `cache-close` -> `postgres-pool-end` -> `telemetry-flush`. HTTP is stopped first because handlers use the cache and the pool; both are closed only after in-flight requests are gone. `pool.end()` waits for checked-out clients, so it is never raced against a handler.
- **Worker order:** `worker-close` (BullMQ stops fetching and waits for the active job) -> `postgres-pool-end`. The job handler uses PostgreSQL, so the pool outlives the worker. The demo's order (database first) was deliberately not copied.
- **Admission:** `server.close()` refuses new connections. A request that arrives on an already-open keep-alive connection after the signal gets 503 + `Connection: close` + `Retry-After`; requests accepted before the signal finish. Idle keep-alive sockets are closed by polling `closeIdleConnections()` so they cannot hold `close()` open for the keep-alive timeout.
- **Readiness:** `/health/ready` answers `503 {"status":"draining"}` once draining starts, without a database query. `/health` and `/health/live` are unchanged. `SHUTDOWN_DRAIN_DELAY_MS` (default 0, off) keeps the listener open that long so a load balancer can see "not ready" before the socket disappears; it must be smaller than the deadline.
- **Deadline:** `SHUTDOWN_TIMEOUT_MS` (default 10000, 1..600000) bounds the whole sequence, API and worker alike. When it fires: log `shutdown.deadline_exceeded` naming the pending step, run `onDeadline` (API: `closeAllConnections()`, so the client sees a reset), exit 1. A timer only stops waiting; the explicit socket destroy is what actually ends the stuck request. Worker: nothing is force-cancelled; the job stays active in Redis, its lock expires and stalled-job recovery re-runs it, the same path as SIGKILL (ADR-013). This value is the application budget; the supervisor's termination grace period (not configured by this repo) must be larger.
- **Repeated signals:** the first starts the sequence; later ones are logged (`shutdown.signal_ignored`) and ignored. Escalation is the deadline, not a second signal.
- **Failures:** a throwing step is logged by step name and error CLASS only (never the message), later steps still run, the exit code is 1.
- **Why `process.exit` at the end:** after the awaited cleanup it is safe and deterministic (telemetry timers would otherwise keep the loop alive). It is injected (`exit` option) so tests observe the code. It is never called from the signal callback.
- **Logs:** `lifecycleLog` writes shutdown lines even when `LOG_REQUESTS=0` (it borrows the sink for one synchronous call; request logs stay off).
- `Cache` gained an optional `close()`; `RedisCache.close()` now sends QUIT with a bounded wait and falls back to `destroy()`.

## Trade-offs and consequences
- Graceful shutdown is not crash safety: SIGKILL, OOM and power loss skip it. Duplicate effects after a lost response still need idempotency keys; EventHub has no booking flow yet, so that part is not implemented here (note's out-of-scope list).
- A request that connects in the instant between the signal and the listener closing may be reset instead of getting a 503.
- Long-lived upgraded sockets (WebSocket) are not handled: EventHub has none.
- The default 10 s is a choice, not a measurement.

## Evidence
`backend/test/shutdown.test.ts` (23 tests; coordinator unit tests, in-process HTTP, real spawned API, worker and isolated slow-server processes). See the lecture note's implementation evidence for commands and results.
