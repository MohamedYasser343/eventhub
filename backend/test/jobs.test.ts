import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Queue, Worker } from "bullmq";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handleNotification, MockEmailProvider, parsePayload } from "../src/jobs/notification.ts";
import type { NotificationPayload } from "../src/jobs/notification.ts";
import { createJobQueue, EnqueueError, enqueueNotification, queueStats, startWorker } from "../src/jobs/queue.ts";
import type { JobLogEvent } from "../src/jobs/queue.ts";

// Real Redis (the dedicated queue instance) + real PostgreSQL. Skipped without TEST_QUEUE_REDIS_URL.
const url = process.env.QUEUE_REDIS_URL;
const opts = url ? {} : { skip: "TEST_QUEUE_REDIS_URL not set" };
const FAST = { attempts: 3, baseDelayMs: 50 };

// Every test gets its own key prefix, so tests never see each other's jobs and cleanup
// removes only this prefix (obliterate), never FLUSHALL.
const queues: Queue[] = [];
const workers: Worker[] = [];
function setup() {
  const prefix = `eventhub-test-${randomUUID().slice(0, 8)}`;
  const queue = createJobQueue({ url: url!, prefix });
  queues.push(queue);
  const events: JobLogEvent[] = [];
  const start = (extra: { lockDurationMs?: number; stalledIntervalMs?: number; concurrency?: number; processingTimeoutMs?: number; allowCrash?: boolean } = {}) => {
    const w = startWorker({ url: url!, db: pool, prefix, provider: new MockEmailProvider(pool), log: (e) => events.push(e), ...extra });
    workers.push(w);
    return w;
  };
  return { prefix, queue, events, start };
}
const payload = (id: string, scenario?: string): NotificationPayload => ({
  version: 1,
  notificationId: id,
  recipientRef: "synthetic-user-1",
  correlationId: "req-1",
  ...(scenario ? { scenario } : {}),
});
const sent = async (id: string) => (await pool.query("SELECT 1 FROM mock_provider_sent WHERE idempotency_key = $1", [id])).rowCount;
const delivery = async (id: string) => (await pool.query<{ status: string; attempts: number }>("SELECT status, attempts FROM notification_deliveries WHERE notification_id = $1", [id])).rows[0];

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const jobState = (queue: Queue, id: string) => async () => {
  const j = await queue.getJob(`notif-${id}`);
  const s = j ? await j.getState() : undefined;
  return s === "completed" || s === "failed" ? { state: s, job: j! } : undefined;
};

before(async () => {
  await migrate(pool);
  await pool.query("TRUNCATE notification_deliveries, mock_provider_sent");
});
after(async () => {
  await Promise.all(workers.map((w) => w.close(true).catch(() => {})));
  for (const q of queues) {
    await q.obliterate({ force: true }).catch(() => {});
    await q.close().catch(() => {});
  }
});

// ---------- payload validation (no Redis needed) ----------
test("payload: strict version and id format; unknown scenario is a controlled error", async () => {
  assert.equal(parsePayload(payload("ok-1")).notificationId, "ok-1");
  for (const bad of [null, [], "x", {}, { ...payload("a"), version: 2 }, { ...payload("a"), notificationId: "has space" }, { ...payload("a"), recipientRef: "" }, { ...payload("a"), notificationId: "x".repeat(65) }]) {
    assert.throws(() => parsePayload(bad), /payload|version|malformed/);
  }
  const provider = new MockEmailProvider(pool);
  await assert.rejects(provider.send({ idempotencyKey: "u-1", recipientRef: "r", scenario: "nonsense", attempt: 0 }), /unknown scenario/);
});

// ---------- producer / worker lifecycle ----------
test("producer returns before the slow provider finishes; the worker completes it later", opts, async () => {
  const { queue, events, start } = setup();
  const t0 = Date.now();
  const r = await enqueueNotification(queue, payload("slow-1", "slow:600"), FAST);
  const enqueueMs = Date.now() - t0;
  assert.deepEqual(r, { status: "accepted", jobId: "notif-slow-1" });
  assert.ok(enqueueMs < 300, `enqueue took ${enqueueMs} ms, it must not include the 600 ms provider delay`);
  assert.equal(await sent("slow-1"), 0, "accepted != sent: nothing has been sent yet");
  start();
  const done = await until(jobState(queue, "slow-1"));
  assert.equal(done.state, "completed");
  assert.equal(await sent("slow-1"), 1);
  assert.equal((await delivery("slow-1"))?.status, "sent");
  assert.deepEqual(events.map((e) => e.state), ["active", "completed"]);
});

test("transient failures retry with exponential backoff, then succeed with one effect", opts, async () => {
  const { queue, events, start } = setup();
  const times: number[] = [];
  await enqueueNotification(queue, payload("trans-1", "transient:2"), FAST);
  const w = start();
  w.on("active", () => times.push(Date.now()));
  assert.equal((await until(jobState(queue, "trans-1"))).state, "completed");
  assert.equal(times.length, 3, "two failures + the successful third attempt");
  assert.ok(times[1]! - times[0]! >= 45, "first retry waits ~base delay (50 ms)");
  assert.ok(times[2]! - times[1]! >= 90, "second retry waits ~2x base delay (100 ms)");
  assert.equal(await sent("trans-1"), 1);
  assert.deepEqual(events.map((e) => e.state), ["active", "retry_scheduled", "active", "retry_scheduled", "active", "completed"]);
  assert.ok(events.filter((e) => e.state === "retry_scheduled").every((e) => e.reason?.startsWith("TransientProviderError")));
});

test("permanent error: one attempt, failed state, no runaway retries", opts, async () => {
  const { queue, events, start } = setup();
  await enqueueNotification(queue, payload("perm-1", "permanent"), FAST);
  start();
  const { state, job } = await until(jobState(queue, "perm-1"));
  assert.equal(state, "failed");
  assert.equal(job.attemptsMade, 1, "a permanent error is not retried");
  assert.match(job.failedReason, /PermanentProviderError/);
  assert.equal(await sent("perm-1"), 0);
  assert.equal(events.filter((e) => e.state === "active").length, 1);
  assert.equal(events.at(-1)?.state, "failed");
});

test("attempts exhausted: ends in failed with the attempt count recorded", opts, async () => {
  const { queue, start } = setup();
  await enqueueNotification(queue, payload("exh-1", "transient:99"), FAST);
  start();
  const { state, job } = await until(jobState(queue, "exh-1"));
  assert.equal(state, "failed");
  assert.equal(job.attemptsMade, FAST.attempts);
  assert.equal(await sent("exh-1"), 0);
  assert.equal((await queueStats(queue)).failed, 1, "failed jobs stay listed (dead-letter view)");
});

test("provider slower than the processing timeout is a transient failure, not a hang", opts, async () => {
  const { queue, events, start } = setup();
  await enqueueNotification(queue, payload("to-1", "slow:400"), { attempts: 1, baseDelayMs: 50 });
  start({ processingTimeoutMs: 100 });
  const { state, job } = await until(jobState(queue, "to-1"));
  assert.equal(state, "failed");
  assert.match(job.failedReason, /handler timeout/);
  assert.equal(events.at(-1)?.state, "failed");
});

test("malformed and unknown jobs fail in a controlled way on the first attempt", opts, async () => {
  const { queue, events, start } = setup();
  await queue.add("ticket_confirmation", { version: 99, junk: true }, { jobId: "bad-payload", attempts: 3 });
  await queue.add("send_sms", payload("x-1"), { jobId: "bad-type", attempts: 3 });
  start();
  for (const id of ["bad-payload", "bad-type"]) {
    const j = await until(async () => {
      const job = await queue.getJob(id);
      return job && (await job.getState()) === "failed" ? job : undefined;
    });
    assert.equal(j.attemptsMade, 1, `${id} must not be retried`);
    assert.match(j.failedReason, /InvalidJobError/);
  }
  assert.equal((await pool.query("SELECT 1 FROM notification_deliveries WHERE notification_id = 'x-1'")).rowCount, 0);
  assert.ok(events.every((e) => !e.reason || !/junk|synthetic-user/.test(e.reason)), "logs never echo payload content");
});

// ---------- duplicates and idempotency ----------
test("enqueueing the same logical notification twice leaves one job and one effect", opts, async () => {
  const { queue, start } = setup();
  await enqueueNotification(queue, payload("dup-1"), FAST);
  await enqueueNotification(queue, payload("dup-1"), FAST);
  assert.equal((await queue.getJobCounts("waiting")).waiting, 1);
  start();
  await until(jobState(queue, "dup-1"));
  assert.equal(await sent("dup-1"), 1);
});

test("replay after completion (a different job, same logical id) adds no second effect", opts, async () => {
  const { queue, events, start } = setup();
  await enqueueNotification(queue, payload("replay-1"), FAST);
  start();
  await until(jobState(queue, "replay-1"));
  await queue.add("ticket_confirmation", payload("replay-1"), { jobId: "manual-replay", attempts: 1 }); // bypasses the producer
  await until(async () => (await (await queue.getJob("manual-replay"))?.getState()) === "completed");
  assert.equal(await sent("replay-1"), 1);
  assert.equal((await delivery("replay-1"))?.attempts, 1, "the handler stopped at the 'already sent' guard");
  assert.equal(events.filter((e) => e.state === "completed").length, 2);
});

test("concurrent handlers for one notification: exactly one recorded effect", async () => {
  const provider = new MockEmailProvider(pool);
  const deps = { db: pool, provider, timeoutMs: 2_000 };
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => handleNotification(payload("conc-1", "slow:30"), i, deps)));
  assert.ok(results.every((r) => r === "sent" || r === "already_sent"));
  assert.equal(await sent("conc-1"), 1);
  assert.equal((await delivery("conc-1"))?.status, "sent");
});

test("two workers, same logical id in three separate jobs: one recorded effect", opts, async () => {
  const { queue, start } = setup();
  start({ concurrency: 2 });
  start({ concurrency: 2 });
  for (const j of ["c-a", "c-b", "c-c"]) await queue.add("ticket_confirmation", payload("conc-2", "slow:50"), { jobId: j, attempts: 1 });
  for (const j of ["c-a", "c-b", "c-c"]) await until(async () => (await (await queue.getJob(j))?.getState()) === "completed");
  assert.equal(await sent("conc-2"), 1);
});

test("ambiguous send (provider accepted, response lost): the retry adds no duplicate", opts, async () => {
  const { queue, start } = setup();
  await enqueueNotification(queue, payload("amb-1", "ambiguous"), FAST);
  start();
  const { state, job } = await until(jobState(queue, "amb-1"));
  assert.equal(state, "completed");
  assert.equal(job.attemptsMade, 2, "first attempt looked like a failure, the retry confirmed it");
  assert.equal(await sent("amb-1"), 1, "the provider's idempotency key absorbed the retry");
});

// ---------- crash recovery (a real child process is killed mid-job) ----------
test("worker dies after the side effect but before completion: job is recovered, effect stays single", opts, async () => {
  const { prefix, queue, start } = setup();
  await enqueueNotification(queue, payload("crash-1", "crash-after-send"), FAST);
  const child = spawn(process.execPath, ["--import", "tsx", "src/jobs/worker-main.ts"], {
    env: { ...process.env, QUEUE_PREFIX: prefix, MOCK_ALLOW_CRASH: "1", WORKER_LOCK_MS: "1000", WORKER_STALLED_MS: "500" },
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 137, "the worker process really died");
  assert.equal(await sent("crash-1"), 1, "the side effect happened before the crash");
  assert.notEqual((await delivery("crash-1"))?.status, "sent", "completion was never recorded");
  assert.equal(await (await queue.getJob("notif-crash-1"))?.getState(), "active", "Redis still thinks a worker holds it (until the lock expires)");

  start({ lockDurationMs: 1_000, stalledIntervalMs: 500 });
  const { state } = await until(jobState(queue, "crash-1"), 15_000);
  assert.equal(state, "completed", "after the lock expired the stalled job was re-run");
  assert.equal(await sent("crash-1"), 1, "no duplicate recorded effect after re-execution");
  assert.equal((await delivery("crash-1"))?.status, "sent");
  assert.equal((await delivery("crash-1"))?.attempts, 2, "it did run twice: at-least-once");
});

// ---------- truthful failure reporting and instrumentation ----------
test("enqueue against an unreachable Redis throws; it never reports 'accepted'", async () => {
  const dead = createJobQueue({ url: "redis://127.0.0.1:1" });
  try {
    await assert.rejects(enqueueNotification(dead, payload("down-1"), FAST, 1_000), EnqueueError);
  } finally {
    await dead.close().catch(() => {});
  }
});

test("invalid payload is rejected before touching the queue", opts, async () => {
  const { queue } = setup();
  await assert.rejects(enqueueNotification(queue, { ...payload("v-1"), version: 7 as 1 }, FAST), /version/);
  assert.equal((await queueStats(queue)).waiting, 0);
});

test("queueStats reports backlog and the age of the oldest waiting job", opts, async () => {
  const { queue } = setup();
  await enqueueNotification(queue, payload("stat-1"), FAST);
  await new Promise((r) => setTimeout(r, 60));
  const s = await queueStats(queue);
  assert.equal(s.waiting, 1);
  assert.ok(s.oldestWaitingAgeMs !== null && s.oldestWaitingAgeMs >= 50);
});
