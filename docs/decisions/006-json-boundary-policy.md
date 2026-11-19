# ADR-006: JSON request boundary policy

Status: Accepted (implementation awaiting owner review)
Date: 2026-11-19
Related lecture: [07 — Serialization](../lectures/07-serialization.md)

## Context
`readBody`/`readJson` already bounded bodies and separated 400/413/415/422. Gaps found: invalid UTF-8 was silently turned into U+FFFD, `Content-Encoding` was ignored, a non-UTF-8 `charset` was accepted, and an aborted upload could leave the read promise pending.

## Decision
- Helpers moved to `backend/src/json.ts` (needed again by lecture 08 auth routes); `server.ts` keeps `sendJson` and the response mapping. Event contract, status codes and the 16 KiB limit are unchanged.
- Bytes are collected first and decoded once, so a character split across chunks is safe.
- Strict decoding: invalid UTF-8 gives 400 (not repaired). A leading BOM is rejected (400): RFC 8259 forbids it on the wire.
- `Content-Type` must be `application/json`; a `charset` parameter other than utf-8 gives 415.
- `Content-Encoding` other than absent/`identity` gives 415; compressed request bodies are not supported.
- An aborted request body rejects `readBody` (via `close` before `end`); the generic 500 handler absorbs it.
- Response projection stays explicit (`{id, name, seats}`); unknown input fields are dropped.

## Trade-offs
Rejecting a BOM is stricter than some parsers. No request decompression means clients cannot gzip uploads (also avoids decompression-bomb handling). No Protobuf or format migration.
