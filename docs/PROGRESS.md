# Progress tracker

Last updated: 2026-11-22.

## Current state
- Repository initialization: documentation foundations prepared.
- Learning: lectures 05–13 complete (05–06 confirmed 2026-11-16; 07–08 confirmed 2026-11-19; 09–11 confirmed 2026-11-20; 12 documented by explicit GitHub upload request 2026-11-21; 13 documented by explicit GitHub upload request 2026-11-22); reference notes for 01–04 prepared, completion not confirmed.
- Implementation: lecture 10 complete (owner confirmed 2026-11-20). Lecture 05 complete (owner confirmed 2026-11-18; endpoints, CORS, ETag and experiments demonstrated; optional gzip deferred; ADR-001 to ADR-004).
- Next learning milestone: playlist position 14 (queues/background work; scope to verify). Lecture 11 implementation complete (owner confirmed 2026-11-20; ADR-010). Next implementation milestone: lecture 12 (needs owner approval).
- Implementation: lecture 06 complete (owner confirmed 2026-11-18; router, v1 routes, collision experiment, edge cases; ADR-005).
- Implementation: lectures 07 and 08 complete (owner confirmed 2026-11-19; ADR-006, ADR-007). Lecture 09 complete (owner confirmed 2026-11-20; ADR-008) on branch `feat/lecture-09-validation`, PR #5.
- Backend language: Node/TypeScript, native `node:http`, `tsx` dev runner ([ADR-001](decisions/001-backend-language-and-tooling.md)).
- Frontend: deferred until backend curriculum completion and explicit owner approval.
- Lectures 07 and 08 implemented on branches `feat/lecture-07-serialization` and `feat/lecture-08-auth`, confirmed by the owner; JWT lab done (`jose` added).
- Tests/benchmarks: `npm test` 198/198 passing and `npm run typecheck` clean; no benchmarks.

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
| 7 | Complete | Complete | [Serialization and Deserialization](lectures/07-serialization.md), 2026-11-19; process isolation, lossy JSON and performance trade-offs discussed; transcript not independently reverified during documentation. | [Evidence](lectures/07-serialization.md#implementation-evidence-coding-agent-complete) |
| 8 | Complete | Complete | [Authentication and authorization](lectures/08-authentication-authorization.md), 2026-11-19; stale JWT claims and revocation trade-offs discussed; full transcript not reviewed. | [Evidence](lectures/08-authentication-authorization.md#implementation-evidence-coding-agent-complete) |
| 9 | Complete | Complete | [Validation & Transformation](lectures/09-validation-transformation.md), 2026-11-20; source-of-truth and stale price discussion recorded; full transcript not independently reverified. | [Evidence](lectures/09-validation-transformation.md#implementation-evidence-coding-agent-complete) |
| 10 | Complete | Complete | [What are controllers, services, repositories, middlewares and request context?](lectures/10-application-layers.md), 2026-11-20; cancellation authorization discussion recorded; original transcript not directly reviewed. | [Evidence](lectures/10-application-layers.md#implementation-evidence-coding-agent) |
| 11 | Complete | Complete | [Complete REST API Design](lectures/11-rest-api-design.md), 2026-11-20; third-party transcript/notes reviewed; PATCH idempotency clarification; no open learner questions recorded. | [Evidence](lectures/11-rest-api-design.md#implementation-evidence-coding-agent), ADR-010 |
| 12 | Complete | Not started | [Mastering Databases with Postgres](lectures/12-mastering-databases-postgres.md), 2026-11-21; discussion and assignment documented; original full transcript not independently reviewed. | — |
| 13 | Complete | Not started | [Caching, the Secret Behind It All](lectures/13-caching.md), 2026-11-22; learning discussion, source limitations and assignment documented; original full video not independently reviewed. | — |
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
