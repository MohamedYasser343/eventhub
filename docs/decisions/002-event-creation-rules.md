# ADR-002: Event creation rules (POST /events)

Status: Accepted
Date: 2026-11-18
Related lecture: [05 — HTTP](../lectures/05-http.md)

## Context
Lecture 05 requires `POST /events` that rejects invalid input before mutating state, distinguishes malformed JSON, unsupported media type and semantic errors, and returns `201` with `Location`. The body is read from a stream, so an unbounded read could exhaust memory.

## Options
- Invalid-but-parseable data: 422 vs a single 400.
- Limits: minimum rules only vs explicit upper bounds.
- Body size: unbounded vs capped.
- IDs: monotonic counter vs `max(id)+1`.

## Decision
Owner chose:
- Malformed JSON -> 400; unsupported or missing `Content-Type` -> 415; valid JSON failing validation -> 422 with a `details` list.
- `name`: string, 1-100 characters after `trim()` (100 inclusive: "under 100" was read as a limit of 100), stored trimmed. `seats`: integer 0-100000.
- Body cap 16 KB -> 413 with `Connection: close`, enforced both from `Content-Length` and while streaming (no `Content-Length`).
- IDs come from a monotonic counter and are never reused. Client-supplied `id` and unknown fields are ignored, not rejected.
- Success: 201, `Location: /events/<id>`, JSON body of the created event.

## Trade-offs and consequences
- 422 requires clients to handle one more status, but separates "cannot parse" from "cannot accept".
- Ignoring unknown fields is lenient; a strict mode would return 422 and can be adopted later.
- A counter never reuses ids, at the cost of gaps; it resets on restart because storage is in memory.
- Name length counts UTF-16 code units, not user-perceived characters.
- Check order is 415, 413 (declared), body read, 400, 422, then mutation, so invalid input never mutates.

## Evidence
See step 4 in the lecture note: tests and curl output.
