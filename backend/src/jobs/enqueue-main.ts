import { randomUUID } from "node:crypto";
import { loadConfig, parseQueueConfig } from "../config.ts";
import { EnqueueError, createJobQueue, enqueueNotification, queueStats, QUEUE_NAME } from "./queue.ts";

// npm run jobs:enqueue -- [notificationId] [scenario]
// npm run jobs:enqueue -- --stats
const cfg = loadConfig(parseQueueConfig);
const queue = createJobQueue({ url: cfg.queueRedisUrl, name: cfg.queueName ?? QUEUE_NAME, ...(cfg.queuePrefix ? { prefix: cfg.queuePrefix } : {}) });
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
