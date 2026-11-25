import { loadConfig, parseWorkerConfig } from "../config.ts";
import { pool } from "../db/pool.ts";
import { MockEmailProvider } from "./notification.ts";
import { QUEUE_NAME, startWorker } from "./queue.ts";

// Separate worker process (npm run jobs:worker). Runs independently of the HTTP server.
// Lecture 17: every setting is validated before the worker connects or consumes a job.
const cfg = loadConfig(parseWorkerConfig);
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

// Clean stop: finish the job in hand, then exit (SIGKILL is the crash experiment).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void worker.close().then(() => pool.end()).then(() => process.exit(0));
  });
}
console.log(JSON.stringify({ worker: "started", queue: cfg.queueName ?? QUEUE_NAME }));
