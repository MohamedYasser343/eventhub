# ADR-022: Bookings via an atomic conditional decrement in PostgreSQL

Status: Proposed (awaiting owner confirmation)
Date: 2026-11-28
Related lecture: [23 — Concurrency & Parallelism](../lectures/23-concurrency-parallelism.md)

## Context
`POST /api/v1/bookings` was a 501 stub, so the last-ticket race of the lecture could only be shown in the isolated lecture 12 lab. Several API processes now share PostgreSQL (lecture 22), so a process-local lock cannot protect stock. The owner approved a minimal booking route (2026-11-28) instead of a lab-only exercise.

## Options
1. Read stock, check in the application, write back (rejected: lost updates, kept as the lecture 12 negative control).
2. In-process mutex (rejected: invisible to a second API process).
3. `SELECT ... FOR UPDATE` then update: correct, but two statements and a longer lock.
4. Serializable transactions with retries: correct, adds a retry policy that is out of scope.
5. **One `UPDATE events SET seats = seats - $q WHERE id = $1 AND seats >= $q RETURNING seats`, then `INSERT INTO bookings`, in one transaction on one connection** (chosen).

## Decision
- `POST /api/v1/events/:id/bookings`, authenticated, body `{ "quantity"?: 1..10 }` (default 1). Buyer id comes from the session only.
- 201 booked, 404 no such event, 409 `SOLD_OUT` (an expected outcome, not an error), 422 invalid quantity, 400/415/413 body problems, 401 unauthenticated.
- Inventory stays `events.seats` (already `CHECK seats >= 0`); migration 007 adds `bookings` (`quantity` 1..10 checked). The legacy `POST /bookings` stub is untouched.
- The cached public event is invalidated after COMMIT.
- A test-only fault hook (`afterDecrement`) in the repository proves the rollback; it is never wired from config or requests.

## Trade-offs and consequences
- Concurrent buyers of one event serialize on that row's lock (throughput on a hot event is bounded by it); different events do not contend.
- A client that times out cannot know whether it booked. There is **no idempotency key**: a retry books again. Deferred.
- `events.seats` is "seats still available"; a PUT/PATCH of `seats` by an organizer overwrites it (no separate capacity column). Deferred.
- Deleting an event cascades its bookings (learning simplification; refund policy is deferred).
- Not implemented: payments, reservation expiry, cancellation, "unpublished" events (no such state exists).

## Evidence
`test/bookings.test.ts` (see the lecture 23 note): 100 buyers / 10 seats through one process and through two processes, rollback, negative cases. Pool-level lab from lecture 12 unchanged.
