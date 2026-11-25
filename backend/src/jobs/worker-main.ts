import { loadConfig, parseWorkerConfig } from "../config.ts";
import { pool } from "../db/pool.ts";
import { logSettings, logSink } from "../observability/logger.ts";
import { createShutdown, installSignalHandlers, lifecycleLog } from "../lifecycle/shutdown.ts";
import { MockEmailProvider } from "./notification.ts";
import { QUEUE_NAME, startWorker } from "./queue.ts";

// Separate worker process (npm run jobs:worker). Runs independently of the HTTP server.
// Lecture 17: every setting is validated before the worker connects or consumes a job.
const cfg = loadConfig(parseWorkerConfig);
// Lecture 18: job telemetry goes through the structured logger (stdout, JSON lines).
logSettings.service = "worker";
logSettings.level = cfg.logLevel;
logSink.write = (line) => console.log(line);
const worker = startWorker({
  url: cfg.queueRedisUrl,
  db: pool,
  ...(cfg.queueName ? { name: cfg.queueName } : {}),
  ...(cfg.queuePrefix ? { prefix: cfg.queuePrefix } : {}),
  // Only this process may run the crash scenario (it kills itself on purpose).
  provider: new MockEmailProvider(pool, cfg.mockAllowCrash),
  ...(cfg.lockDurationMs !== undefined ? { lockDurationMs: cfg.lockDurationMs } : {}),
  ...(cfg.stalledIntervalMs !== undefined ? { stalledIntervalMs: cfg.stalledIntervalMs } : {}),
  ...(cfg.concurrency !== undefined ? { concurrency: cfg.concurrency } : {}),
});

// Lecture 19: graceful stop, a separate process with its own sequence. Order = dependency order:
//   1. worker.close(): stops fetching new jobs and WAITS for the active job(s) (BullMQ default);
//      the job handlers use PostgreSQL, so the pool must outlive this step;
//   2. pool.end(): only now that no handler can need a connection.
// Deadline: if a job cannot finish in time the process exits 1 and the job is left active in Redis;
// its lock expires and stalled-job recovery re-runs it (idempotency keeps the effect single), exactly
// as after SIGKILL. SIGKILL itself cannot be handled: that path is the crash experiment of lecture 14.
const shutdown = createShutdown({
  deadlineMs: cfg.shutdownTimeoutMs,
  log: lifecycleLog,
  exit: (code) => process.exit(code),
  steps: [
    { name: "worker-close", run: () => worker.close() },
    { name: "postgres-pool-end", run: () => pool.end() },
  ],
});
installSignalHandlers(shutdown);
console.log(JSON.stringify({ worker: "started", queue: cfg.queueName ?? QUEUE_NAME }));
