import { pool } from "../db/pool.ts";
import { MockEmailProvider } from "./notification.ts";
import { QUEUE_NAME, startWorker } from "./queue.ts";

// Separate worker process (npm run jobs:worker). Runs independently of the HTTP server.
const url = process.env.QUEUE_REDIS_URL;
if (!url) throw new Error("QUEUE_REDIS_URL is required (see backend/.env.example)");

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const worker = startWorker({
  url,
  db: pool,
  name: process.env.QUEUE_NAME ?? QUEUE_NAME,
  ...(process.env.QUEUE_PREFIX ? { prefix: process.env.QUEUE_PREFIX } : {}),
  // Only this process may run the crash scenario (it kills itself on purpose).
  provider: new MockEmailProvider(pool, process.env.MOCK_ALLOW_CRASH === "1"),
  ...(num(process.env.WORKER_LOCK_MS) !== undefined ? { lockDurationMs: num(process.env.WORKER_LOCK_MS)! } : {}),
  ...(num(process.env.WORKER_STALLED_MS) !== undefined ? { stalledIntervalMs: num(process.env.WORKER_STALLED_MS)! } : {}),
  ...(num(process.env.WORKER_CONCURRENCY) !== undefined ? { concurrency: num(process.env.WORKER_CONCURRENCY)! } : {}),
});

// Clean stop: finish the job in hand, then exit (SIGKILL is the crash experiment).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void worker.close().then(() => pool.end()).then(() => process.exit(0));
  });
}
console.log(JSON.stringify({ worker: "started", queue: process.env.QUEUE_NAME ?? QUEUE_NAME }));
