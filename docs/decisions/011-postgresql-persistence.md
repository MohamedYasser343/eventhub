# ADR-011: PostgreSQL persistence for users and events

Status: Accepted (implementation awaiting owner confirmation)
Date: 2026-11-22
Related lecture: [12 - Mastering Databases with Postgres](../lectures/12-mastering-databases-postgres.md)

## Context
Events and users lived in process memory (ADR-001/007/009). Lecture 12 asks for durable storage behind the existing HTTP/auth/validation/layer contracts. The owner decided to persist **users as well as events** and to **remove the in-memory event repository**.

## Options
- Driver: `pg` (node-postgres) or `postgres.js`. Migrations: `dbmate` or a small SQL-file runner. Keep an in-memory repository as a test double or remove it.

## Decision
- `pg` with one bounded pool (max 10, 2 s connect timeout). The lecture's examples use `pool.query`, and it is the most documented driver.
- Forward-only numbered SQL files (`backend/migrations/NNN_name.sql`) applied by `src/db/migrate.ts`: one transaction per file, `schema_migrations` with checksum, advisory lock. Chosen because it shows the mechanism with no extra tool; a tool such as dbmate stays an option.
- `InMemoryEventRepository` and the in-memory user map are **removed**. Tests run against a real PostgreSQL `*_test` database (serial: `--test-concurrency=1`; setup refuses non-`_test` names).
- Tables: `users` (case-insensitive unique `lower(username)`, role CHECK) and `events` (owner FK `ON DELETE RESTRICT`, CHECKs on name length/blank and seats 0..100000, `updated_at` trigger). Kept the existing integer `seats`/`name` model; price, currency and time zone are not in the current domain and are deferred.
- `EventRepository` is now async (supersedes the "synchronous on purpose" note of ADR-009). Filter, sort and paging run in SQL; the sort column comes from an allowlist; name sort uses collation "C" for locale-independent order; total and page are read in one REPEATABLE READ snapshot.
- Sessions, the login rate limiter and synthetic tickets stay in memory (not persisted; documented). Role is still read from the database on every authenticated request.
- Candidate indexes `(seats, id)` and `(name COLLATE "C", id)` are **not** added to the schema: see Evidence. Decision left to the owner.

## Trade-offs and consequences
- Tests need Docker/Postgres; they are slower than the in-memory suite.
- PUT/PATCH are read-then-write: with real I/O between them a concurrent update can be overwritten (the old synchronous store hid this). Row locking or optimistic versions are deferred to the concurrency lecture.
- No `ON DELETE CASCADE`: deleting a user who owns events fails (23503) instead of silently erasing events.
- Existing failure behavior: any database error reaches the error boundary as a generic 500 (no SQL, host or credential text).
- Reversible: migrations are forward-only; rolling back means restoring a backup or writing a new migration.

## Evidence
`backend/test/postgres.test.ts` (constraints, binding, migrations, lab, restart), `docs/evidence/lecture-12-explain.txt` (single local run, 200k synthetic rows): the first page of `sort=seats`/`sort=name` went from ~18 ms (parallel seq scan + top-N sort) to ~0.02 ms (index scan); a 50k-row INSERT went from 360 ms to 602 ms with both indexes (one run each); the indexes cost 6 MB and 15 MB; the deep page (OFFSET 100000) improved from ~98 ms to ~26 ms but still reads 100k index entries. `sort=-seats` was not measured. At the current product size the indexes are unnecessary, so none is committed.
