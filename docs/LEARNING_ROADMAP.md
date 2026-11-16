# Learning roadmap

Course: [Backend from first principles — Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1).

This is the agreed **provisional** implementation roadmap, not a verified transcript or exact live playlist index. YouTube did not expose the full video list during setup. Before each lesson, verify its title and topics against the actual video; adjust the row and preserve sequence if the course differs, adds videos or splits topics. Later positions are especially provisional. Do not treat course topic numbers as playlist positions. Secondary overview: https://github.com/hammadpathan/Learning-Backend-from-First-Principles (learner notes, not authoritative). Cover missing topics in the applicable actual video, not by skipping ahead.

Each row is a proposed increment and its verification exercise. After the owner confirms a learning session is finished, ChatGPT commits the actual lecture note and scoped assignment to main. This note is the canonical handoff for the coding agent; the roadmap is a provisional outline. Implementation evidence is added separately after practical work.

| Playlist position (provisional) | Concept | Increment in EventHub | Acceptance / experiment |
| --- | --- | --- | --- |
| 1 | Roadmap for backend from first principles | [Orientation notes](lectures/01-roadmap.md). | Explain course goals and product boundary. |
| 2 | Walk the path of a true backend engineer | [Learning approach](lectures/02-learning-approach.md). | Explain problem-first experimentation. |
| 3 | What is a Backend, how do they work and why do we need them? | [Backend and request lifecycle](lectures/03-what-is-a-backend.md). | Explain server, port, DNS, transport and HTTP roles. |
| 4 | Benefits of learning backend engineering from first principles | [First-principles benefits](lectures/04-first-principles-benefits.md). | Trace an unfamiliar backend and propose a debugging experiment. |
| 5 | [Understanding HTTP for backend engineers, where it all starts](lectures/05-http.md) | Native HTTP server, /health, simple in-memory event endpoints, methods, status codes, headers, HEAD/OPTIONS, cookies/CORS experiments as covered. | Inspect raw requests/responses with curl; compare success, 404, 405, preflight, HEAD with no body; explain caching and connection behavior. |
| 6 | [Routing](lectures/06-routing.md) | Handwritten router: method/path matching, parameters, grouped and versioned routes, explicit collision rules. | Static vs parameterized routes, constraints/order, 404/405, encoded paths and HTTP regression checks. |
| 7 | Serialization | Read request body, parse JSON, serialize responses and compare formats. | Valid/invalid JSON, unsupported media type, body size and encoding; optional binary format experiment. |
| 8 | Authentication/authorization | User identity, login, safe password hashing, session/token comparison, role and ownership checks. | Reject unauthenticated or wrong-owner requests; distinguish 401 and 403. |
| 9 | Validation/transformation | Normalize and validate event and ticket inputs; consistent field errors. | Reject malformed dates, unsafe values and invalid quantities; no state mutation on invalid input. |
| 10 | Application layers | Introduce handler, service, repository, middleware and request context as appropriate. | Trace one request and compare pre/post-refactor tests. |
| 11 | REST/CRUD | Design event resources, pagination, filtering, sorting, versioning and consistent status/error contracts. | Exercise CRUD, pagination bounds and method semantics. |
| 12 | Database | Replace memory with SQL persistence, migrations, constraints, transactions, indexes and pooling. | Persistence across restart, rollback, constraint violation, query plan; atomic reservation experiment. |
| 13 | Caching | Cache popular event reads, TTL and invalidation; keep inventory authoritative. | Compare cold/warm latency and stale update behavior; cache outage. |
| 14 | Queues/background work | Retryable ticket confirmation email, reservation expiry and background ticket generation as features become available. | Worker restart and retry; no duplicate effect or lost release. |
| 15 | Search | Search event title/location/category; compare SQL and dedicated search index. | Typos, filters, relevance and index update delay; benchmark under local limits. |
| 16 | Error handling | Central error contract, timeout, transient retries and recovery; idempotency where relevant. | Simulate dependency failures, avoid infinite retries and duplicate effects. |
| 17 | Configuration | Validate environment-specific config and use placeholder secrets. | Startup failure on missing config; run test vs dev. |
| 18 | Observability | Structured logs, correlation IDs, latency/error metrics, traces as applicable. | Trace a booking failure; demonstrate actionable signals without sensitive data. |
| 19 | Graceful shutdown | Stop new work, drain in-flight requests/jobs, close resources with timeout. | SIGTERM during active request; demonstrate bounded exit and recovery. |
| 20 | Security | Threat model, access control, secure cookies, rate limit, injection prevention and dependency review. | Negative auth/ownership and abusive input tests; no secret leakage. |
| 21 | Scaling I | Establish load baseline, profile queries and optimize evidenced bottlenecks. | Compare throughput, p95 latency, error rate before/after with workload and hardware recorded. |
| 22 | Scaling II | Multiple stateless instances and local reverse proxy/load balancing. | Requests reach replicas; kill one and observe recovery; shared persistence stays consistent. |
| 23 | Concurrency/parallelism | Booking contention, race-condition reproduction, locking/atomicity and asynchronous vs CPU work. | Many buyers compete for limited tickets; zero overselling and duplicate confirmation. |
| 24 | Object storage I | Move event images and ticket assets to local S3-compatible storage or equivalent. | Restart API; verify assets persist and metadata stays valid. |
| 25 | Object storage II | Direct/presigned uploads, private reads, large-file or multipart experiment. | Expired/unauthorized URL rejected; test size limits and failed upload. |
| 26 | Realtime | SSE/WebSocket ticket availability and booking updates. | Two clients observe changes, reconnect and reconcile with authoritative state. |
| 27 | Testing/code quality | Improve unit, integration, end-to-end and concurrency regression coverage. | Reproduce a defect with a test; verify fix and repeatable test execution. |
| 28 | Twelve-factor principles | Review config, processes, dependencies, logs, disposability and environment parity. | Run same build under different config; restart without losing durable state. |
| 29 | OpenAPI | Publish machine-readable contract and API docs. | Validate request/response samples and detect spec drift. |
| 30 | Webhooks | Mock payment callbacks with signatures, replay defense and idempotent state changes. | Reject invalid signatures; repeated/late callback cannot duplicate confirmation or oversell. |
| 31+ | DevOps/remaining curriculum | Containerize and automate checks, migrations and deployment/rollback when applicable. | Reproducible setup, health probe, tested deployment path. |

Additional coverage if split into distinct videos: request context, CRUD, business logic layer and transactional email should each receive their own incremental exercise. Confirm actual sequence first. For every video, use docs/lectures/TEMPLATE.md and update PROGRESS; merely reading or installing a library is not implementation completion. Track learning and implementation separately.

## After the backend curriculum
Owner reviews milestones, outstanding gaps, API and invariants. Only then select frontend stack, design attendee/organizer/admin screens, integrate real backend endpoints, verify full-stack workflows, and consider deployment. No frontend implementation now.
