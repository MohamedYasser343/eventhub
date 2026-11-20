# ADR-010: REST collection contract for /api/v1/events

Status: Accepted (owner chose `totalPages`; remaining defaults proposed by the coding agent, owner may change them)
Date: 2026-11-20
Related lecture: [11 — REST API design](../lectures/11-rest-api-design.md)
Amends: [ADR-008](008-validation-policy.md) list-query policy (adds `limit`, `q`, `minSeats`, tie-break, `totalPages`).

## Context
Lecture 11 asks for a predictable, bounded event collection and documented CRUD semantics, reusing existing routes. The v1 list already had `sort`, `page`, `city` and a fixed page size of 10 with `meta.total`.

## Contract
| Route (under `/api/v1`) | Success | Failure |
| --- | --- | --- |
| `GET /events` | 200 `{data, meta}` (empty `data` is still 200) | 400 `errors[]` for invalid query |
| `GET /events/:id` | 200 (ETag, 304 on match) | 404 |
| `POST /events` | 201 + `Location` | 401, 403, 413/415/400 body problems, 422 invalid fields |
| `PUT /events/:id` | 200 full replacement | 401, 403, 404, 422 (no mutation) |
| `PATCH /events/:id` | 200, unspecified fields preserved | 401, 403, 404, 422 |
| `DELETE /events/:id` | 204, no body (admin only) | 401, 403, 404 |
| any other method | 405 + `Allow` | |

Query parameters of `GET /events` (all scalar: a repeated key is 400; unknown keys are ignored):

| Name | Default | Rule |
| --- | --- | --- |
| `page` | 1 | integer 1..999999999 |
| `limit` | 10 | integer 1..100; out of range is **rejected (400), not capped** |
| `sort` | `id` | `id\|name\|seats`, `-` prefix for descending; ties always broken by `id` ascending |
| `q` | none | case-insensitive substring of `name`, max 100 chars; empty matches all |
| `minSeats` | none | integer >= 0, at most 9 digits |
| `city` | none | echoed only; events have no city (kept from lecture 06) |

Pipeline: authorized scope (events are public, so all) -> filter -> sort (+id tie-break) -> slice -> serialize. `total` counts all matching events before slicing; `totalPages = ceil(total / limit)` (0 when empty). A page past the end is a valid query: 200 with `data: []`.

Response `meta`: `{page, pageSize, total, totalPages, sort, city, q, minSeats}` (`pageSize` equals the effective `limit`). The envelope keeps the existing `meta` object; additions are backward compatible, no consumer breaks. The legacy unversioned `/events` bare array is unchanged.

## Decisions and trade-offs
- Owner decision: expose `totalPages` (inside `meta`, not at top level as in the lecture's example, to keep the established envelope).
- Reject over cap: silent capping returns a different size than requested and hides client bugs; consistent with how `page` is already handled.
- Filters limited to existing fields (`q`, `minSeats`); no price/category/status invented.
- Offset pagination can shift under concurrent inserts/deletes and deep offsets would be costly in SQL; cursor pagination is deferred.
- Custom action `POST /events/:id/publish` NOT implemented: events have no lifecycle/status field. If added later, it should be a POST action (not PATCH) because it would carry server-side rules. A cancellation with side effects (bookings, refunds) would be modelled the same way; deferred with booking/payment work.
- `PATCH` and `POST` are not idempotent by HTTP definition; a PATCH with a fixed value happens to be. Idempotency keys for booking are deferred.
- No versioning change: no breaking change was made.
