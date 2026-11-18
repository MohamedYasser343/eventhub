import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

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

// Monotonic counter: an id is never reused, even after its event is deleted.
let nextId = Math.max(0, ...events.map((e) => e.id)) + 1;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_SEATS = 100_000;

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

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: allow });
}

// Resolves with the body text, or null if it exceeds `limit` bytes.
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function isJsonContentType(header: string | undefined): boolean {
  const mediaType = (header ?? "").split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

type Validation =
  | { ok: true; value: Omit<EventItem, "id"> }
  | { ok: false; details: string[] };

function validateNewEvent(input: unknown): Validation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, details: ["body must be a JSON object"] };
  }
  const { name, seats } = input as Record<string, unknown>;
  const details: string[] = [];

  const trimmed = typeof name === "string" ? name.trim() : "";
  if (typeof name !== "string") {
    details.push("name must be a string");
  } else if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    details.push(`name must be 1-${MAX_NAME_LENGTH} characters after trimming`);
  }

  if (
    typeof seats !== "number" ||
    !Number.isInteger(seats) ||
    seats < 0 ||
    seats > MAX_SEATS
  ) {
    details.push(`seats must be an integer between 0 and ${MAX_SEATS}`);
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value: { name: trimmed, seats: seats as number } };
}

// The request body is ignored (DELETE, or PUT on a missing event). If one was
// sent, close the connection so an unread, possibly huge body is not drained.
function ignoredBodyHeaders(req: IncomingMessage): Record<string, string> {
  const hasBody =
    Number(req.headers["content-length"]) > 0 ||
    req.headers["transfer-encoding"] !== undefined;
  return hasBody ? { Connection: "close" } : {};
}

// Reads and parses a JSON request body. On any problem the error response
// (415/413/400) has already been sent and null is returned. Wrapping the value
// lets a legitimate JSON `null` body be told apart from failure.
async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ value: unknown } | null> {
  const closeConn = { Connection: "close" };

  if (!isJsonContentType(req.headers["content-type"])) {
    sendJson(res, 415, { error: "Content-Type must be application/json" }, closeConn);
    return null;
  }

  const declared = Number(req.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: "Payload Too Large" }, closeConn);
    return null;
  }

  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) {
    sendJson(res, 413, { error: "Payload Too Large" }, closeConn);
    return null;
  }

  try {
    return { value: JSON.parse(text) };
  } catch {
    sendJson(res, 400, { error: "Malformed JSON" });
    return null;
  }
}

async function createEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;

  // Validate fully before touching the store: invalid input never mutates.
  const result = validateNewEvent(body.value);
  if (!result.ok) {
    sendJson(res, 422, { error: "Unprocessable Content", details: result.details });
    return;
  }

  const event: EventItem = { id: nextId++, ...result.value };
  events.push(event);
  sendJson(res, 201, event, { Location: `/events/${event.id}` });
}

// PUT replaces the whole event (name and seats required). The id comes from the
// URL; an `id` in the body is ignored. Existence is checked before the body.
async function replaceEvent(
  id: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!events.some((e) => e.id === id)) {
    sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
    return;
  }

  const body = await readJson(req, res);
  if (!body) return;

  const result = validateNewEvent(body.value);
  if (!result.ok) {
    sendJson(res, 422, { error: "Unprocessable Content", details: result.details });
    return;
  }

  // Look the event up again: the store may have changed while the body was read.
  const index = events.findIndex((e) => e.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }
  const event: EventItem = { id, ...result.value };
  events[index] = event;
  sendJson(res, 200, event);
}

function deleteEvent(id: number, req: IncomingMessage, res: ServerResponse): void {
  const index = events.findIndex((e) => e.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
    return;
  }
  events.splice(index, 1);
  res.writeHead(204, ignoredBodyHeaders(req));
  res.end();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/events") {
    if (req.method === "GET") {
      sendJson(res, 200, events);
    } else if (req.method === "POST") {
      await createEvent(req, res);
    } else {
      methodNotAllowed(res, "GET, POST");
    }
    return;
  }

  // Strict canonical id: positive decimal, no leading zeros, no trailing slash.
  const eventMatch = /^\/events\/([1-9][0-9]*)$/.exec(pathname);
  if (eventMatch) {
    const id = Number(eventMatch[1]);
    if (req.method === "GET") {
      const event = events.find((e) => e.id === id);
      if (event) {
        sendJson(res, 200, event);
      } else {
        sendJson(res, 404, { error: "Not Found" });
      }
    } else if (req.method === "PUT") {
      await replaceEvent(id, req, res);
    } else if (req.method === "DELETE") {
      deleteEvent(id, req, res);
    } else {
      methodNotAllowed(res, "GET, PUT, DELETE");
    }
    return;
  }

  if (pathname === "/health") {
    if (req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
    } else {
      methodNotAllowed(res, "GET");
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

export const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal Server Error" });
    } else {
      res.end();
    }
  });
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "127.0.0.1", () => {
    console.log(`EventHub listening on http://127.0.0.1:${port}`);
  });
}
