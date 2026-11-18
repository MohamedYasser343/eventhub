# ADR-001: Backend language and tooling

Status: Accepted
Date: 2026-11-18
Related lecture: [05 — HTTP](../lectures/05-http.md)

## Context
The roadmap left the backend language undecided; TypeScript with native Node HTTP was the recommendation. Lecture 05's assignment needs a native HTTP server with in-memory data. Local environment: Node v24.22.1, npm 11.19.1.

## Options
- Go `net/http`.
- Node/TypeScript with the native `node:http` module, run by Node's built-in type stripping (no dependency).
- Node/TypeScript with `tsx` as a dev dependency.

## Decision
Owner chose Node/TypeScript with `node:http` (no web framework). For running TypeScript the owner chose `tsx` over Node's native type stripping, after being told Node 24 can run `.ts` directly and that `tsx` adds a dependency whose only visible benefit now is watch mode. Layout: single file `backend/src/server.ts` until a split is justified. Tests: built-in `node:test` plus manual `curl` experiments. Server binds `127.0.0.1`, port from `PORT` (default 8080).

## Trade-offs and consequences
- `tsx` and `typescript`/`@types/node` are dev dependencies only; no runtime dependency, no framework.
- `tsx` does not type-check; `typescript` is installed so `tsc --noEmit` can be added when wanted (not configured yet).
- Switching to native Node execution later is a small change (scripts only), so the decision is reversible.
- Binding to loopback keeps the learning server off the local network.

## Evidence
Lecture 05 step 1 verified: see implementation evidence in the lecture note.
