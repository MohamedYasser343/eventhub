# ADR-003: PUT and DELETE semantics for /events/:id

Status: Accepted
Date: 2026-11-18
Related lecture: [05 — HTTP](../lectures/05-http.md)

## Context
Lecture 05 requires `PUT /events/1` (replace, 404 if absent in this exercise) and `DELETE /events/1` (204 without body, 404 if absent). The request carries the id both in the URL and, potentially, in the body.

## Options
- Body `id`: ignore, or reject a mismatch with 422.
- Order for a missing event with an invalid body: 404 first, or validate first.
- `DELETE` with a body: ignore, or reject with 400.

## Decision
Owner chose:
- PUT replaces the whole event: `name` and `seats` required, same rules as POST ([ADR-002](002-event-creation-rules.md)). The URL id wins; an `id` in the body is ignored. Success is 200 with the stored event.
- Existence is checked before the body is read: a missing event returns 404 whatever the body contains. PUT never creates (no upsert).
- DELETE returns 204 with no body, 404 if absent, and ignores any request body.
- Unsupported methods on `/events/:id` return 405 with `Allow: GET, PUT, DELETE`.

## Trade-offs and consequences
- 404-first means a client does not learn about validation problems until the event exists, and the server does not spend time reading a body for a resource that is absent.
- When a body was sent but ignored (DELETE, PUT on a missing event), the response carries `Connection: close` so an unread, possibly large body is not drained on a keep-alive connection.
- PUT is idempotent in effect (same state after repeats); DELETE is idempotent in effect even though the status changes from 204 to 404.
- No optimistic concurrency (`If-Match`): concurrent PUTs are last-writer-wins. Deferred.
- The event is looked up again after the body is read, since the store may change while waiting.

## Evidence
See step 5 in the lecture note.
