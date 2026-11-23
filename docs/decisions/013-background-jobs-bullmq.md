# ADR-013: BullMQ notification jobs on a dedicated durable Redis

Status: Proposed (awaiting owner confirmation of lecture 14 implementation)
Date: 2026-11-23
Related lecture: [14 - Task Queues and Background Jobs](../lectures/14-task-queues-background-jobs.md)

## Context
Lecture 14 asks for a small background-notification lab: producer, queue, separate worker, bounded retries with backoff, crash recovery and duplicate-effect mitigation. `POST /bookings` is still a 501 stub, so no real booking or e-mail exists.

## Decision
- **BullMQ 6.7.8 (+ `ioredis`, its peer dependency)** over a hand-rolled Redis queue: retries, backoff, locks and stalled-job recovery are the subject, and the owner chose the library. Its guarantees are tested here, not assumed.
- **Dedicated Redis `eventhub-queue-redis`** (compose service, port 56380): AOF `everysec`, `noeviction`, own volume. The cache Redis (ADR-012: no persistence, `allkeys-lru`) can silently drop keys, which would lose pending jobs. Configured limit: up to ~1 s of acknowledged writes can be lost on a crash.
- **Trigger: CLI + tests only** (`npm run jobs:enqueue`, `npm run jobs:worker`). No new HTTP route, no fake booking.
- **Payload v1:** `{version, notificationId, recipientRef, correlationId, scenario?}`; ids match `^[A-Za-z0-9_-]{1,64}$`; synthetic references only. `scenario` is a lab-only switch for the mock provider.
- **Retry policy:** 4 attempts, exponential backoff from 1 s (tests use 3 attempts / 50 ms). No jitter (shortcut, noted below). Permanent errors (`InvalidJobError`, `PermanentProviderError`) become `UnrecoverableError`: one attempt, straight to failed. Failed jobs are kept (`removeOnFail: false`) as the inspectable dead-letter list.
- **Per-attempt timeout** (default 5 s, below the 30 s lock): a slow provider is a transient, ambiguous failure.
- **Idempotency:** the logical `notificationId` is the BullMQ job id (`notif-<id>`), the handler's guard row (`notification_deliveries`, atomic upsert, already `sent` means do nothing) and the provider idempotency key (`mock_provider_sent` primary key). Migration `002`.
- **Enqueue truthfulness:** the producer connection has no offline queue and a 2 s bound; failure throws `EnqueueError`. "accepted" means only that Redis stored the job.
- **Instrumentation:** one JSON log line per transition (`jobId, type, state, attempt, durationMs`, sanitized reason without stack or payload) and `queueStats` (counts, oldest waiting age).

## Trade-offs and consequences
- At-least-once: a crash after the side effect and before completion re-runs the job (proved in a test: `attempts` = 2, one recorded effect). That relies on the **provider supporting idempotency keys**; a provider without them can still send twice. Not solved, only documented.
- DB commit and enqueue are two actions; a crash between them loses the intent. A transactional outbox is deferred.
- No jitter, no rate limiting, no scheduler/recurring jobs, no chained or batch jobs (only one-off covered).
- New dependency set (`bullmq`, `ioredis`), one container and two env vars; removable without touching other features.

## Evidence
`backend/test/jobs.test.ts` and the lecture note's implementation section.
