# ADR-009: Application layers, middleware pipeline and request context

Status: Accepted (owner confirmed, 2026-11-20)
Date: 2026-11-20
Related lecture: [10 — Application layers](../lectures/10-application-layers.md)

## Context
`server.ts` mixed HTTP handling, authorization, validation calls and store access in each handler, and `requireUser(req, res)` was called by hand at the top of every protected handler. There was no per-request state, no request id and only an opt-in one-line log.

## Decision
- **Service/repository for events.** `modules/events/service.ts` (`EventService`) holds the use cases and event authorization; it returns typed outcomes (`not-found`, `forbidden`, `invalid`) and never sees `req`/`res`. `modules/events/repository.ts` is the storage contract plus an in-memory implementation wrapping the existing `events` array and `eventOwners` map (the same objects earlier tests inspect). Controllers in `server.ts` are the only place outcomes become status codes. Dependencies are wired by hand in `server.ts` (no DI container).
- **Synchronous repository contract.** Kept sync on purpose: each in-memory call is atomic, which preserves the lecture 07 "re-read after the body arrived, no lost update" behaviour. An async/SQL implementation would need transactions (later lecture). The contract is a learning seam, not a guaranteed drop-in for SQL.
- **Pre-flight plus re-check.** The existing contract answers 404/403 *before* reading the body. The controller calls `authorizeEdit`/`canCreate` first; the mutating service methods re-check, so any other caller (CLI, job) cannot bypass the rule and a concurrent change is still caught.
- **Middleware runner** `http/middleware.ts`: ~15-line async onion `compose`; `next()` twice throws; a rejection propagates to the nearest upstream `try/catch`. Global: `observe` (request id, header, log) → `cors` → `errorBoundary`. Route-level: `requireAuth` (via `protect(handler)`), the only identity source. Public routes stay public. Role/ownership checks stay in the service (business authorization), not in middleware.
- **Request context** `http/context.ts`: fresh object per request (`requestId`, `startedAt`, `user`, `token`, `signal`), passed explicitly; no global user. `user` is set only by `requireAuth`.
- **Request id:** a client `X-Request-Id` is accepted only if it matches `^[A-Za-z0-9._-]{8,64}$`, otherwise a UUID is generated. Returned as `X-Request-Id` on every response (additive header).
- **Logging:** `LOG_REQUESTS=1` now prints one JSON line per response: `requestId, method, path (no query), status, durationMs, userId`. Never headers, query, bodies or error messages. **This changes the earlier plain-text log format** (it dropped `origin`).
- **Errors:** an exception becomes a fixed `500 {"error":"Internal Server Error"}`; if headers are already sent the response is just ended.
- **Cancellation policy** (`modules/bookings/cancellation-policy.ts`): pure function with an injected `now`; owner or admin, ≥ 24 h inclusive, admin overrides ownership/time but not a non-active booking. No endpoint (booking stays a 501 stub).
- **Abort signal** is created per request but not yet consumed by any operation.

## Amendment (2026-11-20): layers extended to the whole backend
Requested by the owner after review of PR #7.
- **Per-module controllers.** `modules/{events,auth,tickets}/controller.ts` are factories (`createXController(service)`) so dependencies are injected by hand. `server.ts` now only composes (builds repositories, services, controllers), registers routes and runs the pipeline. Shared HTTP plumbing (`RouteContext`, `sendJson`, `readJson`, error helpers, `createProtect`) lives in `http/app.ts`, so controllers never import `server.ts`.
- **Auth.** `AccountService` (`modules/auth/service.ts`) owns register/login/logout rules (username/password limits, role always `attendee`, rate-limit key, same outcome for unknown user and wrong password) and returns typed outcomes. `AuthService` in `auth.ts` stays the storage/crypto/session mechanism (users, scrypt, sessions, limiter) and plays the repository role; it was not split further to avoid churn in the lecture 08 code and tests.
- **Tickets.** `TicketRepository` wraps the existing map; `TicketService` has own-tickets, object-level ownership (foreign ticket = missing) and the synthetic per-event list (uses `EventService.get`).
- **Auth middleware is injected** (`createProtect(auth)`), not read from a module singleton.
- **Not layered, on purpose:** `/bookings` is still a 501 stub (no service/repository until booking is a real lecture); `validation.ts` stays a pure module used by services; CORS/OPTIONS stay in `server.ts` as pipeline infrastructure.
- No API, status, header or body changed; the 166 earlier tests pass untouched.

## Trade-offs
- Only events were moved; auth, tickets and validation stay as before (smallest representative slice).
- `protect()` wraps each handler in its own tiny `compose`; a shared route-middleware list on the router is a possible later step.
- Small behaviour difference: a 404 sent after the body was read (concurrent delete race) now also carries `Connection: close`.

## Evidence
`backend/test/layers.test.ts` plus the unchanged earlier suites. See the lecture note.
