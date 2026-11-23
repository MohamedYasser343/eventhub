import { Queue, UnrecoverableError, Worker } from "bullmq";
import type pg from "pg";
import {
  handleNotification,
  InvalidJobError,
  NOTIFICATION_JOB,
  parsePayload,
  PermanentProviderError,
  type EmailProvider,
  type NotificationPayload,
} from "./notification.ts";

// Lecture 14: producer + worker on BullMQ, over a DURABLE Redis that is NOT the cache
// Redis (see ADR-013). Queue data and cache data never share an instance.

export const QUEUE_NAME = "eventhub-notifications";

export interface RetryPolicy {
  attempts: number; // total tries including the first
  baseDelayMs: number; // exponential: base, 2x, 4x ...
}
export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 1_000 };

export type JobState = "active" | "completed" | "retry_scheduled" | "failed";
export interface JobLogEvent {
  jobId: string;
  type: string;
  state: JobState;
  attempt: number; // 1-based try number
  durationMs: number;
  reason?: string; // sanitized: error class + short message, never a stack or the payload
}
export type JobLogger = (e: JobLogEvent) => void;
export const consoleLogger: JobLogger = (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));

// ---------- producer ----------
export class EnqueueError extends Error {}

export function createJobQueue(opts: { url: string; name?: string; prefix?: string }): Queue {
  // Fail fast while Redis is unreachable: the producer must say so, not hang.
  const queue = new Queue(opts.name ?? QUEUE_NAME, {
    connection: { url: opts.url, enableOfflineQueue: false, connectTimeout: 1_000 },
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  });
  queue.on("error", () => {}); // never crash on a connection error; never log the URL
  return queue;
}

export interface EnqueueResult {
  // "accepted" means ONLY that Redis stored the job. It says nothing about the e-mail.
  status: "accepted";
  jobId: string;
}

// Validates, then stores the job. The BullMQ job id is derived from the logical
// notification id, so enqueueing the same notification twice does not create a second
// job while the first still exists (a replay after completion is stopped by the handler).
export async function enqueueNotification(
  queue: Queue,
  payload: NotificationPayload,
  retry: RetryPolicy = DEFAULT_RETRY,
  timeoutMs = 2_000,
): Promise<EnqueueResult> {
  parsePayload(payload);
  const jobId = `notif-${payload.notificationId}`;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add(NOTIFICATION_JOB, payload, {
        jobId,
        attempts: retry.attempts,
        backoff: { type: "exponential", delay: retry.baseDelayMs },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: false, // failed jobs stay inspectable: this is the lab's "dead letter" list
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } catch {
    // Never claim "queued" when Redis did not confirm.
    throw new EnqueueError("could not enqueue: queue backend unavailable");
  } finally {
    clearTimeout(timer);
  }
  return { status: "accepted", jobId };
}

// ---------- worker ----------
export interface WorkerOptions {
  url: string;
  db: pg.Pool;
  provider: EmailProvider;
  name?: string;
  prefix?: string;
  log?: JobLogger;
  concurrency?: number;
  processingTimeoutMs?: number; // per attempt; must stay below lockDurationMs
  lockDurationMs?: number; // how long a worker may hold a job before it counts as stalled
  stalledIntervalMs?: number;
}

export function startWorker(o: WorkerOptions): Worker {
  const log = o.log ?? consoleLogger;
  const worker = new Worker(
    o.name ?? QUEUE_NAME,
    async (job) => {
      if (job.name !== NOTIFICATION_JOB) throw new UnrecoverableError(`InvalidJobError: unknown job type`);
      try {
        return await handleNotification(job.data, job.attemptsMade, {
          db: o.db,
          provider: o.provider,
          timeoutMs: o.processingTimeoutMs ?? 5_000,
        });
      } catch (err) {
        // Permanent errors must not be retried: UnrecoverableError sends the job
        // straight to "failed" instead of burning the remaining attempts.
        if (err instanceof InvalidJobError || err instanceof PermanentProviderError) throw new UnrecoverableError(describe(err));
        throw err; // anything else: transient, retried with backoff until attempts run out
      }
    },
    {
      // BullMQ requires maxRetriesPerRequest: null on the blocking worker connection.
      connection: { url: o.url, maxRetriesPerRequest: null },
      ...(o.prefix ? { prefix: o.prefix } : {}),
      concurrency: o.concurrency ?? 1,
      lockDuration: o.lockDurationMs ?? 30_000,
      stalledInterval: o.stalledIntervalMs ?? 15_000,
      maxStalledCount: 1,
    },
  );
  worker.on("error", () => {});
  worker.on("active", (job) => log({ jobId: String(job.id), type: job.name, state: "active", attempt: job.attemptsMade + 1, durationMs: 0 }));
  worker.on("completed", (job) =>
    log({ jobId: String(job.id), type: job.name, state: "completed", attempt: job.attemptsMade, durationMs: (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now()) }),
  );
  worker.on("failed", (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    log({
      jobId: String(job.id),
      type: job.name,
      state: final ? "failed" : "retry_scheduled",
      attempt: job.attemptsMade,
      durationMs: Date.now() - (job.processedOn ?? Date.now()),
      reason: describe(err),
    });
  });
  return worker;
}

function describe(err: unknown): string {
  const e = err instanceof Error ? err : new Error("non-error thrown");
  return `${e.constructor.name}: ${e.message}`.replace(/\s+/g, " ").slice(0, 120);
}

// ---------- minimal instrumentation ----------
export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  oldestWaitingAgeMs: number | null;
}

export async function queueStats(queue: Queue): Promise<QueueStats> {
  const c = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  const oldest = (await queue.getWaiting(0, 0))[0];
  return {
    waiting: c["waiting"] ?? 0,
    active: c["active"] ?? 0,
    delayed: c["delayed"] ?? 0,
    failed: c["failed"] ?? 0,
    completed: c["completed"] ?? 0,
    oldestWaitingAgeMs: oldest ? Date.now() - oldest.timestamp : null,
  };
}
