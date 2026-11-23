import { randomUUID } from "node:crypto";
import { EnqueueError, createJobQueue, enqueueNotification, queueStats, QUEUE_NAME } from "./queue.ts";

// npm run jobs:enqueue -- [notificationId] [scenario]
// npm run jobs:enqueue -- --stats
const url = process.env.QUEUE_REDIS_URL;
if (!url) throw new Error("QUEUE_REDIS_URL is required (see backend/.env.example)");
const queue = createJobQueue({ url, name: process.env.QUEUE_NAME ?? QUEUE_NAME, ...(process.env.QUEUE_PREFIX ? { prefix: process.env.QUEUE_PREFIX } : {}) });
try {
  if (process.argv[2] === "--stats") {
    console.log(JSON.stringify(await queueStats(queue)));
  } else {
    const notificationId = process.argv[2] ?? `lab-${randomUUID().slice(0, 8)}`;
    const scenario = process.argv[3];
    const started = Date.now();
    const r = await enqueueNotification(queue, {
      version: 1,
      notificationId,
      recipientRef: "synthetic-user-1",
      correlationId: `cli-${randomUUID().slice(0, 8)}`,
      ...(scenario ? { scenario } : {}),
    });
    // "accepted" = stored in the queue. NOT "email sent".
    console.log(JSON.stringify({ ...r, enqueueMs: Date.now() - started, emailSent: "unknown (worker decides later)" }));
  }
} catch (err) {
  console.error(err instanceof EnqueueError ? err.message : "unexpected error");
  process.exitCode = 1;
} finally {
  await queue.close();
}
