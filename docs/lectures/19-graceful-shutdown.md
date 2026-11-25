# Video 19 — Graceful Shutdown

- Video: [19. Graceful Shutdown](https://www.youtube.com/watch?v=6rfBgphiCWM)
- Course: [Backend from First Principles — Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- Playlist position: 19.
- Duration: 35:56.
- Date documented: 2026-11-25.
- Learning status: Complete (owner explicitly requested the lecture documentation upload after the explanation).
- Implementation status: Not started.
- Source availability: The exact title, video URL, duration and topic outline were verified against [transcript-derived notes](https://github.com/shubhamscifi/backend_from_first_principles_notes/blob/main/19_graceful_shutdown/NOTES.md). The full auto-generated transcript was also reviewed. The original recording was not independently played during this documentation session. The notes identify several caption corrections: “radius” means Redis, “async Q” means the Asynq job library, and the code shown is a Go backend. Claims about the lecture below are grounded in those materials; additional production guidance and EventHub-specific analysis are explicitly labeled supplementary.

## Learning objectives

By the end of this lesson, be able to:

- Explain why a backend process must not simply disappear while it is handling requests or background work.
- Describe a process lifecycle and how operating-system signals communicate a shutdown request.
- Distinguish SIGTERM, SIGINT and SIGKILL, including which signals an application can handle.
- Explain connection draining: stop admitting new work, allow in-flight work to finish, then close.
- Choose and enforce a bounded shutdown deadline.
- Identify resources that need application-level cleanup and reason about dependency-aware cleanup order.
- Trace the shutdown sequence of an HTTP API and a separate queue worker.
- Design a reproducible EventHub experiment that proves graceful behavior and also tests forced termination.

## 1. The problem: a deployment happens during real work

Imagine a user is completing a ticket purchase while a new backend version is being deployed. The old process must eventually stop so the new version can take over. What happens if the old process disappears halfway through the operation?

Possible outcomes include:

- The HTTP connection is cut before the client receives a response.
- A request is interrupted while it is still using the database.
- A background job stops halfway through its work.
- A resource remains open until the operating system reclaims it, while application-level work is left incomplete.
- An external side effect succeeds but the backend does not record or return its result.

The video opens with a payment-in-progress scenario and asks whether a transaction can be lost or a customer can be charged twice during a deployment. It acknowledges that zero-downtime deployment techniques can bring a new server up before taking the old one down, but there is still a handover moment when the old server must stop receiving traffic.

**Graceful shutdown** is the controlled process of stopping an application: finish work that is already in progress, clean up resources, and then exit instead of terminating abruptly.

The instructor describes this as giving the backend “good manners”: do not slam the door while guests are still inside; stop admitting new guests, let existing guests finish, clean up, and then close.

### Why this matters

A deployment is not allowed to redefine a successful operation as a failed one. The application must preserve correct state and give callers a predictable outcome as far as it can. Graceful shutdown reduces avoidable interruption, but it is not a guarantee against every crash or duplicate side effect. Durable state, idempotency and recovery are still necessary; those are supplementary reliability concerns discussed later in this note.

## 2. Process lifecycle management

A backend application runs as an operating-system process. The operating system creates and schedules that process, gives it an execution context and resources, and tracks it until it exits.

A process lifecycle can be viewed at a high level as:

~~~mermaid
stateDiagram-v2
    [*] --> Starting
    Starting --> Running: initialization succeeds
    Starting --> Exited: startup fails
    Running --> Draining: shutdown requested
    Draining --> CleaningUp: in-flight work has finished
    CleaningUp --> Exited: resources released
    Draining --> ForcedExit: deadline exceeded
    Running --> ForcedExit: SIGKILL / crash
    ForcedExit --> [*]
    Exited --> [*]
~~~

The operating system and the application have different responsibilities:

- The operating system controls process execution and can deliver a termination signal.
- The application understands its own work: active HTTP requests, database operations, queue jobs, sockets, timers and other resources.
- A process manager or orchestrator may request termination and later enforce a hard deadline.

The operating system does not know the business meaning of a booking, notification or payment. The application must implement the cleanup policy.

## 3. Signals and inter-process communication

The video introduces Unix signals as an operating-system mechanism for notifying a process about an event or requested action. Signals are one form of inter-process communication (IPC). They are not HTTP requests or JSON messages.

An application can register handlers for signals it is allowed to handle. When a handled signal is delivered, the runtime can invoke the application's registered callback or handler so the application can begin its shutdown procedure.

~~~mermaid
sequenceDiagram
    participant M as Process manager / terminal
    participant K as Operating system kernel
    participant P as Backend process
    participant H as Shutdown handler
    M->>K: Send SIGTERM or SIGINT
    K->>P: Deliver signal
    P->>H: Runtime invokes registered handler
    H->>P: Begin draining and cleanup
    P-->>M: Process eventually exits
~~~

Important correction to the “conversation” analogy: a signal is not an acknowledgement protocol where the operating system automatically waits for the application to finish. The process manager normally owns the overall deadline. If the process has not exited by that deadline, the manager can force termination.

### The three signals in the video

| Signal | Typical trigger | Can application handle it? | Meaning |
| --- | --- | --- | --- |
| SIGTERM (15) | Process manager, deployment tool or orchestrator | Yes | Request termination; the application can perform graceful shutdown. |
| SIGINT (2) | Ctrl+C in a terminal foreground process group | Yes | Interrupt request, commonly used by a developer during local work. |
| SIGKILL (9) | Forced termination by an operator or supervisor | No | The kernel terminates the process; no application cleanup handler can run. |

#### SIGTERM — the normal shutdown request

SIGTERM is the signal commonly sent by process managers and deployment/orchestration systems such as systemd, PM2 and Kubernetes. If the application has registered a handler, it can stop admitting work, drain active operations, release resources and exit.

A SIGTERM signal by itself does not make the application graceful. The application must implement the handler and cleanup sequence.

#### SIGINT — Ctrl+C

SIGINT is commonly produced when a developer presses Ctrl+C in a terminal. It is often useful to run the same shutdown workflow for SIGINT and SIGTERM: the initiating actor differs, but the application's desired outcome is the same.

#### SIGKILL — forced termination

SIGKILL cannot be caught, blocked or ignored by the target process. No JavaScript/Go/Python cleanup callback can run in response to SIGKILL. Open process resources are reclaimed by the operating system, but unfinished application-level work may be interrupted.

This is why SIGKILL is a last resort, not a graceful shutdown mechanism.

### Useful Linux commands

For a process with PID 4821:

~~~bash
kill -SIGTERM 4821
kill -SIGINT 4821
kill -SIGKILL 4821
~~~

The command named kill sends a signal. It does not always mean immediate forced termination; the selected signal determines the behavior.

**Scope note:** this lesson focuses on Unix/Linux process signals, which are common for backend deployments. Windows has different process-control mechanisms.

## 4. The graceful shutdown sequence

The instructor summarizes the shutdown work as three steps:

1. Finish existing requests.
2. Clean up resources.
3. Exit.

The detailed connection-draining explanation makes the ordering more explicit:

~~~mermaid
flowchart TD
    A[Receive SIGTERM or SIGINT] --> B[Enter draining state]
    B --> C[Stop admitting new work]
    C --> D[Wait for in-flight requests and jobs]
    D --> E{Finished before deadline?}
    E -->|Yes| F[Close dependent resources]
    E -->|No| G[Force remaining work to stop]
    F --> H[Flush final logs / telemetry]
    H --> I[Exit]
    G --> I
~~~

A production application often needs a separate “not ready” or draining state before it closes its listening socket. This allows a load balancer or service-discovery mechanism to stop routing new traffic to the instance. The video explicitly notes that connection draining must coordinate with load balancers, health checks and service discovery.

### 4.1 Stop accepting new work

The first step is to prevent new work from continually arriving while the process is trying to finish existing work.

For an HTTP API this means stopping new connections or requests from being admitted by the instance. For a queue worker it means stopping the acquisition of new jobs. For a WebSocket service it means no longer accepting new sessions and preparing existing sessions for closure.

A process that keeps accepting new requests may never drain: requests finish, but new ones keep arriving.

### 4.2 Finish in-flight work

An **in-flight request** is a request the server has already accepted and is still processing.

The video uses a restaurant analogy: stop letting new customers enter, tell existing customers the restaurant is closing, and give them a reasonable period to finish.

The same high-level principle applies to different backend components:

| Component | Draining behavior |
| --- | --- |
| HTTP server | Stop admitting new work and let active requests finish. |
| Database server/application | Finish or safely abort active queries and transactions before closing connections. |
| WebSocket server | Notify clients that the connection is closing, allow a controlled close, then release sockets. |
| Background worker | Stop fetching new jobs and allow active jobs to finish within a bounded period. |

The implementation is architecture- and library-specific. A generic “close all connections now” operation is not equivalent to graceful draining.

### 4.3 Enforce a shutdown deadline

The video gives 30 seconds as a common illustrative timeout and mentions 60 seconds as another possible value, while emphasizing that the right value depends on the application.

The trade-off:

- Too short: legitimate operations may be interrupted.
- Too long: deployment and process replacement become slow; resources remain occupied longer.
- Unbounded: a stuck request or worker can prevent the process from exiting indefinitely.

The application's own shutdown deadline should fit inside the larger termination grace period enforced by its process manager or orchestrator, leaving time for final cleanup and exit. These are separate budgets: an application timeout does not automatically extend the supervisor's deadline.

If the deadline expires, the application needs an explicit policy for remaining work. The process manager may ultimately send SIGKILL. Do not assume that every active operation can be safely completed after the deadline.

### 4.4 Coordinate with traffic management

The video mentions load balancers, health checks and service discovery. A useful distinction is:

- **Liveness:** is the process alive?
- **Readiness:** should this instance receive new traffic?

A process may still be alive and completing requests while it is no longer ready to receive new traffic. This is a supplementary production distinction that helps implement the coordination described in the video.

## 5. Resource cleanup

After in-flight work has drained, the application must release resources it acquired during its lifetime. The video names:

- File handles.
- Network connections.
- Database connections and connection pools.
- Temporary files.
- Caches.
- Other operating-system or application resources.

Why clean them up explicitly?

- Open file handles and sockets consume operating-system resources.
- Database connections occupy pool slots and server-side capacity.
- A checked-out database client may still be executing a query or transaction.
- Background workers may still need their database or queue connection.
- Buffered logs or telemetry may not yet have been written or exported.

The operating system reclaims many process-owned resources when a process exits. That does not replace application-level cleanup: the operating system cannot decide whether an email should be retried, whether a job should be acknowledged, whether a business transaction is complete, or whether an external side effect needs reconciliation.

### 5.1 Transactions: commit or rollback based on business outcome

The video says active database transactions should be committed or rolled back explicitly before connections are closed. The important engineering nuance is that shutdown must not blindly commit a transaction just because the process is leaving.

- Commit only when the business operation has reached its valid commit point.
- Roll back when the operation is incomplete or failed.
- If the outcome is unknown, use the database/provider's durable state and reconciliation strategy rather than guessing.

A transaction that has not committed is normally rolled back when its database session is lost, but an external payment or email provider is outside that database transaction.

### 5.2 Cleanup order and dependencies

The video gives the rule: release resources in the reverse order in which they were acquired. This is a useful stack-like default because later resources often depend on earlier ones.

A more general engineering formulation is: **stop dependents before closing the dependencies they still need.**

Example:

~~~mermaid
flowchart TD
    A[Database pool] --> B[Repository / service]
    B --> C[HTTP handlers]
    B --> D[Queue worker]
    C --> E[HTTP server]
    D --> F[Worker process]
~~~

The arrows represent dependency direction: handlers and workers use application services and the database. During shutdown, stop the entry points and wait for their work first; then close the dependencies they use.

Do not copy a cleanup order without inspecting the dependency graph. A worker that is still processing jobs may need the database pool. Closing the pool before draining that worker can cause the very failures graceful shutdown is intended to avoid.

## 6. The Go implementation shown in the video

The video uses a Go backend called tasker to demonstrate the lifecycle. It is a practical illustration, not a requirement to adopt Go or that codebase.

### 6.1 Registering a signal wait

The visible main.go example uses Go's signal.NotifyContext, waits for the context to finish, creates a timeout context and calls the server's shutdown method.

Simplified shape of the code shown:

~~~go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)

// Start the server in a goroutine...

<-ctx.Done()

ctx, cancel := context.WithTimeout(
    context.Background(),
    DefaultContextTimeout*time.Second,
)
defer cancel()

if err := srv.Shutdown(ctx); err != nil {
    // Shutdown did not finish within the deadline.
}
stop()
~~~

**Code-level caveat (supplementary review):** the snippet shown registers os.Interrupt, which covers the interrupt signal used by Ctrl+C. On Unix, a production service that must also respond to SIGTERM needs to register SIGTERM explicitly as well. The conceptual explanation covers both SIGINT and SIGTERM, but this particular snippet alone should not be copied as a complete production signal list.

### 6.2 Server shutdown method

The visible server.go example has this overall order:

1. Shut down the HTTP server with a context deadline.
2. Close the database connection pool.
3. Stop the background job server.

The instructor explains that the HTTP server's shutdown method stops accepting additional connections and waits for existing work; the database pool is then closed; the Asynq-backed job server is stopped and its Redis connections are released.

**Dependency caveat (supplementary review):** if background job handlers still need the database, stopping the worker after closing the database is unsafe. The correct order depends on the actual dependencies and whether the job server is a separate process. EventHub's worker handler uses PostgreSQL, so EventHub must drain/close the worker before closing that worker process's PostgreSQL pool. Do not copy the demo's sequence blindly.

### 6.3 What the terminal demo shows

The instructor runs the Go backend with task run, presses Ctrl+C, and points to logs showing:

- The interrupt signal is received.
- The database connection pool is closed.
- The background job server begins graceful shutdown.
- Asynq waits for workers to finish.
- Workers finish and the job server exits.
- The application logs that the server exited properly.

The transcript-derived notes report about one second between the interrupt and the final exit in the shown local run, where there were no in-flight HTTP requests. This is an observation from that demo, not a benchmark or a general shutdown-time guarantee.

## 7. Production considerations and failure scenarios

The following are supplementary engineering explanations that extend the video's principles.

### 7.1 Graceful shutdown is not crash-proofing

A process can be killed by SIGKILL, an out-of-memory event, a host failure or power loss. No shutdown handler can run in those cases.

Therefore:

- Persist important state before acknowledging success.
- Make retryable operations idempotent.
- Use durable queues and recovery semantics.
- Reconcile ambiguous external side effects.
- Treat graceful shutdown as one reliability layer, not the only one.

### 7.2 A lost HTTP response can still lead to a duplicate request

Consider this sequence:

~~~mermaid
sequenceDiagram
    participant C as Client
    participant A as EventHub API
    participant D as PostgreSQL
    C->>A: Submit operation with idempotency key K
    A->>D: Commit operation result for K
    D-->>A: Commit succeeds
    Note over A,C: Process exits before response reaches client
    C->>A: Retry same operation with key K
    A->>D: Look up K
    D-->>A: Return previously stored result
    A-->>C: Same logical result; no duplicate effect
~~~

Graceful shutdown can reduce the chance of losing the response, but it cannot guarantee the client receives it. The operation may already have committed. A retry must not create a second booking, charge or ticket. This requires an idempotency design and a durable record of the operation's outcome, not just a shutdown handler.

### 7.3 Background jobs are commonly at-least-once

A worker can perform an external side effect and crash before acknowledging job completion. The queue may later deliver the job again. Graceful shutdown reduces avoidable mid-job termination, but crash recovery still requires idempotent effects.

EventHub already has a BullMQ worker experiment and a crash-recovery/idempotency lab. Reuse that existing foundation; do not assume that worker.close() creates exactly-once processing.

### 7.4 Long-lived connections need special treatment

Ordinary HTTP requests, keep-alive connections, WebSockets and upgraded sockets do not all have identical lifecycles. A server's standard shutdown method may not automatically manage every upgraded or application-owned connection. Track and close long-lived connections according to their protocol and library contract.

### 7.5 Timeout wrappers do not necessarily cancel work

Racing a promise against a timer only stops waiting for the promise; it does not necessarily cancel the underlying I/O or operation. Use cancellation-aware APIs (for example, AbortSignal where supported), server/worker shutdown APIs and explicit resource ownership. Test that the work actually stops or completes rather than assuming a timeout wrapper has cancelled it.

### 7.6 Avoid exiting before cleanup finishes

Calling an immediate process-exit function from the first signal callback can truncate asynchronous cleanup or buffered output. Prefer to stop accepting work, await cleanup, set an appropriate exit code and allow the event loop to finish. Keep a separate hard deadline so a genuinely stuck process cannot remain forever.

### 7.7 Multiple signals and startup races

A shutdown handler should be idempotent: a second SIGTERM or SIGINT must not start a second concurrent cleanup sequence. Define whether a repeated signal is logged, ignored, or escalates to forced shutdown. Also consider a signal arriving while dependencies are still initializing or before the HTTP listener has started.

## 8. EventHub current state (inspected on 2026-11-25)

This section records the repository state observed while preparing the assignment. It is not an implementation claim.

- Backend: native node:http with TypeScript; no HTTP framework. The package uses Node.js types and tsx.
- HTTP API: backend/src/server.ts creates and exports the HTTP server. The main-entry block calls server.listen(...). The inspected file has no SIGTERM/SIGINT shutdown handler.
- Health endpoint: /health currently returns a static { "status": "ok" } response. Do not silently change its established behavior; consider a separate readiness contract if the assignment needs one.
- Database: backend/src/db/pool.ts exports one PostgreSQL pool with a maximum of 10 connections and a 2-second connection timeout.
- Cache: backend/src/cache.ts provides an optional Redis cache. The concrete RedisCache has a close() method, but the exported cache is typed through the Cache interface, which does not currently expose lifecycle cleanup. Inspect this boundary before changing it.
- Queue: ADR-013 uses BullMQ on a dedicated queue Redis, separate from the optional cache Redis.
- Worker: backend/src/jobs/worker-main.ts runs as a separate process, registers SIGINT and SIGTERM handlers, calls worker.close(), then pool.end(), and finally calls process.exit(0). Review duplicate-signal behavior, timeout handling, final logging and whether immediate exit is necessary.
- Tests: backend/test/jobs.test.ts already contains a worker crash-recovery experiment. The inspected test suite does not show a dedicated end-to-end graceful-drain test for the API process.
- Product boundary: POST /bookings is currently a 501 stub. EventHub has no real booking or payment flow; do not invent one for this lesson.

The API and worker are separate processes. Each process must manage its own signal handling and its own resources. The API process should not assume it can shut down the worker process's resources, and vice versa.

## 9. Discussion and misconceptions

### Question raised during the learning session

**Scenario:** PostgreSQL successfully commits an operation, but the backend exits before sending the HTTP response. The client assumes the request failed and retries it. Is graceful shutdown alone enough to prevent duplicate bookings or charges?

- Learner answer: not recorded before the documentation upload request.
- Expected engineering conclusion: no. Graceful shutdown can reduce avoidable interruptions but cannot guarantee response delivery or exactly-once external effects. The operation needs a stable idempotency key, a durable record of the result, and safe replay/reconciliation behavior.

### Common misconceptions

- **“SIGTERM automatically makes my app graceful.”** No. The application must register and implement the shutdown workflow.
- **“SIGTERM and SIGKILL are equivalent.”** No. SIGTERM can be handled; SIGKILL cannot.
- **“Ctrl+C is SIGKILL.”** Normally Ctrl+C sends SIGINT to the terminal's foreground process group.
- **“The OS will clean everything up, so application cleanup is unnecessary.”** The OS reclaims process resources, but it cannot complete business workflows or reconcile external side effects.
- **“Connection draining means closing every socket immediately.”** No. Stop new work first and let eligible in-flight work finish.
- **“A shutdown timeout means every operation is cancelled when the timer fires.”** Not necessarily; cancellation must reach the underlying operation.
- **“Graceful shutdown guarantees zero downtime.”** No. It is one part of a safe handover; traffic management and a healthy replacement are separate concerns.
- **“Graceful shutdown guarantees exactly-once jobs or payments.”** No. Idempotency and durable recovery are still needed.
- **“Reverse acquisition order is a substitute for dependency analysis.”** No. Inspect which components still need which resources.

## 10. Key takeaways and references

The core mental model:

**Stop accepting new work → finish in-flight work → clean up dependencies safely → exit within a deadline.**

Remember:

- SIGTERM is the normal process-manager shutdown request.
- SIGINT is commonly triggered by Ctrl+C.
- SIGKILL is uncatchable and allows no application cleanup.
- Connection draining is admission control plus a bounded wait for active work.
- Cleanup must respect resource dependencies.
- A hard deadline prevents a stuck process from blocking deployment forever.
- Durable state, idempotency and recovery protect against failures that graceful shutdown cannot prevent.

### Primary lecture sources

- [Video 19 — Graceful Shutdown](https://www.youtube.com/watch?v=6rfBgphiCWM)
- [Course playlist](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- [Transcript-derived notes and whiteboard/code walkthrough](https://github.com/shubhamscifi/backend_from_first_principles_notes/blob/main/19_graceful_shutdown/NOTES.md)
- [Auto-generated transcript](https://github.com/shubhamscifi/backend_from_first_principles_notes/blob/main/19_graceful_shutdown/transcript.md)

### Supplementary technical references

- [Node.js HTTP server API](https://nodejs.org/api/http.html#class-httpserver)
- [Node.js process signal events](https://nodejs.org/api/process.html#signal-events)
- [Go net/http — Server.Shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
- [Go os/signal — NotifyContext](https://pkg.go.dev/os/signal#NotifyContext)
- [BullMQ — Graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown)
- [node-postgres — Pool.end](https://node-postgres.com/apis/pool#poolend)
- [Kubernetes — Pod termination lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle#pod-termination)

## EventHub practical assignment — coding agent handoff

### Problem and learning goal

EventHub has two independently running backend processes with different shutdown responsibilities:

1. The HTTP API process in backend/src/server.ts.
2. The BullMQ worker process in backend/src/jobs/worker-main.ts.

The API currently has no visible SIGTERM/SIGINT handler in the inspected main-entry path. The worker already registers both signals, but its current handler has no visible duplicate-signal guard or bounded shutdown deadline and calls process.exit(0) after cleanup. The goal is to make each process stop admitting work, drain what it owns, close its dependencies in a safe order and exit within a configured deadline.

Do not build a new service or add deployment infrastructure. Inspect the latest code before implementation because this note records the repository state as of 2026-11-25.

### In scope

#### A. HTTP API process

1. Register SIGTERM and SIGINT handlers in the API process.
2. Make the shutdown sequence idempotent so concurrent or repeated signals cannot start overlapping cleanup.
3. Enter a draining/not-ready state before completing shutdown. Preserve the current /health contract; if readiness needs to be observable, introduce a separate, clearly named readiness contract rather than silently changing /health.
4. Stop accepting new connections/requests using the native Node HTTP server lifecycle API.
5. Allow active requests to finish within a configurable application shutdown deadline.
6. After request handling has stopped, close the optional cache connection if one exists and end the PostgreSQL pool. The exact order must follow the actual dependency graph.
7. Emit structured lifecycle logs for signal received, draining started, HTTP listener closed, resources closed, timeout/failure and final exit. Do not log connection URLs, credentials, tokens, request bodies or other secrets.

#### B. BullMQ worker process

1. Keep worker shutdown separate from API shutdown; it is a different OS process.
2. Stop fetching new jobs and use the BullMQ worker's supported graceful-close behavior to wait for active jobs.
3. Close the worker's queue connections and then close the PostgreSQL pool only after active job handlers no longer need it.
4. Add an idempotent signal guard and a bounded shutdown deadline.
5. Avoid an immediate exit that truncates cleanup or logs; use a deliberate exit-code strategy and a hard deadline.
6. Preserve the existing retry, stalled-job recovery and idempotency behavior from ADR-013.

#### C. Shared lifecycle behavior

- Handle both SIGTERM and SIGINT consistently.
- Make shutdown behavior observable through sanitized structured logs.
- Ensure cleanup continues best-effort if one cleanup action fails, while recording the failure and returning a non-zero outcome where appropriate.
- Distinguish an application-level shutdown deadline from the larger process-manager/container termination grace period.
- Do not claim that a timeout wrapper cancels an operation unless the underlying API actually supports cancellation.

### Suggested experiments

1. **Slow HTTP request:** use a test-only handler or isolated test server that deliberately takes 10 seconds to respond. Start the request, send SIGTERM after 2 seconds, and verify that the request completes before the process exits. Do not leave a public debug endpoint in the application.
2. **New traffic during drain:** after the shutdown signal, attempt another connection/request. Verify that the old instance does not admit new work and that the client receives a predictable connection failure or readiness response, according to the chosen implementation.
3. **Active queue job:** run a deliberately slow mock job, send SIGTERM while it is active, and verify that the worker stops acquiring new jobs and lets the active job finish within the deadline.
4. **Forced crash:** use SIGKILL during an active job and verify that the existing BullMQ stalled-job recovery and idempotency safeguards still prevent duplicate recorded effects. Reuse or extend the existing crash-recovery test rather than replacing it.
5. **Repeated signals:** send SIGTERM twice (or SIGINT followed by SIGTERM). Verify that only one cleanup sequence runs and that the chosen escalation policy is explicit.
6. **Deadline exceeded:** simulate a request/job that cannot finish before the configured deadline. Verify the process exits within the overall budget and records which work was not drained.
7. **Cleanup failure:** make an optional dependency unavailable during shutdown. Verify that other required cleanup still runs and that logs/outcome accurately report the failure.
8. **Regression:** run the existing backend tests and typecheck. Preserve the existing /health, HTTP behavior, cache fallback and queue semantics.

### Acceptance criteria

- [ ] API process handles SIGTERM and SIGINT.
- [ ] Worker process handles SIGTERM and SIGINT without overlapping shutdown sequences.
- [ ] New HTTP work is no longer admitted after draining starts.
- [ ] In-flight HTTP requests can finish within the configured deadline.
- [ ] Worker stops fetching new jobs and drains active jobs within its deadline.
- [ ] The worker's PostgreSQL pool is not closed while active handlers still depend on it.
- [ ] Optional cache and required database resources are closed safely after their dependents stop.
- [ ] A deadline-exceeded path is bounded, observable and tested.
- [ ] Repeated signals do not run cleanup concurrently.
- [ ] SIGKILL recovery continues to rely on durable queue state and idempotency, not on cleanup handlers.
- [ ] Lifecycle logs are structured and contain no secrets or sensitive payloads.
- [ ] Existing tests and typecheck pass; actual commands and results are recorded by the coding agent.
- [ ] The implementation remains within the current backend architecture and does not introduce deployment infrastructure.

### Important edge cases

- Signal arrives during application startup or before the listener begins accepting connections.
- No active requests/jobs exist: shutdown should still close resources cleanly.
- A request or job is stuck in non-cancellable I/O.
- A job performs its external effect but crashes before acknowledgement.
- Database pool close is attempted while a handler still holds a client.
- Redis cache is optional or disconnected; queue Redis is separate and must not be confused with it.
- A second signal arrives during draining.
- Shutdown cleanup itself throws or times out.
- Long-lived keep-alive or upgraded connections require explicit treatment.
- The process manager's termination deadline is shorter than the application's configured wait.

### Out of scope / deliberately deferred

- Implementing booking or real payment processing; /bookings remains a 501 stub in the inspected code.
- Building a zero-downtime deployment platform, load balancer, Kubernetes manifests or service discovery.
- Distributed coordination across multiple API replicas.
- WebSocket lifecycle work; EventHub does not currently need it.
- A transactional outbox or new exactly-once delivery claim.
- Refactoring the entire server, changing the HTTP framework, or adding a new queue.
- Treating implementation as complete merely because the documentation is committed.

### Prerequisites and decisions

- Confirm the installed Node.js runtime and exact HTTP server shutdown semantics used by the project.
- Confirm BullMQ 6.7.8 worker close behavior and the installed node-postgres pool close behavior against the APIs in use.
- Select an application shutdown timeout that fits the eventual deployment grace period; deployment settings are not part of this lesson.
- Decide how readiness is exposed without breaking the existing /health response.
- Inspect the full resource dependency graph before fixing cleanup order.

## Learning completion (ChatGPT)

- [x] Owner explicitly requested the lecture documentation upload after the explanation.
- [x] Conceptual notes, source limitations, discussion question and practical assignment documented.
- [x] Learning status updated independently in docs/PROGRESS.md.

## Implementation evidence (coding agent; pending)

No EventHub implementation or shutdown experiment was performed as part of this learning documentation.

- [ ] API graceful shutdown implemented and tested.
- [ ] Worker graceful shutdown reviewed/implemented and tested.
- [ ] Acceptance criteria demonstrated.
- [ ] Negative cases and regression checks recorded.
- [ ] Implementation progress updated and learner confirmed.
