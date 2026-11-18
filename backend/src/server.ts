import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export interface EventItem {
  id: number;
  name: string;
  seats: number;
}

// In-memory store with synthetic data. State resets on restart.
export const events: EventItem[] = [
  { id: 1, name: "Synthetic Jazz Night", seats: 120 },
  { id: 2, name: "Synthetic Tech Meetup", seats: 80 },
];

function handle(req: IncomingMessage, res: ServerResponse): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/events") {
    if (req.method === "GET") {
      sendJson(res, 200, events);
    } else {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }
    return;
  }

  // Strict canonical id: positive decimal, no leading zeros, no trailing slash.
  const eventMatch = /^\/events\/([1-9][0-9]*)$/.exec(pathname);
  if (eventMatch) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
      return;
    }
    const id = Number(eventMatch[1]);
    const event = events.find((e) => e.id === id);
    if (event) {
      sendJson(res, 200, event);
    } else {
      sendJson(res, 404, { error: "Not Found" });
    }
    return;
  }

  if (pathname === "/health") {
    if (req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
    } else {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

export const server = createServer(handle);

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "127.0.0.1", () => {
    console.log(`EventHub listening on http://127.0.0.1:${port}`);
  });
}
