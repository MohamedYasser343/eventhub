# ADR-005: Handwritten router, v1 prefix and legacy routes

Status: Accepted
Date: 2026-11-18
Related lecture: [06 — Routing](../lectures/06-routing.md)

## Context
Lecture 05 left `handle()` as an if-chain on `pathname`. Lecture 06 asks for registered routes, parameters, grouping, a `/api/v1` prefix and explicit collision rules, with no framework.

## Decision
- `backend/src/router.ts` is a pure router: `(method, pathname)` in, a decision out (`match`, `method-not-allowed`, `not-found`, `bad-request`). It needs no database and knows nothing about HTTP objects.
- Routes are tried in registration order; the first path+method match wins. Collisions are prevented twice: static routes are registered before dynamic ones, and `:id` carries a constraint (`/^[1-9][0-9]*$/`).
- The `Allow` header (405 and OPTIONS) is derived from the routes registered for the path (canonical order), not hard-coded. HEAD is served by the GET route.
- Policy: split on `/` first, percent-decode each segment once; malformed escapes give 400; `%2F` stays inside one segment; case-sensitive; no trailing-slash or empty-segment normalisation (404). `//x` is still a path, not a host (lecture 05 fix kept).
- Query never takes part in matching. Keys map to value lists; `scalar()` rejects a repeated key (400). v1 list: `sort` in `id|name|seats` with optional `-`, `page` a positive integer (page size 10), `city` accepted and echoed but not filtered (events have no city). Invalid values give 400.
- Legacy unversioned routes (`/health`, `/events`, `/events/:id`) are kept unchanged for lecture 05 clients and tests. `/api/v1` adds: list with query, `/events/search`, `PATCH /events/:id`, `/events/:id/tickets`, `POST /bookings` (stub, 501). `/api/v2` is not implemented: plain 404. `Location` after POST carries the route prefix.
- `PATCH` exists on v1 only, so the legacy `Allow` lists (and their tests) stay as ADR-004 recorded. `PUT` stays (ADR-003).
- Wildcard (`/files/*`) is supported by the router and demonstrated only in unit tests; it is not exposed by the server. It needs one or more segments and must be registered last.

## Trade-offs and consequences
- Ordered scan is O(routes) per request; fine for ~25 routes, not measured, no trie.
- Two route tables (legacy and v1) share handlers; removing legacy later is a one-line change plus tests.
- Static segments compare after decoding, so `/%65vents` equals `/events`. Wildcard values are decoded segments joined by `/`: never use them as a filesystem path unchecked.
- The new `/events/:id` constraint makes `/events/abc` a routing miss (404) instead of a handler miss; the observable status is the same.

## Evidence
See the implementation evidence section of the lecture note.
