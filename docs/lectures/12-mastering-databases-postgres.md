# Video 12 — Mastering Databases with Postgres

- Video: https://www.youtube.com/watch?v=F7Vwp2Xo5Do
- Course: [Backend from First Principles — Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- Playlist position: **12** (video's numbered title corroborated by course index).
- Session/documentation date: **2026-11-21**.
- Learning status: **Complete — owner requested this GitHub documentation upload after the teaching session**.
- Implementation status: **Complete (owner confirmed 2026-11-22)**.
- Source availability: original YouTube video metadata and third-party transcript-derived chapter summaries confirm identity and broad subject matter; the **full original recording/transcript was not directly reviewed or verified end to end**. Sections marked *supplementary* explain additional database engineering and the EventHub domain. These are teaching notes, not a verbatim or timestamp-perfect transcript. No EventHub tests, benchmarks or migrations were executed as part of this documentation update.

## Learning objectives

After this lesson, independently explain:

1. Why data persistence, DBMSs and concurrent access matter beyond saving JSON files.
2. How PostgreSQL fits between the application, memory, durable files and the write-ahead log (WAL).
3. How relational modeling, primary/foreign keys, uniqueness, checks and normalization prevent invalid data.
4. Why choosing types such as INTEGER, BIGINT, UUID, NUMERIC, TEXT, JSONB and TIMESTAMPTZ is a domain decision.
5. How migrations and seed data support safe, repeatable schema evolution.
6. How CRUD, joins, CTEs, sorting and filtering are executed; why SQL specifies *what* is requested, while the query planner chooses *how*.
7. What an index accelerates, why it costs storage and write work, and how to inspect plans before claiming gains.
8. Why parameters protect SQL value boundaries and what they cannot parameterize.
9. Where database triggers help and where they conceal business behavior.
10. *(Supplementary)* How transactions, integrity and atomic updates protect ticket inventory under concurrent requests.

## Concepts and internal mechanisms

### 1. Persistence: start with the failure

An EventHub endpoint could initially store bookings in a process-local array. A restart loses that state. Writing JSON to disk adds persistence, but creates other problems: multiple writers, conflicting updates, partial writes, data validation, arbitrary queries, access control, crash recovery and backups. It is possible to solve these independently, but this reconstructs increasingly large parts of a database system.

A **database** is the organized data; the **database management system (DBMS)** is the software that stores, queries, protects and coordinates it. Examples include PostgreSQL and MySQL (relational) and MongoDB (document-oriented). SQLite is also a relational DBMS, although commonly embedded in the application rather than accessed as a separate database server.

~~~mermaid
flowchart TD
  HTTP[EventHub HTTP request] --> C[Controller and service]
  C --> R[Repository or database adapter]
  R --> PG[PostgreSQL DBMS]
  PG <--> BUF[Buffer pages in RAM]
  PG --> WAL[Write-ahead log]
  PG <--> DATA[(Durable database files)]
~~~

**Behind the scenes:** PostgreSQL uses cached shared buffers and operating-system facilities rather than reading every page from disk for every query. Changes and recovery are coordinated through WAL and data-file management. Durability has concrete configuration, storage and hardware assumptions; a cache hit is not proof that data is safely persisted.

**Why files alone are difficult:** two requests can each read the same available-ticket count, calculate a new count and overwrite each other's work. This is a **lost update** race.

~~~mermaid
sequenceDiagram
  participant A as Buyer A
  participant F as Shared JSON file
  participant B as Buyer B
  A->>F: Read available=10
  B->>F: Read available=10
  A->>F: Write available=9
  B->>F: Write available=9
  Note over F: Two bookings, but only one ticket deducted
~~~

A DBMS gives us tools such as constraints, locking, isolation and atomic statements; it does **not** automatically make arbitrary multi-statement application logic race-free.

### 2. SQL vs NoSQL and why PostgreSQL

**Relational databases** organize rows into tables and use keys/constraints for relationships. **Document databases** store documents with flexible structure, sometimes embedding related values. Other NoSQL systems include key-value, graph and wide-column stores; "NoSQL" is not one consistency or transaction model.

| Question | Relational PostgreSQL | Document-oriented alternative |
| --- | --- | --- |
| Natural representation | Tables, rows and relations | Documents and references/embedding |
| Data integrity | Strong relational constraints and transactions | Depends on database and model |
| Evolving fields | Migrations; optional JSONB | Often flexible document fields |
| Related reads | Joins | Embedding, references and/or aggregation |
| Trade-off | Up-front schema reasoning | Duplication and cross-document invariants may need extra care |

PostgreSQL is a sound default for event bookings where ownership, uniqueness, capacity and transactional correctness matter. PostgreSQL also supports **JSONB**, so some flexible event metadata does not require a second database. Use JSONB deliberately: data with important independent relationships and constraints often deserves columns or separate tables.

**Do not infer:** SQL always scales better, NoSQL cannot do transactions, or using two database engines is needed for a small project.

### 3. Data types express guarantees and costs

| Type | Typical use | Reasoning |
| --- | --- | --- |
| SMALLINT / INTEGER / BIGINT | Counts, IDs and quantities | Different value ranges and storage size |
| NUMERIC(p,s) | Exact decimal amounts | Avoids binary floating-point rounding |
| REAL / DOUBLE PRECISION | Approximate numerical calculations | Floating-point values can be inexact |
| BOOLEAN | Flags | Explicit true/false state |
| TEXT / VARCHAR | Textual fields | Constraints matter more than arbitrary VARCHAR lengths |
| UUID | Distributed identifiers | Stable 128-bit IDs, larger than many integer keys |
| JSONB | Optional flexible structured metadata | Efficient querying/indexing with its own trade-offs |
| TIMESTAMPTZ | A real instant | Stored normalized; displayed in session time zone |

**Money example:** in JavaScript, 0.1 + 0.2 is not exactly 0.3 in binary floating-point. PostgreSQL NUMERIC can preserve decimal precision. **EventHub's existing product specification chooses integer minor units plus currency**, so a price might be price_minor=12500 with currency='EGP', representing EGP 125.00 when that currency uses two decimal places. Follow the established domain decision rather than silently replacing it with NUMERIC. NUMERIC is an alternative when suitable.

**Time zone example:** TIMESTAMPTZ records an instant, not the original IANA zone name. Store an event's zone separately, e.g. Africa/Cairo, where calendar rules and original local event scheduling matter. Avoid manually shifting UTC timestamps to guess local time.

**IDs:** sequential integers are compact and simple; UUIDs can be generated without coordination but cost more space and can have index-locality trade-offs. UUID is **not authorization**: every object access still requires an ownership/permission check.

### 4. Modeling: entities, relationships and constraints

For teaching, start with three small tables: users, events and bookings. An organizer can have many events; a user can have many bookings; an event can have many bookings. Bookings join the user and event domains.

~~~mermaid
erDiagram
  USERS ||--o{ EVENTS : organizes
  USERS ||--o{ BOOKINGS : makes
  EVENTS ||--o{ BOOKINGS : has
  USERS {
    bigint id PK
    text email UK
    text name
  }
  EVENTS {
    bigint id PK
    bigint organizer_id FK
    text title
    bigint price_minor
    text currency
    int available_tickets
  }
  BOOKINGS {
    bigint id PK
    bigint user_id FK
    bigint event_id FK
    text status
    timestamptz created_at
  }
~~~

**Illustrative SQL, not the current verified EventHub schema:**

~~~sql
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL,
  available_tickets INTEGER NOT NULL CHECK (available_tickets >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  event_id BIGINT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
~~~

These tables **do not implement the final product model**: reservation expiry, quantities, ticket types, capacity accounting, payment simulation, issuance and cancellation are future work or explicit design decisions. The model is a conceptual minimum for the lesson and must be aligned with whatever entities already exist in the actual code.

**Constraints as a second correctness boundary:**

- PRIMARY KEY uniquely identifies a row; NOT NULL rules out absence.
- FOREIGN KEY prevents references to missing parents (subject to the selected deletion/update rule).
- UNIQUE rejects duplicate values under the defined index/operator and NULL semantics.
- CHECK enforces a predicate such as available_tickets >= 0; remember that a CHECK whose expression evaluates to NULL is not rejected, so combine with NOT NULL when needed.
- HTTP validation provides readable client errors; database constraints protect integrity even if writes arrive from scripts, migrations or another service.

Design deletion behavior deliberately: RESTRICT/NO ACTION, CASCADE and SET NULL can have very different consequences for reservations and audit trails. Never cascade-delete historical bookings without an approved domain policy.

### 5. Normalization and historical snapshots (supplementary)

If each booking redundantly stores a user's current email, a user email change requires multiple updates and can create inconsistencies. Reference user_id instead; join when reading.

But **not all duplication is a mistake**: the booking may need a snapshot of the price and currency the user actually agreed to, since the current event price may change. Distinguish mutable reference data from immutable business facts.

### 6. Migrations and seeding

A **migration** is a versioned schema transition so developers and deployment environments can move predictably between schema versions. A **seed** adds initial, sample or test data. The lecture uses the concept of migrations and seeding; tools such as dbmate are options, not mandatory architectural requirements.

~~~mermaid
flowchart LR
  V1[(Schema v1)] -->|001 create events| V2[(Schema v2)]
  V2 -->|002 add description| V3[(Schema v3)]
  V3 --> DEV[Development]
  V3 --> STAGE[Staging]
  V3 --> PROD[Production after safe rollout]
~~~

Illustrative SQL migration:

~~~sql
-- Up
ALTER TABLE events ADD COLUMN description TEXT;

-- Down (may destroy values stored in this column)
ALTER TABLE events DROP COLUMN description;
~~~

A down migration that recreates a dropped column cannot resurrect discarded content. For production, schema changes should consider existing rows, locks, compatibility across deployed application versions, backfills and rollback/recovery plans. Test migrations on disposable local data first. Never include secrets or real user data in seed files.

### 7. CRUD, joins, sorting and CTEs

CRUD corresponds to create, read, update and delete; SQL includes INSERT, SELECT, UPDATE and DELETE.

To list bookings with the associated attendee and event:

~~~sql
SELECT b.id, u.name AS attendee, e.title AS event_title
FROM bookings AS b
JOIN users AS u ON b.user_id = u.id
JOIN events AS e ON b.event_id = e.id
WHERE e.id = $1
ORDER BY b.created_at DESC, b.id DESC
LIMIT $2;
~~~

**INNER JOIN** returns matching records; **LEFT JOIN** retains all rows from the left input and fills unmatched right columns with NULL. RIGHT JOIN and FULL OUTER JOIN have their own preservation rules. A join is not automatically cheap or expensive; table size, predicates and available indexes matter.

**CTE example** (names a subquery, not necessarily a performance optimization):

~~~sql
WITH upcoming AS (
  SELECT id, title
  FROM events
  WHERE available_tickets > 0
)
SELECT * FROM upcoming;
~~~

Filtering and stable sorting should precede pagination at the logical query-contract level. OFFSET pagination is easy but can become inefficient for deep pages and can shift as writes arrive; keyset pagination is an alternative, and implementing it is deferred. Preserve the API contract introduced in lecture 11.

### 8. Query lifecycle: declarative request, planned execution

SQL describes desired results. PostgreSQL parses, analyzes and rewrites as appropriate, plans a strategy using statistics and available access paths, then executes that plan against tables/indexes/buffer pages.

~~~mermaid
flowchart TD
  S[SQL statement and parameter values] --> P[Parse and analyze]
  P --> O[Rewrite and plan]
  O --> E[Executor]
  E --> A{Access path}
  A --> SEQ[Sequential scan]
  A --> IDX[Index-assisted scan]
  SEQ --> R[Filter join aggregate sort as needed]
  IDX --> R
  R --> OUT[Rows returned to application]
~~~

The engine may correctly choose a sequential scan even when an index exists, especially for a small table or a query returning a large fraction of rows. Statistics can become stale; query performance must be measured with representative data.

### 9. Indexes: accelerate particular reads, not every operation

A default PostgreSQL **B-tree index** can support many equality, range and ordering patterns. Other index families include GIN (e.g. JSONB/array/FTS use cases), GiST and BRIN; each has restrictions and workload-specific value.

For a frequent query:

~~~sql
SELECT *
FROM bookings
WHERE event_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 20;
~~~

A candidate index is:

~~~sql
CREATE INDEX idx_bookings_event_created
  ON bookings (event_id, created_at DESC, id DESC);
~~~

It may help avoid scanning or sorting unnecessary rows. Composite index column order matters. But each extra index uses disk and adds work on relevant INSERT/UPDATE/DELETE operations. A UNIQUE constraint also generally creates a supporting unique index.

Measure rather than assume:

~~~sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM bookings
WHERE event_id = 10
ORDER BY created_at DESC, id DESC
LIMIT 20;
~~~

EXPLAIN ANALYZE **actually executes** the query; using it with a mutating statement can change data. Inspect plans, estimated versus actual rows, timing and buffers on a controlled dataset; record the machine, row count, environment and test method. No measured improvement is asserted in this note.

### 10. Parameterized queries and SQL injection

Unsafe string concatenation can accidentally turn user input into SQL syntax:

~~~ts
// Unsafe: untrusted input becomes part of the SQL program.
const sql = "SELECT * FROM users WHERE email = '" + email + "'";
~~~

Use a parameterized query through the database driver:

~~~ts
const result = await pool.query(
  "SELECT * FROM users WHERE email = $1",
  [email]
);
~~~

The parameter is treated as a **value** rather than interpolated query structure. Placeholder syntax depends on the client/driver. Identifiers such as a chosen sort column or ASC/DESC are not ordinary bind values; validate them against an explicit allowlist before constructing that portion of SQL. A framework/ORM does not make unsafe raw string construction safe.

### 11. Triggers

A database trigger can run on an event such as BEFORE UPDATE. For example, automatically update a modified timestamp regardless of which writer changed the row.

~~~sql
CREATE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_updated_at
BEFORE UPDATE ON events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
~~~

**Trade-off:** triggers can enforce database-local behavior consistently but can hide expensive writes or implicit business behavior from application developers. Prefer explicit service operations for complex workflows involving external systems. Do not invoke network requests directly from a transaction trigger to implement email delivery.

### 12. Transactions and ACID (supplementary deep dive)

An event booking is not one independent UPDATE: deducting inventory and creating the booking must succeed **together** or fail together.

- **Atomicity:** all transaction operations succeed or none become committed.
- **Consistency:** declared integrity invariants continue to hold, assuming the transaction logic is correct.
- **Isolation:** concurrent transactions interact according to the isolation level. This does not mean all transactions are always equivalent to serial execution at every isolation level.
- **Durability:** committed changes survive according to database/storage durability guarantees.

~~~mermaid
flowchart TD
  A[BEGIN] --> B[Atomically decrement stock if positive]
  B --> C{One row returned?}
  C -->|No| X[ROLLBACK: sold out or missing]
  C -->|Yes| D[INSERT booking]
  D --> E{Insert succeeded?}
  E -->|Yes| F[COMMIT]
  E -->|No| G[ROLLBACK: stock deduction undone]
~~~

**Illustrative race-resistant stock mutation:**

~~~sql
BEGIN;

UPDATE events
SET available_tickets = available_tickets - 1
WHERE id = $1
  AND available_tickets > 0
RETURNING id;

-- Application checks that exactly one row was returned.
-- If none: ROLLBACK and report no inventory.
-- Otherwise:
INSERT INTO bookings (user_id, event_id, status)
VALUES ($2, $1, 'confirmed');

COMMIT;
~~~

In application code, ensure the UPDATE, check, INSERT and COMMIT/ROLLBACK happen on the **same checked-out database connection**. A failed INSERT or exception must abort the transaction. PostgreSQL's row-locking and re-evaluation behavior for a conditional UPDATE under READ COMMITTED makes this useful for a simple, single-row counter, but it does not by itself solve retries, duplicate requests, reservation expiry, cross-row invariants or payments. Those require additional design and experiments in their own milestones.

### 13. What happens in production? (supplementary)

- **Connection management:** a bounded connection pool avoids a new TCP/database login for every query but adds backpressure when saturated. Never leak acquired connections, especially after exceptions; do not create an unbounded number of connections.
- **Time and money:** preserve UTC instants plus business time zone, integer minor units plus currency, and server-authoritative prices.
- **Migrations:** take backups as appropriate, run controlled deployment migrations, avoid disruptive locks, and consider application/schema compatibility.
- **Operational failures:** distinguish connection failure, timeout, deadlock/serialization retry candidates, integrity errors and application bugs. Retry only operations whose semantics are safe under retries.
- **Security:** least-privilege database users, credentials from environment/secret management, parameterized queries and no credentials in Git.
- **Observability:** monitor slow queries, plan changes, lock waits and resource usage; do not publish customer data in logs.
- **Correctness:** HTTP-layer validation and authorization remain essential. Database FK/CHECK/UNIQUE constraints protect some invariants, not all business rules.
- **Backups:** persistence on an SSD is not a backup. Recovery procedures and actual restore tests are separate responsibilities.

## Discussion and misconceptions

The teaching session explained the topics with EventHub-specific examples, diagrams, a join-type comparison, an index complexity illustration, and a two-buyer last-ticket scenario. A five-question conceptual self-check was offered; **no learner responses were recorded**. No further technical questions or implementation outcomes are known from this session.

| Misconception | Correction |
| --- | --- |
| Saving JSON to disk gives me database-grade safety | Persistence alone does not solve concurrent updates, integrity, recovery or flexible queries. |
| Every PostgreSQL read hits physical disk | Buffers/cache affect real I/O. |
| NoSQL means no transactions; SQL means automatic consistency | Guarantees vary; model, isolation, constraints and correct queries matter. |
| UUID protects private resources | Only authorization and scope checks do. |
| TIMESTAMPTZ stores the original time-zone name | Store the event IANA time zone separately when needed. |
| Every repeated value violates normalization | Historical/contractual snapshots can be intentional. |
| Index every column for maximum speed | Indexes cost storage and write work; analyze real workloads. |
| CTEs inherently speed up SQL | A CTE is first a query-composition tool; optimization is plan-dependent. |
| ORM or string escaping is enough against SQL injection | Bind untrusted values; allowlist dynamic identifiers. |
| BEGIN/COMMIT automatically fixes every race | Isolation and atomic mutation design still matter. |
| Learning complete proves code is deployed | Documentation and implementation statuses are independent. |

### Review questions

1. Why might a JSON file persist after restart yet still lose two simultaneous booking updates?
2. What different responsibilities do HTTP validation and a database CHECK constraint have?
3. Why does EventHub's price storage use minor units even though NUMERIC exists?
4. What information is lost when we store only TIMESTAMPTZ for a scheduled local event?
5. How do INNER and LEFT JOIN differ for users without bookings?
6. What is the cost of adding an index besides its disk footprint?
7. Why must we bind values rather than concatenating strings into SQL?
8. What is the gap between a transaction and an atomic conditional stock update?
9. What evidence would establish an index is actually beneficial?
10. How could you simulate an INSERT failing after stock decrement and verify rollback?

## Key takeaways and references

**Memory aid:** persistence solves restart loss; the DBMS coordinates safe access; schema and constraints define legal state; SQL describes a result; the planner selects an execution path; indexes trade reads against writes; transactions coordinate all-or-nothing changes; database truth remains authoritative under contention.

- [Original lecture video: 12. Mastering Databases with Postgres](https://www.youtube.com/watch?v=F7Vwp2Xo5Do).
- [Third-party transcript-derived sectional summary](https://www.usetranscribe.io/yt/F7Vwp2Xo5Do/mastering-databases) (not the authoritative recording).
- [Independent lesson notes based on auto-generated captions](https://notequicky.vercel.app/notes/Backend-from-first-principle%2Fvideo-notes%2F12-mastering-databases-with-postgres-video-notes).
- [PostgreSQL documentation: data types](https://www.postgresql.org/docs/current/datatype.html).
- [PostgreSQL documentation: indexes](https://www.postgresql.org/docs/current/indexes.html), [EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html), [transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html), [isolation](https://www.postgresql.org/docs/current/transaction-iso.html) (supplementary technical references).
- [Previous lesson: application layers](10-application-layers.md); [REST API design](11-rest-api-design.md); [EventHub product spec](../PROJECT_SPEC.md).

## EventHub practical assignment — coding agent handoff

**Problem and learning goal:** EventHub currently uses in-memory storage in its earlier learning increments. Persist relevant existing event data in PostgreSQL without abandoning the HTTP/auth/validation/controller/service/repository contracts developed in lectures 05–11. Learn how schema design, migrations, constraints, parameterized queries, query plans and transactions affect correctness. **Do not assume a booking implementation or full reservation workflow already exists.**

**Before writing code:** read AGENTS.md, docs/PROGRESS.md, docs/PROJECT_SPEC.md, docs/LEARNING_ROADMAP.md, existing decisions, tests and all relevant lecture notes; inspect current main and outstanding implementation branches/PRs. Confirm the actual code state, domain field names, error envelopes, test contracts and whether an existing repository interface can be reused. The owner should approve the implementation increment separately. This assignment is not implementation authorization.

### Recommended scoped sequence

1. **Baseline:** run existing tests and typecheck; record versions, environment and results. Inventory storage dependencies and event API contracts without speculative refactoring.
2. **Local Postgres:** make a reproducible local dev/test setup and documented connection configuration; use environment variables for credentials. Select a minimal database library/migration tool based on existing stack; avoid deploying or paying for infrastructure now.
3. **Schema and migrations:** migrate only the existing event/user data that the verified code currently supports. Add appropriate PK/FK/UNIQUE/NOT NULL/CHECK constraints and the established integer-minor-unit/currency/time-zone representation where relevant. Explicitly document any scope gap requiring a later domain decision.
4. **Data adapter:** implement/reuse a PostgreSQL-backed repository behind the current service contracts. Use parameterized queries. Preserve authentication, authorization, validation, status/error envelope, list ordering and bounded pagination.
5. **Persistence demonstration:** create, read, update and delete supported records; restart only the app process and verify the same durable data can be read; do not treat an in-memory fake as persistence evidence.
6. **Transaction exercise:** build the smallest **isolated test-only** inventory-allocation scenario grounded in the current data model, without introducing the full ticket/payment/reservation lifecycle. Check an atomic conditional decrement plus booking row insertion in one transaction if the prerequisites exist. If the existing schema has no bookings yet, create a narrowly scoped lab fixture or defer the production endpoint; document that choice.
7. **Query-plan experiment:** use representative *synthetic* rows to compare the relevant collection query plan before/after a candidate index; record actual EXPLAIN (ANALYZE, BUFFERS) output, row count and hardware/conditions. Do not promise a speedup.
8. **Review and evidence:** run regressions, capture failing/negative cases, verify teardown/cleanup, record actual commands/results and any ADR, then request owner confirmation before changing implementation status.

### Observable acceptance criteria

1. Existing API behavior from lectures 05–11 is preserved or a necessary contract migration is explicitly approved; no unrelated frontend work.
2. Schema can be recreated from migrations in an empty *local/test* database; repeated application of migration tooling does not silently duplicate schema objects.
3. A supported write is still readable after restarting the backend process. The demo is clearly distinguished from surviving physical disk or host failures.
4. Invalid states (e.g., negative price_minor or available inventory, missing required value, duplicate unique email, nonexistent FK) are rejected by database rules with appropriate application error mapping. Avoid leaking raw SQL errors to clients.
5. Untrusted input is bound as values; dynamic sort/filter identifiers are allowlisted. Authorization/ownership remains enforced independent of SQL constraints.
6. At least one pre-existing GET/list flow uses Postgres-backed reads with deterministic sorting, bounded pagination and current response shape.
7. In the isolated booking experiment, two simultaneous requests competing for the last unit produce **at most one** successful allocation. Check actual inventory and rows, not just HTTP statuses.
8. Force an INSERT failure after an inventory decrement; the failed transaction leaves stock unchanged. Confirm all statements used the same database connection.
9. Examine and save a real query plan before/after a carefully selected index; note any increased write/storage cost or inconclusive result.
10. Run applicable unit/integration/HTTP/regression tests and typecheck; provide commands, environment, observed results, uncovered cases and owner review. Do **not** mark implementation complete automatically.

### Experiments and negative/edge cases

- Restart app after a write; make sure reading is not secretly using the former in-memory store.
- Competing requests for a single remaining ticket; concurrent writes with more contenders; no negative stock.
- Duplicate submission, failed INSERT, rollback, pool timeout or unavailable database. Handle cleanup and errors consistently.
- Foreign-key and unique violations; missing row; oversized input; SQL-looking malicious input; forbidden ownership write.
- Offset pagination with ties and concurrent inserts; ensure stable secondary sorting, but acknowledge shifting pages.
- Empty table vs many rows; before/after EXPLAIN with identical query/data conditions.
- Zero available tickets, deleted/cancelled event, repeated booking attempt, invalid currency or schedule fields as supported by current model.
- Confirm tests use disposable data and cannot accidentally point destructive migrations/fixtures at production.

### Out of scope / deliberately deferred

- Full reservation expiry, payment callbacks, issuance/check-in, real payments, refund flows and ticket-type inventory model.
- Distributed locking, queue workers, retries across external providers, idempotency-key infrastructure, replication, sharding and horizontal scaling.
- Redis caching (lecture 13), queues (lecture 14), search engine (lecture 15), deep concurrency (lecture 23), OpenAPI (later), frontend UI and deployment.
- Performance guarantees without measurements; production rollouts without owner approval.

### Prerequisites and open decisions

- Which DB driver/migration mechanism best fits the *actual current repository* and its development workflow?
- Whether a Bookings entity already exists; if not, isolate the inventory experiment from the stable public API.
- Whether to retain an in-memory repository as a test double and how to choose the implementation without test leakage.
- How to map database constraint errors into the established domain/API error contract.
- Confirm implementation branch and sequencing with the owner. Current repository code/tests and production DB state have **not** been inspected or changed as part of this learning-note update.

## Learning completion (ChatGPT)

- [x] Owner explicitly requested publishing the lecture discussion to GitHub on 2026-11-21.
- [x] Concepts, examples, source limitations, diagrams, misconceptions and assignment documented.
- [x] Learning completion tracked separately from implementation in docs/PROGRESS.md.

## Implementation evidence (coding agent)

Status: **complete, owner confirmed 2026-11-22.** Branch `feat/lecture-12-postgres`, PR #10. Owner decisions during implementation: users also move to PostgreSQL; the in-memory repository is removed ([ADR-011](../decisions/011-postgresql-persistence.md)).

**Environment:** Node v24.22.1, `pg` 8.23, PostgreSQL 17 (Docker `postgres:17`, 17.11) on 127.0.0.1:56432, Linux 7.0, i7-1255U / 22.7 GiB. Databases `eventhub_dev` and `eventhub_test`; credentials only in the gitignored `backend/.env`.

**What was built**

| Step | Result |
| --- | --- |
| 1 Baseline | Before changes: `npm test` 198/198, `npm run typecheck` clean (in-memory). |
| 2 Local Postgres | `backend/docker-compose.yml`, `.env.example`, `npm run db:up`. |
| 3 Schema/migrations | `migrations/001_users_events.sql`, runner `src/db/migrate.ts` (transaction per file, checksum, advisory lock). |
| 4 Adapter | `PgEventRepository`, `PgUserRepository`; services/controllers/auth made async; SQL-side filter/sort/paging; sort allowlist; collation "C". |
| 5 Persistence | Test spawns the server process twice on one database: the event and the demo user survive; the old session token is rejected after restart (sessions are in memory). |
| 6 Transaction lab | `test/lab/booking-lab.ts` (isolated, no route; table created and dropped by the test). |
| 7 EXPLAIN | `npm run experiment:explain` -> [docs/evidence/lecture-12-explain.txt](../evidence/lecture-12-explain.txt). |

**Commands and observed results (2026-11-22)**

- `npm run migrate` twice on the dev DB: `applied: 001_users_events.sql`, then `up to date`. `npm run seed` twice: created users and 2 events, then "already exists / nothing inserted".
- `npm run typecheck`: clean. `npm test` (run twice in a row): **214 tests, 214 pass, 0 fail** (198 pre-existing, migrated to the Postgres test DB, plus 16 in `test/postgres.test.ts`). Not run: any load/benchmark beyond the experiment below.

**Acceptance criteria**

1. API behavior preserved: all 198 earlier tests pass unchanged in intent (only their storage assertions now read the database).
2. Migrations rebuild an empty database and re-running applies nothing (test creates and drops `eventhub_migrate_test`; concurrent runners apply the file once; a tampered checksum is refused).
3. Restart test above (demonstrates process restart only, not disk or host failure).
4. Constraint test: negative/oversized seats, blank/long name, NULL, unknown FK owner, owner delete (RESTRICT), short username, bad role, case-insensitive duplicate username (409 over HTTP with no SQL text), 6 concurrent registrations -> exactly one 201.
5. `x'); DROP TABLE events; --` stored and found literally; `%`, `_`, `' OR 1=1 --` match nothing; malicious `sort`/`minSeats` -> 400; authorization still enforced in the service (existing auth tests).
6. `GET /api/v1/events` and `/events/:id`, `/search` read from Postgres; ties broken by id; name sort byte-wise; bounded paging unchanged.
7. Race: 2 buyers for 1 seat -> 1 success; 30 contenders for 7 seats -> 7 bookings, stock 0 (inventory and rows checked, not statuses).
8. Rollback: INSERT fails (FK on a missing user) after the decrement -> stock unchanged; `pg_backend_pid()` identical for all statements of the transaction; 25 failures with a pool of 10 leak no connection. **Negative control:** read-then-write lost updates (8 buyers, stock 10 ended above 2), proving the test can detect the race.
9. Query plans before/after in the evidence file (200k synthetic rows, one warm run, local Docker): page 1 ~18 ms -> ~0.02 ms with an index; INSERT of 50k rows 360 ms -> 602 ms with two extra indexes; index sizes 6 MB and 15 MB. Single-run, indicative only; no index committed to the schema.
10. Tests and typecheck as above.

**Known limitations / simplifications**

- PUT/PATCH are read-then-write (lost update possible); no row locking yet.
- Sessions, rate limiter and synthetic tickets are in memory. `POST /bookings` is still the 501 stub; the booking lab is test-only.
- Tests need Docker Postgres and run serially against one `_test` database. The database outage test simulates the failure by stubbing the pool; a real stop of the container was not exercised.
- Not measured: `sort=-seats` with the candidate index, larger or non-uniform data, concurrent write load.

- [x] Implementation/experiment performed (commit linked after review).
- [x] Actual commands and results recorded (including negative and concurrency cases).
- [x] Acceptance criteria demonstrated and prior regressions checked (see above).
- [x] Owner confirms implementation completion (2026-11-22) and progress tracker updated independently.
