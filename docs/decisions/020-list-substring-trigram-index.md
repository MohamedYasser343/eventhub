# ADR-020: Trigram index for the list filter `q`

Status: Proposed (awaiting owner confirmation)
Date: 2026-11-26
Related lecture: [21 — Backend Scaling & Performance (Part 1)](../lectures/21-backend-scaling-performance.md)

## Context
On a synthetic 300,000-row dataset, `GET /api/v1/events?q=<selective>` was the slowest measured path (p50 ≈ 540 ms, ≈19 successful req/s at 10 concurrent users). `EXPLAIN (ANALYZE, BUFFERS)` showed why: `position(lower($1) in lower(name)) > 0` cannot use any index, so the count was a parallel sequential scan (~55 ms) and the page query (`ORDER BY id LIMIT 10`) walked the primary-key index until it found matches (~116 ms for one match).

## Options
1. Do nothing (acceptable for a few thousand rows; not at 300k).
2. Pool tuning / more replicas: not supported by the evidence (the cost is CPU in the scan, not connection waits at 10 users).
3. Replace `position()` with an escaped `LIKE` and add a `pg_trgm` GIN index on `lower(name)` (chosen).
4. Route `q` through PostgreSQL full-text search: changes semantics (whole tokens, no partial words), rejected.

## Decision
Migration `004_event_name_trgm.sql` enables `pg_trgm` and creates `events_name_lower_trgm_idx`. The predicate becomes `lower(name) LIKE '%' || <escaped lower($1)> || '%'` where `\`, `%`, `_` are escaped in SQL so they stay literal, exactly as before. Same `lower()` on both sides, so case-folding does not change.

## Trade-offs and consequences
- Index size 53 MB on a 71 MB table; slower writes to `events.name`; requires the `pg_trgm` contrib extension (present in the official postgres images).
- Needles shorter than 3 characters cannot use the index; they stay correct and as slow as before.
- Broad needles (~12% of rows) gain little (see evidence): the planner still reads many rows.
- Reversible: `DROP INDEX events_name_lower_trgm_idx;` and the old predicate.

## Evidence
See the implementation evidence in lecture 21. Regression tests: `test/list-substring.test.ts` (literal `% _ \`, case, short needles, minSeats), full suite and typecheck.
