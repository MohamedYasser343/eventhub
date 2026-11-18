# Progress tracker

Last updated: 2026-11-18.

## Current state
- Repository initialization: documentation foundations prepared.
- Learning: lectures 05–06 complete (owner confirmed 2026-11-16); reference notes for 01–04 prepared, completion not confirmed.
- Implementation: lecture 05 complete (owner confirmed 2026-11-18; endpoints, CORS, ETag and experiments demonstrated; optional gzip deferred; ADR-001 to ADR-004).
- Next learning milestone: playlist position 7 (provisional: Serialization; verify actual video title and scope).
- Implementation: lecture 06 complete (owner confirmed 2026-11-18; router, v1 routes, collision experiment, edge cases; ADR-005).
- Next implementation milestone: lecture 07 — Serialization; not started, needs owner approval.
- Backend language: Node/TypeScript, native `node:http`, `tsx` dev runner ([ADR-001](decisions/001-backend-language-and-tooling.md)).
- Frontend: deferred until backend curriculum completion and explicit owner approval.
- Tests/benchmarks: `npm test` 101/101 passing and `npm run typecheck` clean; no benchmarks.

## Milestones
Track learning and implementation independently. Status values: not started, in progress, blocked, awaiting learner review, complete. Learning marked complete means the owner confirmed the session and its notes were documented; implementation marked complete means the assignment has demonstrated acceptance criteria and owner confirmation. Neither implies the other.
| Position | Learning status | Implementation status | Learning note / evidence | Implementation evidence |
| --- | --- | --- | --- | --- |
| 1 | Not confirmed | Not confirmed | [Roadmap](lectures/01-roadmap.md) — reference | — |
| 2 | Not confirmed | Not confirmed | [Learning approach](lectures/02-learning-approach.md) — reference | — |
| 3 | Not confirmed | Not confirmed | [What is a backend?](lectures/03-what-is-a-backend.md) — reference | — |
| 4 | Not confirmed | Not confirmed | [First principles benefits](lectures/04-first-principles-benefits.md) — reference | — |
| 5 | Complete | Complete | [Understanding HTTP](lectures/05-http.md), 2026-11-16; no open technical questions recorded; full transcript unverified. | [Evidence: steps 1-9](lectures/05-http.md#step-1--server-and-health-2026-11-18) |
| 6 | Complete | Complete | [Routing](lectures/06-routing.md), 2026-11-16; Express/Laravel matching discussion recorded; full transcript unavailable. | [Evidence](lectures/06-routing.md#implementation-evidence-coding-agent-complete) |
| 7 | Not started | Not started | — | — |
| 8 | Not started | Not started | — | — |
| 9 | Not started | Not started | — | — |
| 10 | Not started | Not started | — | — |
| 11 | Not started | Not started | — | — |
| 12 | Not started | Not started | — | — |
| 13 | Not started | Not started | — | — |
| 14 | Not started | Not started | — | — |
| 15 | Not started | Not started | — | — |
| 16 | Not started | Not started | — | — |
| 17 | Not started | Not started | — | — |
| 18 | Not started | Not started | — | — |
| 19 | Not started | Not started | — | — |
| 20 | Not started | Not started | — | — |
| 21 | Not started | Not started | — | — |
| 22 | Not started | Not started | — | — |
| 23 | Not started | Not started | — | — |
| 24 | Not started | Not started | — | — |
| 25 | Not started | Not started | — | — |
| 26 | Not started | Not started | — | — |
| 27 | Not started | Not started | — | — |
| 28 | Not started | Not started | — | — |
| 29 | Not started | Not started | — | — |
| 30 | Not started | Not started | — | — |
| Remaining curriculum | Not started | Not started | Verify playlist. | — |
| Frontend | N/A | Not started | — | Deferred. |
| Full-stack deployment | N/A | Not started | — | Deferred. |

## Update protocol
ChatGPT: upon explicit lecture completion, record title, link, date, learning note path, open conceptual questions and learning status in the same documentation commit to main; preserve implementation status. Coding agent: record implementation changes, test commands, observed results, commit references, open issues and implementation status; preserve learning status. Use repository-relative evidence links or known prior commit references (do not require a commit to contain its own SHA). Track next learning and implementation milestones independently and never infer completion without evidence and owner confirmation. No performance claims without measurements.
