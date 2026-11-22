# Video 13 — Caching, the Secret Behind It All

- **Original video:** https://www.youtube.com/watch?v=estH64OkwxU
- **Course:** [Backend from First Principles — Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- **Playlist position:** 13 (numbered title corroborated by course-specific independent notes; live playlist index not independently checked)
- **Documented:** 2026-11-22
- **Learning status:** Complete — owner explicitly requested uploading this lecture discussion to GitHub.
- **Implementation status:** Complete (owner confirmed 2026-11-22); see the implementation evidence section.
- **Source limitations:** The discussion used lecture-identifying metadata and independent, transcript-derived notes describing the video's sections. The original full recording/transcript was **not independently watched or verified end-to-end** during this session. The real-world descriptions below represent the lecture's educational examples, not audited internal designs of those companies. Engineering additions are labeled **Supplementary**. No EventHub code, tests, timings, or benchmarks were run for this documentation update.

## Learning objectives

After studying this lesson, explain independently:

1. Why repeated expensive reads or computations motivate caching, and the difference between a cache hit and miss.
2. Why caches store selected data rather than automatically mirroring everything.
3. How network caching (CDN and DNS), hardware caching (L1/L2/L3), and application caching solve related but different problems.
4. How memory locality and the memory hierarchy influence access time; why Redis and Memcached are useful in-memory stores.
5. How cache-aside and write-through strategies work and what they cost.
6. Why TTL, explicit invalidation, and memory-pressure eviction are separate mechanisms.
7. The behaviors of noeviction, LRU, LFU and volatile-ttl, including approximations in real Redis.
8. Uses for query caching, session storage, third-party API caching, and rate limiting.
9. Why cached inventory must never become the authority for deciding ticket allocation.
10. How to demonstrate a cache's value and failure behavior through measured experiments.

## Concepts and internal mechanisms

### 1. Begin with the problem: repeated work

Imagine a popular EventHub event detail page viewed thousands of times while the public description rarely changes. Without an application cache, every request could repeatedly traverse the same HTTP/controller/service path, query the database, and serialize an essentially unchanged result. Keeping a fast-access copy reduces the cost of subsequent reads.

**Caching** means keeping a reusable subset of data, or a previously computed result, in a location that is cheaper or quicker to access than its source. Selection depends on popularity, reuse probability, lifetime, resource size, and tolerable staleness; caching everything wastes capacity and can create needless invalidation work.

- **Hit:** the required usable entry is present, so the repeated source operation is skipped.
- **Miss:** no usable entry exists; read/compute from the original source and optionally populate the cache.
- **Cold cache:** no relevant entries are warmed up.
- **Warm cache:** useful entries have been populated.
- **Source of truth:** the authoritative state. A cache copy normally does not replace it.

~~~mermaid
sequenceDiagram
    participant C as HTTP client
    participant A as EventHub service
    participant K as Cache
    participant P as Primary store
    C->>A: GET /events/42
    A->>K: Read event:public:v1:42
    alt Valid entry: hit
        K-->>A: Cached public DTO
        A-->>C: 200 OK
    else Miss or expired
        K-->>A: No usable entry
        A->>P: Read authoritative public event
        P-->>A: Event row
        A->>K: Save cacheable DTO with TTL
        A-->>C: 200 OK
    end
~~~

A cache can make an otherwise expensive read cheaper; it does not automatically increase correctness or eliminate all network hops. A remote Redis call also has latency and operational cost. Measure the actual bottleneck.

### 2. Lecture examples: what gets saved?

The presenter illustrates caching through three recognizable systems:

- **Google Search:** frequently reused search results motivate caching instead of performing every expensive retrieval/ranking operation from scratch for every request. This is an illustrative performance intuition, not a complete account of the current Google search architecture.
- **Netflix and CDNs:** popular encoded video segments can be served from network locations near viewers rather than always fetching from a distant origin. Popular content varies by geography; globally duplicating everything is expensive.
- **X / Twitter trending topics:** calculating trends is computationally heavy; reusing a periodically calculated result can give fast reads when a short freshness delay is acceptable. The example update cadence is illustrative, not a known internal service-level setting.

A useful rule of thumb is **high repeated read cost + sufficiently reusable result + acceptable freshness trade-off**. Caches also help reduce repeated transfers of large content.

### 3. Network-level caching: CDN and DNS

#### CDN (Content Delivery Network)

A CDN distributes content across **edge servers** at regional **PoPs (Points of Presence)**. Routing may take geography, network performance, availability and provider policy into account; physically nearest is not always the selected edge.

~~~mermaid
flowchart TD
    C[Browser requests an asset] --> E[CDN edge / PoP]
    E --> H{Usable cached copy?}
    H -->|Hit| R[Return cached asset]
    H -->|Miss| O[Origin server]
    O --> F[Fetch and optionally cache]
    F --> R
~~~

CDNs commonly serve images, videos and static assets. Cache keys, HTTP response headers, and cache invalidation policies influence which responses can be reused. A CDN edge is not a replacement for authorization on private content.

**TTL (Time To Live)** makes an entry ineligible after a specified lifetime; what happens next depends on the cache configuration and HTTP rules. Revalidation can fetch a fresh version or validate that an existing representation is still current.

#### DNS caching

A request for a hostname often needs a DNS lookup. A recursive resolver consults its cache before walking the DNS hierarchy, potentially querying a root server, a TLD server, and an authoritative name server on a miss. Browsers and operating systems may also hold DNS caches; exact ordering and behavior depend on platform configuration.

~~~mermaid
flowchart TD
    A[App / OS DNS lookup] --> B{Local usable cache?}
    B -->|Yes| X[Return DNS answer]
    B -->|No| C[Recursive resolver]
    C --> D{Resolver cache hit?}
    D -->|Yes| X
    D -->|No| E[Root delegation]
    E --> F[TLD delegation]
    F --> G[Authoritative answer]
    G --> H[Cache records per DNS TTL]
    H --> X
~~~

**Why it matters:** without caching, many otherwise identical lookups would repeatedly traverse the hierarchy and add latency/load. DNS answers can also become stale until appropriate expiry; changing an IP address does not instantaneously update every cache.

### 4. Hardware-level caching and locality

CPUs use several fast, capacity-constrained cache levels (commonly L1, L2 and often shared L3), with larger main RAM and durable SSD/HDD storage below. Exact sharing and performance depend on CPU architecture.

~~~text
CPU registers
  L1 (small, very close to a CPU core)
  L2
  L3 (often shared by multiple cores)
RAM (main memory)
SSD / HDD (persistent storage)
~~~

**Spatial locality:** accessing an element of a sequential array makes nearby data likely to be useful, so hardware moves data in cache lines rather than fetching only one tiny scalar at a time.

**Temporal locality:** recently used memory is more likely to be reused.

These are hardware mechanisms, distinct from Redis. Operating-system page caches and PostgreSQL shared buffers can also mean database reads are served from RAM. It is incorrect to claim every SQL query always requires physical disk I/O.

Memory is generally faster to access than storage but has higher cost per byte and more limited capacity. Ordinary RAM is volatile; storing data in RAM alone is not a durable-storage strategy.

### 5. Software caching and in-memory key-value stores

**Redis**, **Memcached**, and related tools keep useful structures in RAM and expose quick key-addressed operations. Redis can hold strings, hashes, lists, sets and other structures. Managed offerings such as AWS ElastiCache are deployment/operations services, not a separate universal data model.

Illustrative Redis commands:

~~~redis
SET event:public:v1:42 '{"id":42,"title":"Backend Summit"}' EX 60
GET event:public:v1:42
TTL event:public:v1:42
DEL event:public:v1:42
~~~

Here the public event DTO is cached for sixty seconds. The key and DTO shape are examples, not claims about existing EventHub routes or database schema.

**Why is Redis fast?** Much of the working dataset is in memory, simple key-based operations avoid some query planning and relational joins, and Redis uses efficient internal structures. However, a network round trip, serialization, contention, value size and capacity still matter. A single Redis call is not universally faster than every PostgreSQL query.

**Durability nuance:** Redis can use RDB snapshots and/or AOF logging, while Memcached is primarily an ephemeral cache. Redis persistence configurations carry different loss/recovery trade-offs; not every Redis deployment guarantees durable writes. For EventHub, PostgreSQL remains authoritative for business records and ticket allocation.

### 6. Caching strategies: cache-aside and write-through

#### Cache-aside (lazy loading)

The app reads cache first, then on miss reads the database, optionally stores the result, and returns it. The cache fills only for actually requested data.

**Advantages:** simple, avoids warming rarely used records, easy to fall back to authoritative reads.

**Costs:** first-request misses; stale copies after updates; parallel misses can multiply database load; manual invalidation requires discipline.

For a public event detail endpoint, cache-aside is a reasonable first experiment once the PostgreSQL-backed endpoint exists.

#### Write-through

A write workflow updates the primary store and the cache. This can keep hot reads more current but adds write latency, error cases and coordination cost.

~~~mermaid
flowchart LR
    W[Organizer update] --> D[(Primary DB write)]
    D -->|Successful commit| C[Update / invalidate cache]
    C --> R[Later read]
~~~

**Important correction to an oversimplified claim:** a DB write and Redis write are **not automatically atomic**. If DB commit succeeds but cache update fails, readers may temporarily see a stale value. A write-through workflow alone does not guarantee strong consistency. Versioning, retries, invalidation and recovery have trade-offs; cross-system transactions are not magically provided.

**Supplementary: cache invalidation**. A good first policy for EventHub is database-commit-then-delete-cache-key; the next read repopulates it. Invalidation itself can fail, and readers racing with writers can repopulate stale content. Such windows should be understood and tested rather than concealed.

### 7. TTL versus eviction

TTL controls **entry freshness/lifetime**. Eviction controls **which keys make room under memory pressure**. They are not interchangeable.

| Mechanism / policy | Purpose | Typical behavior |
| --- | --- | --- |
| TTL / expiration | Decide when an entry is no longer usable | Expires after configured lifetime; cleanup may be lazy or active |
| noeviction | Do not evict keys to make new writes fit | Memory-adding commands may fail at the configured limit |
| LRU | Prefer keeping recently accessed entries | Evict least-recently-used candidate |
| LFU | Prefer frequently accessed entries | Evict least-frequently-used candidate |
| volatile-ttl | Choose among keys that have expiry set | Prefer eligible keys closer to expiry |

The source lecture names TTL among eviction ideas; **in Redis, volatile-ttl is a particular eviction policy**, while ordinary TTL/expiration is a separate feature. Redis LRU and LFU are approximate implementations rather than a perfect globally ordered list/counter for every access. Actual policies may be restricted to all keys or only keys with expiration, depending on configuration.

**Worked example:** keys A/B/C/D were last used 1/20/4/8 minutes ago, and accessed 12/40/3/17 times respectively. A simplified LRU policy chooses B; simplified LFU chooses C. Outcomes in Redis can depend on sampling, decay and configuration.

### 8. Practical backend uses described by the lecture

1. **Database query caching:** cache an expensive, frequently reused public query response; expire or invalidate on relevant changes.
2. **Session storage:** use a fast lookup keyed by an opaque session identifier. Security, expiration and outage behavior still apply; JWTs do not require storing every token in Redis.
3. **Third-party API caching:** cache reusable weather-like API results to reduce latency, provider rate-limit pressure and request-based cost. A TTL must match acceptable staleness.
4. **Rate limiting:** store short-lived per-principal/IP counters; reject over-limit requests with HTTP **429 Too Many Requests**. Atomic counter/window behavior matters under concurrency. Never trust arbitrary client-supplied X-Forwarded-For; only process it according to a configured trusted-proxy boundary.

**Supplementary distinction from lecture 05:** an application cache (Redis) differs from browser/shared HTTP caching. HTTP Cache-Control directives (e.g., no-store, no-cache, private, max-age) control HTTP reuse; no-cache generally means revalidate before reuse, not "never store." Public versus user-specific cacheability is a security decision.

## Production behavior and failure scenarios (supplementary engineering discussion)

- **Stale reads:** a public title may tolerate slight staleness, but an authoritative booking decision must not.
- **Cache stampede:** a popular key expires and many requests miss simultaneously. Potential mitigations include coalescing, bounded concurrency or carefully designed stale-while-revalidate.
- **Cache unavailable:** for public read acceleration, a bounded/controlled fallback to the primary database is often suitable; protect the DB from unlimited fallback traffic. A failure of a *session store* can have different semantics.
- **Cache poisoning / user data leak:** never key protected, personalized results by only a public event ID. Authorization must happen independently; do not accidentally share private DTOs across users.
- **Cache key design:** namespace by resource, API shape/version and any relevant filter/locale/privacy scope. Stable serialization and bounded response size matter.
- **Nonexistent resources:** distinguish legitimate not-found results from cache/backend failures. Negative caching needs deliberately short TTL and invalidation.
- **Concurrent writers/readers:** commit-then-invalidate can still race with miss-fills. Observe the failure and document whether short-term inconsistency is acceptable; do not assume a simple DEL guarantees linearizability.
- **High-cardinality caching:** caching every unique filter/pagination variant can exhaust memory with low-hit-rate keys.
- **Capacity and observability:** record memory usage, eviction count, cache hit/miss, TTL behavior, timeouts, fallback activity, primary query volume and actual p50/p95 latency for the same workload. Do not fabricate improvements.
- **Correctness is higher priority than performance:** keep ticket availability, allocation and reservation constraints enforced by PostgreSQL atomic transactions/conditional updates. Cache may display advisory availability, not approve sales.

## Discussion, review questions and misconceptions

During this chat, the learning explanation covered definition and examples, DNS/CDN request flow, CPU caching, Redis, cache-aside/write-through, TTL/LRU/LFU, query/session/API/rate-limit uses, and operational hazards. A multiple-choice last-ticket scenario was offered. **The learner did not submit an answer; do not claim quiz mastery.** The later explicit instruction to upload documents the learning discussion as complete, not its implementation.

**Scenario:** EventHub's cache contains {"eventId":42,"availableTickets":1}; 200 clients attempt to reserve the last ticket. Can an API accept reservations based solely on the cached value? **No.** Many clients may read the same copy. The booking decision must execute an authoritative atomic database operation with appropriate constraints; subsequent cache invalidation cannot replace that safety rule.

| Misconception | Correction |
| --- | --- |
| Cache is just Redis | Caching exists in network, hardware and application layers. |
| Redis and PostgreSQL are identical except speed | They serve different data models and correctness/durability needs. |
| PostgreSQL reads are always physical-disk reads | Buffer pools and operating system caches exist. |
| A cache hit proves the data is current | Freshness and invalidation are separate concerns. |
| Write-through guarantees perfectly synchronized stores | DB+cache dual writes can partially fail and race. |
| TTL is the same as LRU/LFU | TTL manages expiration; eviction chooses victims under pressure. |
| Short TTL makes ticket allocation safe | Atomic authoritative reservation checks are still required. |
| A Redis outage must stop every public endpoint | Design a bounded fallback when cache is optional. |
| X-Forwarded-For is always trustworthy | Trust only verified proxies and an explicit parsing policy. |

**Review questions:**

1. What computation or retrieval cost makes an EventHub event read worth caching?
2. Describe hit/miss for both a CDN and a Redis cache.
3. How are spatial locality and Redis caching similar in goal, and different in mechanism?
4. Why is cache-aside called lazy?
5. What happens if Postgres commits an event update but Redis invalidation fails?
6. Why does a TTL not prevent race conditions involving the final ticket?
7. When would LRU and LFU select different eviction candidates?
8. How would you demonstrate a real performance benefit without inventing benchmark results?

## Key takeaways and references

**Memory aid:** reuse cheap copies when they are safe; cache hits save repeated work; expiration and invalidation keep copies usable; memory pressure requires eviction; **the authoritative state and invariants must never depend on an untrusted stale copy**.

- [Original lecture: Caching, the Secret Behind It All](https://www.youtube.com/watch?v=estH64OkwxU)
- [Independent transcript-derived lesson notes (secondary material)](https://github.com/shubhamscifi/backend_from_first_principles_notes) — useful for section coverage, not a substitute for verifying the source recording.
- [Redis documentation](https://redis.io/docs/latest/), including [key eviction](https://redis.io/docs/latest/develop/reference/eviction/) and [persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).
- [MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching) (supplementary).
- [Lecture 05 HTTP](05-http.md), [Lecture 08 authentication](08-authentication-authorization.md), [Lecture 12 PostgreSQL](12-mastering-databases-postgres.md), [EventHub product specification](../PROJECT_SPEC.md).

## EventHub practical assignment — coding agent handoff

### Problem and learning goal

Introduce an **optional cache for public event-detail reads**, then demonstrate hit/miss, expiration, invalidation and outage behavior using observable measurements. Learn that a cache accelerates selected reads but does not provide booking correctness.

**Prerequisite/dependency:** as documented in docs/PROGRESS.md on 2026-11-22, lecture 12's PostgreSQL implementation is **not started**. Do not claim a real Postgres-vs-Redis performance experiment until the primary repository exists and its persistence behavior has been demonstrated. A disposable fake-repository cache lab can teach semantics earlier, but it must be clearly labeled as a lab rather than completed lecture-13 product implementation. The owner must separately approve coding work.

### In scope / expected behavior

- Reuse the current Node.js/TypeScript native HTTP, routing, authorization, controller/service/repository and API response contracts; inspect the actual code before choosing an endpoint or response DTO.
- Once the PostgreSQL-backed public-event read is available, introduce a narrow cache abstraction (e.g., get/set/delete or get-with-TTL) at a suitable service/repository boundary. Use Redis locally for the exercise; document why the extra dependency is justified.
- Cache **only safe public event detail data** and only when the event is publishable/readable according to current business rules. Do not cache organizer-private or personalized data under a public key.
- Use a namespace/versioned key (illustrative: event:public:v1:42), a configurable, nonzero TTL, and deliberate JSON encoding/decoding with validation or safe failure handling.
- On hit, serve the cached public DTO. On miss, load from authoritative storage and populate cache where suitable. Preserve the existing HTTP status/error contract.
- After a successfully committed edit/unpublish/delete, invalidate the corresponding cached public view. Do not invalidate on a failed transaction. Define handling for partial failure after DB commit.
- If the cache is unavailable or times out, let eligible public read requests use the source of truth with a bounded fallback; never silently turn a cache failure into a fake event-not-found result.
- No ticket booking/allocation decision may depend solely on cached availability. If an availability field appears publicly, document its advisory nature.
- Allow focused experiments that record hit/miss and read-source counters or timing without leaking sensitive data. Avoid adding a full observability platform at this milestone.

### Suggested incremental exercise

1. **Read current reality:** inspect AGENTS.md, PROGRESS.md, lecture 12, PROJECT_SPEC.md, actual endpoint/service/repository, tests and implementation branches. Confirm lecture 12 prerequisites with the owner.
2. **Baseline:** run existing tests/typecheck and collect repeatable uncached request behavior once a real DB-backed endpoint is present; record versions, hardware, row counts and environment.
3. **Small cache interface:** introduce the narrowest adapter needed, with an in-memory fake only for isolated tests and Redis for real local experiments; avoid broad redesign.
4. **Cache-aside read:** demonstrate cold miss populates the key, then a warm hit serves the same public DTO without an additional primary-store query.
5. **TTL:** set a short test TTL and show read behavior before and after expiry. Distinguish key expiration from max-memory eviction.
6. **Invalidation:** update a public event after DB commit; show the next read reflects new data. Repeat for unpublish/delete and for a failed DB mutation.
7. **Failure experiment:** stop/disconnect Redis, show a controlled source fallback and correct HTTP response, then restore Redis. Demonstrate recovery, not an unbounded retry loop.
8. **Measurements:** compare cold/warm response latency and source-query counts under identical conditions, repeat samples, and note that local microbenchmarks are noisy. Prefer representative p50/p95 and actual observed results rather than unsupported percentage claims.
9. **Review:** negative cases, access control, prior lesson regressions and any documented ADR. Request owner acceptance before marking implementation complete.

### Observable acceptance criteria

1. No previously supported public/authenticated routes change behavior unintentionally; existing regression suite and typecheck results are recorded rather than presumed.
2. Initial GET of a cacheable published event is a demonstrable miss and subsequent GET within TTL is a demonstrable hit; cache hits bypass the primary event read.
3. Returned API shape/status and permitted public fields match the uncached path.
4. Entry expires as configured; first read after expiry refreshes from the authoritative source.
5. A successful committed event change causes appropriate invalidation so the next read returns the updated public representation; unpublished/deleted resources cannot remain publicly visible from a stale cache.
6. Failed mutations do not publish uncommitted state to cache; write/cache partial-failure behavior is documented and testable.
7. Cache timeouts/unavailability do not corrupt event data and a public read can fall back within a bounded time under the selected policy.
8. No private organizer data or other-user data is served from a globally shared event key; existing authorization checks remain in force.
9. Booking/inventory truth remains Postgres-side. If concurrency/inventory test fixtures exist, they must show cache values cannot authorize overselling; do not build an unrequested full reservation lifecycle for this lecture.
10. Compare cold/warm latency, hit/miss and primary read count using an actually reproducible workload and documented local conditions; disclose inconclusive findings.
11. Scope stays focused; actual test/experiment evidence and owner confirmation are required before marking implementation status complete.

### Negative/edge experiments

- Missing event, cached null/not-found, event just created, event unpublished or deleted.
- TTL zero/very short/expired; malformed cached JSON; old schema-version key.
- Redis disabled before cold read, disconnected after warm read, network timeout and reconnect.
- Database edit succeeds but cache invalidation fails; cache is repopulated while a concurrent edit occurs.
- Burst of parallel cache misses on a popular event (stampede): characterize load and discuss mitigation without prematurely adding distributed locking.
- Identical ID with different public/private presentation or locale/filter context; prove key scope is safe.
- A forbidden organizer edit and a failed DB transaction; cache must not reveal or present unauthorized changes.
- A last-ticket scenario showing why 200 simultaneous reads of available=1 do not constitute inventory authorization.
- Memory pressure/evictions in a **disposable local** Redis instance only, if desired; avoid disturbing sessions/other live Redis workloads.

### Out of scope / deliberately deferred

- Implementing the full reservation/payment/ticket workflow, queues, background email, distributed locking, multi-region cache clusters, CDN deployment, managed Redis subscriptions, search, large-scale horizontal scaling, and production rollout.
- Making Redis the authoritative booking store, building generalized per-tenant cache infrastructure, or rewriting all repositories to use cache.
- Building a new frontend or a heavy monitoring platform.
- Claiming production-grade consistency/reliability without explicit failure experiments and architectural work.

### Prerequisites, unresolved questions and constraints

- Complete/validate the PostgreSQL increment from lecture 12 first if a real source-backed Redis comparison is required.
- Confirm which existing event-detail endpoint and DTO are available after inspecting code; this lesson note does not invent implemented routes or schema.
- Choose a configurable TTL and public-data eligibility policy based on domain freshness requirements and tests, not an arbitrary production promise.
- Decide whether Redis will be isolated in a local test environment or reused from existing infrastructure; never commit passwords, credentials or private data.
- Specific behavior for read racing with write+invalidation remains a trade-off to investigate, not a solved consistency guarantee.

## Learning completion (ChatGPT)

- [x] Owner explicitly requested uploading the lecture discussion to GitHub on 2026-11-22.
- [x] Conceptual notes, source limitations, diagrams, corrections, review scenario and practical assignment documented.
- [x] Learning tracked independently from implementation in docs/PROGRESS.md.

## Implementation evidence (coding agent)

Status: implemented on branch `feat/lecture-13-caching`; **owner confirmed completion on 2026-11-22**. Decision record: [ADR-012](../decisions/012-public-event-cache.md). Note: the assignment's "lecture 12 not started" prerequisite line is stale; lecture 12 was completed and merged (PR #10), so the real PostgreSQL-backed path was used.

**What changed**
- `src/cache.ts`: `Cache` interface, `RedisCache` (100 ms timeout, no offline queue, background reconnect, error listener), `noCache`, TTL validation.
- `src/modules/events/public-cache.ts`: key scheme, shape validation, counters, invalidate.
- `EventService.getPublic` (cache-aside) used only by `GET /events/:id`; `replace`/`patch`/`remove` invalidate after the write. `docker-compose.yml` gained the `eventhub-redis` service; `.env.example` gained `REDIS_URL`, `CACHE_TTL_SECONDS`, `TEST_REDIS_URL`. Test helpers clear only the `event:public:v1:` prefix.

**Commands and actual results** (Node v24.22.1, Linux, `redis:7-alpine`, PostgreSQL 17 in Docker)
- Baseline before any change: `npm test` 214/214 pass, `npm run typecheck` clean.
- After: `npm test` with Redis: 231 tests, 231 pass; with `TEST_REDIS_URL=` unset: 231 tests, 228 pass, 3 skipped (the Redis-only ones), 0 fail; `npm run typecheck` clean. 17 new tests in `test/caching.test.ts`.
- `npm run experiment:cache` (output in [docs/evidence/lecture-13-cache-latency.txt](../evidence/lecture-13-cache-latency.txt)): 5 rounds x 200 pairs, one synthetic row, localhost. Cold (miss) p50 1.52 to 2.66 ms, warm (hit) p50 0.90 to 1.52 ms; each round had 200 hits, 200 misses and 200 source reads. The gap is about 1 ms on localhost, noisy, and says nothing about production.
- Outage: `docker stop eventhub-redis` mid-run; 100/100 GETs still returned 200 from PostgreSQL (p50 1.04 ms, p95 1.71 ms, max 3.2 ms, 200 cache errors counted). After `docker start`, the first cache hit came back after 430 ms with no app restart (one run).

**Criteria demonstrated by tests:** miss then hit with one source read (1); same body and ETag, 304 served from a hit (3); TTL expiry refreshes from source (4); PUT, PATCH and DELETE visible on the next GET, and a deleted event stops being served (5); failed, forbidden and invalid writes leave the cache alone, and DEL failing after commit still returns success (6); unreachable Redis fails within the timeout and reads fall back (7); only the `{id,name,seats}` public shape is cached (8); a stale cached copy does not affect `TicketService` (9).

**Negative and edge cases:** not-found is not cached; malformed, wrong-shape and wrong-id cached values are treated as misses and replaced; old schema-version keys are simply never read.

**Characterized, deliberately not fixed:** stampede (20 parallel cold reads cause 20 source reads) and the read-vs-invalidate race (an in-flight pre-update read re-caches the old value; bounded by TTL).

**Not done / limitations:** no memory-pressure or eviction experiment; no `X-Forwarded-For` or rate-limit work (not in this assignment's scope); POST /bookings is still a 501 stub, so the "last ticket" case is shown structurally, not with real reservations; single machine, tiny dataset, one-off timings.

- [x] Implementation/experiment performed and changes linked.
- [x] Environment, commands and actual observed results recorded.
- [x] Negative cases, authorization checks and prior regressions demonstrated.
- [x] Owner confirmed implementation completion (2026-11-22) and progress tracker updated independently.
