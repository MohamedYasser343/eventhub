# Video 22 — 21.2. Backend Scaling and Performance Engineering: Part-2

- Video: https://www.youtube.com/watch?v=sOhAopEwjH4
- Playlist position: 22 (course numbering 21.2, following 21.1).
- Date: 2026-11-26.
- Learning status: complete by the owner's explicit GitHub upload request.
- Implementation status: Awaiting learner review (evidence appended below; owner confirmation pending).
- Source limitations: video title and chapter outline reverified against the public YouTube description and secondary playlist indexes. The learning session reported partial third-party transcript access; the full original transcript and recording were not independently reviewed during documentation. The explanations and EventHub examples below are teaching synthesis, not verbatim lecture content.

## Learning objectives

Explain why a stateless application tier permits horizontal scaling; how load balancers select and remove upstreams; why scaling the application may shift pressure to the database; distinguish replication, sharding, CDN caching and edge execution; identify asynchronous work, service boundaries and serverless trade-offs; select scaling changes based on measured bottlenecks rather than fashionable architecture.

## Concepts and internal mechanisms

### 1. Horizontal scaling and statelessness (00:43)

Vertical scaling increases resources of a machine; horizontal scaling adds instances. Vertical scaling is operationally simpler but bounded by machine capacity and failure domain. Horizontal scaling adds routing, coordination and dependency pressure; it only helps if the workload can be distributed.

A session stored exclusively in instance A's memory is invisible to B: login on A succeeds, then a request routed to B may return 401. Move authoritative state to appropriate shared storage. Use shared persistent data, a shared session store where applicable, or independently verifiable credentials with consistent keys and authorization/revocation policy. Local temporary state and disposable caches are fine if correctness does not depend on a particular process. Sticky sessions can mitigate affinity issues but undermine easy replacement and failover; they do not make state durable.

```mermaid
flowchart TD
    C[Client] --> L[Load balancer]
    L --> A[API A]
    L --> B[API B]
    L --> X[API C]
    A & B & X --> P[(PostgreSQL)]
    A & B & X --> R[(Shared cache or session store)]
```

### 2. Load balancing (09:11)

An HTTP reverse proxy receives requests, chooses an upstream, forwards requests and returns responses. Layer 4 balancing routes transport connections; layer 7 can inspect HTTP attributes. Connections and requests are not interchangeable, particularly with HTTP/2 multiplexing or long-lived connections.

| Algorithm | Selection | Trade-off |
| --- | --- | --- |
| Round robin | Next available upstream | Equal request count does not imply equal work |
| Weighted round robin | Configured relative weights, e.g. 4:2:1 | Static weights may not reflect dynamic capacity |
| Least connections | Fewest active connections | Connection count is an imperfect load proxy |
| Least response time / resource-aware | Observed latency/load | Requires reliable signals; may oscillate |

Active health checks probe upstreams periodically; passive checks infer failure from actual traffic. Readiness signals eligibility for new work, not just process existence. NGINX Open Source commonly uses passive upstream failure detection; do not imply its standard configuration includes active HTTP readiness probes. Choose a supported local approach and document detection delays. During graceful shutdown, stop admitting work, withdraw the instance from routing, drain accepted work within a deadline, then close dependencies. A sudden crash may lose in-flight requests before detection. Do not indiscriminately replay non-idempotent writes. The load balancer itself can be a single point of failure.

### 3. Database scaling (27:47)

Adding API replicas can shift the bottleneck to shared PostgreSQL. Each process typically owns a pool, so aggregate connection demand increases. Measure query plans, latency, CPU, I/O, connection waits and saturation before adding infrastructure.

**Replication:** maintain copies of the same data. A common primary/standby design accepts writes on the primary and sends WAL records to standbys, which replay them; read replicas can serve suitable SELECT queries. This distributes reads, not arbitrary write throughput.

```mermaid
flowchart LR
    A[API] -->|Writes and fresh reads| P[(Primary)]
    P -->|WAL replay| R1[(Replica 1)]
    P -->|WAL replay| R2[(Replica 2)]
    A -->|Stale-tolerant reads| R1
    A -->|Stale-tolerant reads| R2
```

Asynchronous replication allows lag. Example: primary commits inventory from 100 to 99 at time zero, replica still returns 100 at 50 ms and catches up at 200 ms (illustrative only). Read-your-writes requirements can use primary routing, appropriate replay-position barriers, or a suitable synchronous policy. A synchronous standby acknowledging receipt or flush is not necessarily ready to serve a fresh query; applied-state guarantees depend on configuration. Synchronous replication adds write latency and can affect availability. Monitor lag, failover behavior, and recovery point objectives. Backups remain necessary: replicas can replay accidental deletion.

For EventHub, public event browsing may tolerate stale display data; booking allocation, current authorization and payment confirmation require authoritative correctness. A primary read alone is not enough to prevent races: enforce invariants atomically within the database.

**Sharding:** split distinct subsets of data across independent storage nodes. A toy integer routing rule is `shard = userId % 3`; changing the divisor redistributes many records. Production designs may use range partitioning, consistent hashing or directory/virtual-shard routing. Choose a key based on query locality, data distribution and transaction boundaries. Partitioning inside one database instance is not necessarily distributed sharding.

```mermaid
flowchart TD
    Q[Shard router] --> S1[Shard 1: subset A]
    Q --> S2[Shard 2: subset B]
    Q --> S3[Shard 3: subset C]
    S1 --> R1[Replica A]
    S2 --> R2[Replica B]
    S3 --> R3[Replica C]
```

Sharding introduces scatter-gather queries, cross-shard transactions, hot keys, resharding, migration and operational complexity. Sharding bookings by user may make event-wide queries and inventory coordination expensive; sharding by event could create a hot shard for a popular event. Replication and sharding can coexist. Neither is justified for the current project without evidence.

### 4. CDNs and edge computing (51:22; 1:05:03)

A CDN caches eligible content at distributed points of presence closer to users, reducing origin work and network latency. On a cache miss, the edge obtains a response from the origin; a later hit may avoid origin traffic. At 10,000 eligible requests/s and 90% hits, an idealized model gives 1,000 origin requests/s (not measured; revalidation, non-cacheable traffic and miss coalescing affect reality).

Cache keys, TTL, invalidation, Cache-Control, Vary and authorization govern correctness. Never share personalized or sensitive responses without proven isolation. Public event images and static assets are plausible candidates. Edge computing is broader than caching: lightweight request processing near users can support redirects, routing or other suitable logic; remote database access and platform restrictions can offset latency gains. This is supplementary clarification of the separately listed edge-computing chapter, not a claim of full transcript coverage.

### 5. Asynchronous processing (1:13:25)

Keep essential correctness on the request's critical path; defer slow independent effects such as confirmation email or ticket PDF creation. An illustrative booking flow returns after the booking is durably accepted; independent workers process later jobs. A pending response must not claim confirmation before confirmation exists.

```mermaid
flowchart LR
    U[Client] --> A[API]
    A --> D[(Authoritative DB)]
    A --> Q[Durable job queue]
    Q --> W[Worker]
    W --> E[Mock notification provider]
    A --> U
```

Queues decouple response latency from completion latency; they do not eliminate work. Scale workers independently and monitor queue depth, oldest-job age, retries and failure rates. Database commit and queue publish are separate failure domains unless an explicit atomic handoff strategy exists; a transactional outbox is a possible later design. Retries require idempotent effects and bounded policies. Reuse lecture 14's mock worker lab rather than creating real booking or payment flows prematurely.

### 6. Monolith versus microservices (1:30:43)

A modular monolith deploys as one application with clear internal boundaries. Microservices have independently deployable boundaries, often independent data ownership, enabling targeted scaling, technology selection and team autonomy. They also change local calls into network interactions with partial failures, latency, service discovery, distributed tracing and consistency challenges. Cross-service transactions are more complex than local transactions. Independently scalable workers may address a bottleneck without splitting the entire domain.

Keep EventHub a modular monolith for now; only separate services with demonstrated workload or ownership needs.

### 7. Serverless computing (1:44:09)

The provider manages execution infrastructure and scaling within platform limits; servers still exist. Function environments may be reused (warm) or initialized for new demand (cold), creating additional latency. Event-driven tasks and bursty traffic can fit this model, while constant high utilization, long jobs, platform limits, database connection fan-out, and provider-specific pricing can make other deployment models preferable. Never depend on local function memory for durable correctness. Serverless is not infinite capacity or automatic reliability.

### 8. Engineering mental model (2:10:47)

Measure → identify bottleneck → choose the simplest relevant intervention → repeat under matched conditions. Slow query: query plan/index; repeated reads: cache; saturated app: optimize or add instances; read-heavy database: replicas; write/storage saturation: consider sharding only after simpler options; geographical latency: CDN/edge; slow side effects: jobs. Record successful throughput, p50/p95/p99, errors, saturation and workload. Averages can hide tail latency; adding instances is not automatically a speedup.

## Production behavior and failure scenarios

- A proxy and shared database/Redis may still be single points of failure. Three containers on one host demonstrate process-level distribution, not host-level high availability.
- Health checks have detection thresholds and delays. Record transient failures rather than promise zero downtime.
- Keep proxy timeouts, request limits and graceful shutdown deadlines consistent. Do not enable unsafe retries for non-idempotent operations.
- Preserve security from lecture 20: trust forwarded headers only from configured proxies; prevent spoofed client identity; inspect local rate limiter and cache/session state for replica-dependent behavior. Do not weaken authentication or rate limiting to make the demo pass.
- Budget total database connections across API replicas and workers; run schema migrations once through a deliberate step, not concurrently on every replica.
- Shared cache failures and stale data must not compromise authorization or authoritative writes. Read replicas are not substitutes for transactions.
- Avoid sharing secrets in logs, config examples or the public repository.

## Discussion and misconceptions

No additional learner questions or answers were recorded after the explanation; the upload request confirms learning documentation. The final question was left unanswered by the learner: if two users request the last ticket concurrently on different stateless API instances using the same PostgreSQL database, does sharing the database prevent overselling? No. A naive read-then-write sequence can race. Database constraints plus an atomic conditional update or appropriate locking/transaction strategy are needed; the full concurrency exercise belongs to lecture 23. Statelessness, availability, and consistency are separate properties.

Other misconceptions addressed: equal request counts do not mean equal workload; replication and sharding are different and complementary; caching and asynchronous jobs reduce specific bottlenecks, not all work; microservices are not mandatory for scale; serverless still uses servers.

## Key takeaways and references

- [Original video and chapter outline](https://www.youtube.com/watch?v=sOhAopEwjH4)
- [Course playlist](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- [Secondary transcript-derived material](https://www.usetranscribe.io/yt/sOhAopEwjH4/backend-scaling)
- [Part 1](21-backend-scaling-performance.md)
- Supplementary technical references: [NGINX load balancing](https://nginx.org/en/docs/http/load_balancing.html), [PostgreSQL warm standby](https://www.postgresql.org/docs/current/warm-standby.html), [HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching), [AWS Lambda execution environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html).

## EventHub practical assignment — coding agent handoff

**Problem and learning goal:** the single API process is a capacity and availability limit. Demonstrate interchangeable API instances, shared authoritative state, load distribution and bounded recovery while preserving existing endpoints and security. This is a proposed local exercise, not an implemented feature.

**Prerequisites:** inspect current code, tests, configuration, decisions and lecture 21 assignment. Lecture 21 implementation is not started according to the tracker; complete/obtain owner approval for required baseline work before claiming a comparative scaling result. Reuse native Node HTTP, PostgreSQL, existing cache Redis, dedicated queue Redis/BullMQ worker, readiness, telemetry and graceful shutdown as applicable; do not assume new booking endpoints exist.

```mermaid
flowchart TD
    C[Client or load test] --> N[NGINX reverse proxy :8080]
    N --> A[API replica A]
    N --> B[API replica B]
    N --> D[API replica C]
    A & B & D --> P[(Shared PostgreSQL)]
    A & B & D --> R[(Shared cache Redis)]
    A & B & D --> Q[(Existing queue Redis)]
    Q --> W[Existing independent worker]
```

**In scope / expected behavior:**
1. Inspect state and configuration for process-local sessions, token keys, rate limits, cache and durable writes; document what must be shared and what may remain local. Preserve the existing auth design, don't introduce Redis sessions if unnecessary.
2. Provide a reproducible local Docker Compose topology with three API instances of the same build and an NGINX entry point. Reuse existing dependency containers/volumes and distinct Redis roles; avoid duplicating workers accidentally. Use unique instance IDs in development logs or a safe test-only response header, no secret disclosure. Expose only required ports.
3. Compare round robin with least connections using a mixed-duration workload. Document passive/active health behavior supported by the chosen proxy, timeout settings and shutdown coordination.
4. Use the existing APIs and mock jobs. A write accepted through A must be visible through B under the existing consistency contract. Auth credentials must remain usable across replicas and authorization must stay correct.
5. Document configuration, commands, observations and limitations; record actual results in implementation evidence only.

**Observable acceptance criteria and experiments:**
- Send repeated requests through proxy; demonstrate all healthy replicas serve traffic using logs or test-only IDs. Do not require exact distribution under concurrency.
- Create an authorized event via one instance, read it via another; ensure state survives an API restart. Verify login/auth across replicas plus unauthorized and wrong-owner negative cases.
- Stop or kill one API process, measure time to exclusion and observe requests reaching surviving instances; record failures during detection. Restart and demonstrate return to service. All unavailable should return a bounded proxy error; no infinite retries.
- Trigger graceful SIGTERM with an existing controlled slow request; observe draining and no unsafe replay. Respect existing shutdown semantics.
- Compare algorithms with identical controlled workloads (mix of short/slow requests). Record active connections/request counts, successful throughput, p50/p95/p99 latency, errors, CPU/RAM and database connection usage for one versus three replicas. Keep workload, data, machine and duration fixed; document warm-up and repeats. No required speedup on one host.
- Check aggregate DB pool limits and dependency failure behavior; verify migrations are not raced. Review distributed rate-limit semantics and forwarded-header spoofing; demonstrate existing security expectations or report gaps rather than claim success.
- Run previous tests and typecheck; report actual commands/results and any failures. Use synthetic data and mock providers.

**Edge cases:** unavailable proxy/upstream, brief detection windows, long requests, multiple shutdown signals, stale cache, shared dependency outage, pool exhaustion, retry duplication, replica-local counters and logs. Document process-level versus host-level availability.

**Deferred:** database read replicas, sharding, CDN deployment, edge execution, microservices, serverless, Kubernetes, production multi-host HA, real bookings/payments, and lecture 23 contention implementation. No paid services or frontend work.

## Learning completion (ChatGPT)

- [x] Owner explicitly requested GitHub upload, treated as learning completion.
- [x] Conceptual notes, discussion and assignment documented.
- [x] Learning status updated independently in docs/PROGRESS.md.

## Implementation evidence (coding agent)

Branch `feat/lecture-22-horizontal-scaling` (built on the lecture 21 branch: it reuses the benchmark tool and bench database); decision record [ADR-021](../decisions/021-shared-sessions-and-trusted-proxy.md). All numbers were measured in this session on a shared developer machine (12 CPUs, load average up to ~26 during the load runs), so absolute values are noisy; repeats are listed.

### Inspection: what is process-local (before any change)
| State | Where | Replica-safe? |
| --- | --- | --- |
| Sessions (opaque tokens) | `Map` in `AuthService` | **No** - demonstrated: login on :8081 -> `/auth/me` 200 on :8081, **401 on :8082** |
| Login/register rate limiters | `Map` in `FixedWindowLimiter` | No (N x limit), stays local (deferred, documented) |
| Rate-limit key | `req.socket.remoteAddress` | **No** behind a proxy (all clients = the proxy) |
| Tickets (`ticketsByUser`) | synthetic in-memory Map | No, diverges per replica; booking is out of scope, left as is |
| Users, events | PostgreSQL | Yes |
| Public-event cache | shared Redis, TTL | Yes (stale up to TTL, unchanged contract) |
| Job queue / worker | separate Redis + one worker | Yes; replicas only enqueue, the worker is not duplicated |
| Migrations | advisory lock (`pg_advisory_lock`) | Yes; replicas never migrate, seed is off (`SEED_DEMO_USERS=0`), the concurrent-runner test exists |
| Pool | 10 connections per process | budget = replicas x `DB_POOL_MAX` (now configurable) |
| Logs / metrics counters | per process | local by nature |

### Changes
- `migrations/005_sessions.sql` + `PgSessionStore` behind a `SessionStore` interface (hash-only keys, same TTL, logout = DELETE). `createSession`/`destroySession` became async.
- `TRUSTED_PROXIES` + `clientAddress()` for rate-limit keys (header believed only from listed proxy IPs); `DB_POOL_MAX`.
- `scale/`: `nginx.conf.template` (round robin or `least_conn`), `docker-compose.yml` (proxy only), `lb.sh`, `replicas.sh`, `verify.sh`, `drill.sh`.
- **Deviation from the proposed topology (reasoned):** the three API replicas are plain `node` processes, not containers. No Node image is available locally and pulling one is a download I did not take without approval; plain processes also receive SIGTERM directly (no wrapper as PID 1), which the shutdown experiment needs. The proxy (`nginx:alpine`, already local) runs in a container on the host network, reaching `127.0.0.1:8081-8083`. Existing PostgreSQL/Redis containers are reused; only the proxy port 8080 is exposed (loopback). (Superseded: containerised replicas were added in the follow-up pass.)

### Functional results (`scale/verify.sh`, dev database, round robin)
- 30 requests through the proxy: 10 / 11 / 9 answered by :8081 / :8082 / :8083 (identified by the test-only `X-Upstream` header the proxy adds).
- Token minted on replica 1: `/auth/me` x9 through the proxy -> 200 on all three replicas (3 each). Bad token -> 401.
- Event created on :8081 (201, id 3) read on :8082 -> same body; owner PATCH on :8083 -> 200; **wrong-owner PATCH -> 403**; unauthenticated PATCH -> 401.
- Replica 1 killed with SIGKILL and restarted: the same token still 200, the event still readable (state is in PostgreSQL).
- Logout on :8083 -> 204; the same token on :8081 -> 401 (revocation is immediate everywhere).

### Failure drills (GET workload ~20 req/s through the proxy; `scale/drill.sh`)
- **SIGKILL of one replica** (t=3 s, restarted at t=9 s): 280 of 280 responses 200; zero client-visible failures. NGINX retried the failed connect on the next replica (the response's upstream list shows two addresses for those requests), then skipped the dead one (`max_fails=2 fail_timeout=5s`). Time to exclusion cannot be read as "failures" here because retries hid them; the exposure window is bounded by the 1 s connect timeout and at most 2 tries.
- **Non-idempotent POST while replica 2 was dead** (12 bad-credential logins): all answered by the live replicas (401, then 429 from the limiter); the log shows `connect() failed (Connection refused)` on :8082 followed by a retry. This is safe because nothing had been sent to the dead replica; NGINX still does not retry a POST once it has been sent.
- **All replicas down**: 502 in 0.4-10 ms, no hang; after restart the proxy answered 200 again.
- **SIGTERM with drain delay 1.5 s** (`SHUTDOWN_DRAIN_DELAY_MS=1500`): first attempt with `proxy_next_upstream error timeout` showed **4 client-visible 503s in 40 requests**: the draining replica answers 503 and the open-source proxy has no active readiness probe. After adding `http_503` to `proxy_next_upstream` (safe: the draining replica admits nothing before answering 503), the same drill gave **0 failures in 50 requests**, and **20 slow in-flight requests started on the replica before SIGTERM all completed with 200** (0.28-1.04 s). One run each; no repeat. Unknown: behaviour for a POST that reaches a draining replica (the client gets 503 + `Retry-After: 1` and must retry; NGINX will not replay a sent POST).
- Not performed: multiple SIGTERM signals, dependency (PostgreSQL/Redis) outage with replicas up, pool-exhaustion under 3 replicas.

### Load comparison (bench DB, 300,000 rows, `mixed` = 90% cached event detail + 10% heavy list, 30 virtual users, 12 s measured after 3 s warm-up, closed loop, cache on, pool 10 per replica)
| Setup | Run 1: ok-req/s, p50 / p95 / p99 ms | Run 2 |
| --- | --- | --- |
| 1 replica, direct | 1467; 1.9 / 179 / 209 | 1110; 2.6 / 246 / 289 |
| 3 replicas, round robin | 1627; 4.2 / 145 / 288 | 1474; 4.3 / 176 / 316 |
| 3 replicas, `least_conn` | **2323**; 5.8 / **22** / 198 | **2319**; 5.8 / **22** / 204 |
Zero 429/5xx/timeouts in every run except 3 requests (of 27,832) with 4xx in the second `least_conn` run, **cause not investigated**. PostgreSQL connections open during the run: 11 (1 replica) vs 21 (3 replicas), pool ceiling 30 + worker/admin. The PostgreSQL container used ~650-810% CPU in every setup, i.e. **the database, not the API tier, is the limiting resource**: three replicas did not triple throughput (round robin +10-33%), and `least_conn` helped mainly because the heavy 10% of requests stopped queuing behind each other on one replica. The proxy adds one hop (p50 rises from ~2 to ~4-6 ms). Limitations: single host and one shared CPU pool for generator, proxy, replicas and database; two repeats; the generator used 29-53% of one core; Node CPU per replica was not captured (my `ps` filter returned nothing).

### Security review
- Spoofing: through the proxy, 20 failed logins with a different fake `X-Forwarded-For` each were still limited (**401 x15, then 429**): NGINX overwrites the header and the API only trusts it from `TRUSTED_PROXIES`. Gap shown honestly: connecting **directly** to a replica from the trusted loopback address with fake headers was **never limited (20 x 401)**; without the header, direct attempts are limited after 5. Replicas must therefore be reachable only from the proxy in any real deployment.
- Rate limits were per replica in the first pass: **15 = 3 x 5 failures before the first 429** through the proxy (measured), 10 with two live replicas. Fixed in the follow-up below (shared PostgreSQL limiter, 5).
- Sessions: only the sha256 of the token is stored; deleting a user cascades to their sessions; the extra DB query per authenticated request was **not benchmarked in isolation**.
- No secrets committed (`.env` ignored; the lab uses synthetic users and the existing local credentials).

### Tests and checks
`npm test`: **348 tests, 348 passed**, `npm run typecheck` clean. New `test/scaling.test.ts` covers: login on one replica authenticated on another, logout revoking everywhere, the in-memory per-process baseline still showing the problem, expiry across replicas, hash-only storage, cascade, `clientAddress` (direct client cannot spoof, no proxies configured, rightmost-untrusted hop, garbage fallback, IPv4-mapped peer) and config validation. Updated tests: sessions now survive a restart (`postgres.test.ts`), sweep test counts rows in `sessions`, migration list now 5 files.

### Follow-up fixes (second pass, same branch)
Measured after fixing the gaps listed above (replicas on `127.0.0.2`-trusted proxy, dev database, round robin through NGINX, 3 replicas):
- **Rate limits are now shared** (`PgWindowLimiter`, migration `006_rate_limits.sql`, one atomic upsert per failure; not in the disposable cache Redis because an LRU eviction would reset a lockout). Through the proxy, one login key was locked after **5** failures (`401 x5, then 429`), no longer 15. Tests: two replicas share one budget, window reset, bucket isolation, 40 concurrent failures counted exactly (no lost updates), and an `AuthService` lockout shared by three replicas. Residual: check-then-act (`retryAfter` then `fail`) can overshoot `max` by the number of concurrent in-flight attempts.
- **Spoofing from a direct connection fixed in the lab**: NGINX now connects from `127.0.0.2` (`proxy_bind`) and replicas trust only `TRUSTED_PROXIES=127.0.0.2`. 20 failed logins with a fake `X-Forwarded-For` sent **directly** to a replica from `127.0.0.1` are now limited (`401 x5, then 429`; before: 20 x 401). Through the proxy the spoof is still ignored. In a real deployment the replicas must still be reachable only from the proxy.
- **Session lookup cost measured and reduced.** `GET /auth/me`, 10 users, 8 s, 3 runs each, single replica, noisy host: in-memory sessions (temporary patch, user still read from PostgreSQL) 8700 / 8655 / 7626 ok-req/s; PostgreSQL sessions with two queries per request 1221 / 2294 / 4037 (p50 7.7 / 3.7 / 2.5 ms); PostgreSQL sessions with one joined query (`getWithUser`, same semantics: the user row is still read fresh every request) 8425 / 5852 / 6194 (p50 1.1-1.7 ms). So the extra round trip was the cost; the join recovers most of it. The first PG runs were also taken while the host was busier, so the size of the earlier gap is partly noise.
- **The 3 unexplained 4xx**: not reproduced in 3 further 12 s `least_conn` runs (about 31,000 requests, all 2xx). Cause remains unknown (a keep-alive/proxy race is a guess, unverified). The load tool now prints the first non-2xx responses with status, path and upstream so a recurrence explains itself.
- **Containerised replicas (done, after your approval to pull `node:24-alpine`, Node v24.22.3):** `backend/Dockerfile` (one image, exec-form `CMD` so `node` is PID 1) and `scale/docker-compose.yml` profile `replicas` (`docker compose --profile replicas up -d --build`: api1-3 on the host network next to the NGINX container; configuration only through the git-ignored `.env`, nothing baked into the image). The build runs `npm ci` from the lockfile, which downloads the project's pinned dependencies (a second download beyond the base image). Verified with `scale/verify.sh` against the containers: distribution 10/11/9, token minted on one replica accepted by all three, cross-replica read, owner 200 / wrong owner 403 / unauthenticated 401, logout revocation 204 then 401 (its "restart replica 1" step uses pid files of process mode and printed an error; the state-survival check itself passed). Drills with 60 GETs through the proxy: `docker kill` of one replica (exit 137): **60/60 200**; `docker stop` (SIGTERM, 1.5 s drain delay): **60/60 200**, the stop took **1.60 s** and the container exited with **code 0**, i.e. the signal reached the app's graceful shutdown. One run each; slow in-flight requests were not repeated in containers (the earlier process-mode drill covers them).
- **Not fixed, with reasons:** (2) `ticketsByUser` stays replica-local: it is a synthetic store with no booking feature behind it, and replacing it means designing bookings, which the assignment forbids; (3) active health checks / readiness-aware routing need NGINX Plus or another proxy; the `http_503` retry covers the drain case for idempotent requests.
- `npm test`: **351/351**, typecheck clean (one earlier run failed the pre-existing flaky shutdown SIGINT timing test; a rerun was clean; a later run was killed by the OS, exit 137, with the database containers stopped, and was rerun after restarting them).

### Open items
Replica-local tickets (resolved only when booking is built); optional active health checks (NGINX Plus or another proxy) and readiness-aware routing; per-request session lookup cost; no read replicas/sharding/CDN (deferred by the assignment); lecture 23 concurrency (last-ticket race) is not addressed here: sharing PostgreSQL does **not** prevent overselling.

- [x] Implementation or reproducible experiment.
- [x] Acceptance criteria demonstrated, with the gaps listed above.
- [x] Negative cases and regression checks as applicable.
- [ ] Implementation progress updated and learner confirmed. (owner confirmation pending)
