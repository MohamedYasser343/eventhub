# ADR-004: HEAD, OPTIONS, CORS and ETag

Status: Accepted
Date: 2026-11-18
Related lecture: [05 — HTTP](../lectures/05-http.md)
Amended by: [ADR-005](005-router-and-api-versioning.md) (`Allow` is derived from registered routes; v1 adds PATCH and more OPTIONS paths), [ADR-007](007-authentication-and-authorization.md) (preflight also allows `Authorization`).

## Context
Lecture 05 asks for HEAD and OPTIONS on `/events`, browser CORS limited to a stated test origin, and an ETag validator on one event GET. The API is meant to be called from a browser page on a different port.

## Options
- CORS origin: one fixed test origin vs `*` vs reflecting the request origin.
- ETag: strong hash of the body vs a version counter; `/events/:id` only vs also the list.
- Optional gzip (assignment step 7): implement vs defer.

## Decision
Owner chose:
- One allowed origin, `http://localhost:3000` (override with `CORS_ORIGIN`), matched exactly. Other origins get no `Access-Control-*` headers; the server still answers them and the browser enforces the denial.
- Strong ETag: quoted, first 32 hex chars of SHA-256 of the JSON body, on `GET`/`HEAD /events/:id` only. `If-None-Match` supports `*`, lists and weak (`W/`) comparison. A match returns 304 with the `ETag` and no body. Also sent: `Cache-Control: no-cache`.
- gzip is deferred (optional, not a completion gate).

Implementation choices that follow:
- HEAD is served by the GET code path on every readable resource; Node discards the body, so status and headers (including `Content-Length`) equal GET's.
- OPTIONS (204 + `Allow`) is answered on `/events` and `/events/:id` so preflights for POST/PUT/DELETE succeed. `/health` has no OPTIONS.
- Every response carries `Vary: Origin`; the allowed origin additionally gets `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: Location, ETag`, so browser code can read them, also on error responses.
- A preflight from the allowed origin gets `Allow-Methods` (that resource's list, only if the requested method is in it), `Allow-Headers: Content-Type, If-None-Match` (now also `Authorization`, ADR-007), `Max-Age: 600`. A rejected origin or an unsupported requested method gets 204 and no approval headers.
- `Allow` lists: collection `GET, HEAD, POST, OPTIONS`; item `GET, HEAD, PUT, DELETE, OPTIONS`; health `GET, HEAD`.

## Trade-offs and consequences
- `If-None-Match` is not a CORS-safelisted header, so a browser conditional GET triggers a preflight. The first browser run failed because only `Content-Type` was approved; adding `If-None-Match` fixed it (see evidence).
- CORS is not authentication: it only constrains browsers. `curl` and other servers ignore it. Rejected-origin simple requests (for example GET) still execute on the server; only reading the response is blocked, so CORS does not protect state-changing simple requests. Non-simple requests (JSON POST, PUT, DELETE) are stopped at the preflight.
- No credentials mode and no wildcard. Supporting several origins would need an allow-list and the `Vary: Origin` handling already in place.
- The hash is computed on every GET (cheap for tiny events). ETag on the list is not provided; weak validators are accepted on input but never issued.
- `Cache-Control: no-cache` means "store but revalidate", so browsers send conditional requests on their own.

## Evidence
See steps 6-9 in the lecture note: tests, curl output, browser runs from the allowed and the rejected origin.
