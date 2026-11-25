import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./app.ts";

// Lecture 16. Two different questions:
//   liveness  - is this process running and answering? (restart it if not)
//   readiness - can it do its ESSENTIAL work right now? (stop routing traffic if not)
// Essential = PostgreSQL, the source of truth. The Redis cache and the queue Redis are
// optional/isolated, so their failure must not make the API "not ready".
// The existing GET /health stays exactly as it was ({"status":"ok"}).
export const READINESS_TIMEOUT_MS = 1_000;

export interface Pinger {
  query(sql: string): Promise<unknown>;
}

// Bounded: a hung database turns into "not ready" after timeoutMs, never into a hung probe.
// Note the timer only stops WAITING; it cannot cancel work already in the driver.
export async function dbReady(db: Pinger, timeoutMs = READINESS_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([db.query("SELECT 1").then(() => true as const, () => false as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const liveHandler = (_req: IncomingMessage, res: ServerResponse): void =>
  sendJson(res, 200, { status: "alive" }, { "Cache-Control": "no-store" });

// Lecture 19: while the process is shutting down it is alive but must receive no new traffic,
// so readiness says "draining" (503) WITHOUT touching the database.
export function createReadyHandler(db: Pinger, timeoutMs = READINESS_TIMEOUT_MS, isDraining: () => boolean = () => false) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (isDraining()) {
      sendJson(res, 503, { status: "draining" }, { "Cache-Control": "no-store", Connection: "close" });
      return;
    }
    const ok = await dbReady(db, timeoutMs);
    // Which dependency failed is reported by name only: no host, no error text.
    sendJson(res, ok ? 200 : 503, { status: ok ? "ready" : "not_ready", checks: { database: ok ? "up" : "down" } }, { "Cache-Control": "no-store" });
  };
}
