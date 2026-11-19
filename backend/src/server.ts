import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseQuery, Router, scalar } from "./router.ts";
import type { Query, Registrar } from "./router.ts";
import { readJsonBody } from "./json.ts";
import { auth, eventOwners, publicUser, ticketsByUser } from "./auth.ts";
import type { User } from "./auth.ts";

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

const MAX_NAME_LENGTH = 100;
const MAX_SEATS = 100_000;

// Exactly one browser origin may read responses (CORS). Anything else gets no
// CORS headers, so the browser, not the server, blocks it.
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

// Allow lists are no longer hard-coded: the router derives them from the routes
// registered for each path, so they cannot drift from what is really served.

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

// Added to every response. The response depends on the Origin request header,
// so caches must be told (Vary). Only the one allowed origin gets ACAO, and
// only then may browser code read Location and ETag.
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Vary", "Origin");
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Expose-Headers", "Location, ETag");
  }
}

// OPTIONS: 204 with Allow. A CORS preflight (Origin + Access-Control-Request-
// Method) from the allowed origin additionally gets the Access-Control-Allow-*
// headers, but only for a method this resource really supports. A disallowed
// origin still gets 204 + Allow and no ACAO, which the browser treats as denied.
function handleOptions(req: IncomingMessage, res: ServerResponse, allow: string): void {
  const headers: Record<string, string> = { Allow: allow };
  const requested = req.headers["access-control-request-method"];
  if (req.headers.origin !== undefined && requested !== undefined) {
    res.setHeader(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    const supported = allow.split(",").map((m) => m.trim());
    if (
      req.headers.origin === ALLOWED_ORIGIN &&
      typeof requested === "string" &&
      supported.includes(requested)
    ) {
      headers["Access-Control-Allow-Methods"] = allow;
      // If-None-Match is not CORS-safelisted, so a conditional GET from the
      // browser is preflighted and must be approved explicitly.
      headers["Access-Control-Allow-Headers"] = "Content-Type, If-None-Match, Authorization";
      headers["Access-Control-Max-Age"] = "600";
    }
  }
  res.writeHead(204, headers);
  res.end();
}

// Strong validator: changes whenever the representation's bytes change.
function etagOf(payload: string): string {
  return `"${createHash("sha256").update(payload).digest("hex").slice(0, 32)}"`;
}

// If-None-Match: "*" or a comma-separated list; weak comparison, so W/ is ignored.
function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
}

function sendEvent(req: IncomingMessage, res: ServerResponse, event: EventItem): void {
  const etag = etagOf(JSON.stringify(event));
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  sendJson(res, 200, event, headers);
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

// Reads and parses a JSON request body (see json.ts). On any problem the error
// response (415/413/400) has already been sent and null is returned. Wrapping the
// value lets a legitimate JSON `null` body be told apart from failure.
async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ value: unknown } | null> {
  const result = await readJsonBody(req);
  if (result.ok) return { value: result.value };
  // 400 leaves the connection usable; 413/415 may leave an unread body behind.
  sendJson(res, result.status, { error: result.error }, result.status === 400 ? {} : { Connection: "close" });
  return null;
}

// ---------- authentication and authorization (lecture 08) ----------

const NO_STORE = { "Cache-Control": "no-store" };

function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

// 401 when no valid session; the unread body is not drained (see ignoredBodyHeaders).
function requireUser(req: IncomingMessage, res: ServerResponse): { user: User; token: string } | null {
  const token = bearerToken(req);
  const user = token ? auth.authenticate(token) : null;
  if (!token || !user) {
    const challenge = req.headers.authorization === undefined ? "Bearer" : 'Bearer error="invalid_token"';
    sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": challenge, ...ignoredBodyHeaders(req) });
    return null;
  }
  return { user, token };
}

function forbidden(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 403, { error: "Forbidden" }, ignoredBodyHeaders(req));
}

const canEdit = (user: User, eventId: number) =>
  user.role === "admin" || (user.role === "organizer" && eventOwners.get(eventId) === user.id);

const USERNAME = /^[A-Za-z0-9_]{3,32}$/;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128; // bounds scrypt work per request

async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  const v = body.value;
  const { username, password } =
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const details: string[] = [];
  if (typeof username !== "string" || !USERNAME.test(username)) details.push("username must be 3-32 letters, digits or _");
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
    details.push(`password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  if (details.length > 0) return sendJson(res, 422, { error: "Unprocessable Content", details }, NO_STORE);

  // Any "role" in the body is ignored: public registration always creates an attendee.
  const result = await auth.createUser(username as string, password as string, "attendee");
  if (!result.ok) return sendJson(res, 409, { error: "Username already taken" }, NO_STORE);
  sendJson(res, 201, publicUser(result.user), NO_STORE);
}

async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  const v = body.value;
  const { username, password } =
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  if (typeof username !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD || username.length > 64) {
    return sendJson(res, 401, { error: "Invalid credentials" }, NO_STORE);
  }
  const key = `${req.socket.remoteAddress ?? "?"}|${username.toLowerCase()}`;
  const wait = auth.limiter.retryAfter(key);
  if (wait > 0) {
    return sendJson(res, 429, { error: "Too Many Requests" }, { ...NO_STORE, "Retry-After": String(wait) });
  }
  const user = await auth.verifyCredentials(username, password);
  if (!user) {
    auth.limiter.fail(key);
    // Same body for unknown user and wrong password.
    return sendJson(res, 401, { error: "Invalid credentials" }, NO_STORE);
  }
  auth.limiter.clear(key);
  const session = auth.createSession(user.id);
  sendJson(res, 200, {
    token: session.token,
    tokenType: "Bearer",
    expiresAt: new Date(session.expiresAt).toISOString(),
    user: publicUser(user),
  }, NO_STORE);
}

function logout(req: IncomingMessage, res: ServerResponse): void {
  const a = requireUser(req, res);
  if (!a) return;
  auth.destroySession(a.token); // server-side revocation: the old token is dead immediately
  res.writeHead(204, NO_STORE);
  res.end();
}

function me(req: IncomingMessage, res: ServerResponse): void {
  const a = requireUser(req, res);
  if (a) sendJson(res, 200, publicUser(a.user), NO_STORE);
}

// Own tickets only: the caller comes from the session, never from the URL or query.
function myTickets(req: IncomingMessage, res: ServerResponse): void {
  const a = requireUser(req, res);
  if (a) sendJson(res, 200, { data: ticketsByUser.get(a.user.id) ?? [] }, NO_STORE);
}

// Object-level check by id: someone else's ticket is indistinguishable from a missing one (404).
function ticketById(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const a = requireUser(req, res);
  if (!a) return;
  const ticket = (ticketsByUser.get(a.user.id) ?? []).find((t) => t.ticketId === ctx.params["id"]);
  if (!ticket) return sendJson(res, 404, { error: "Not Found" }, NO_STORE);
  sendJson(res, 200, ticket, NO_STORE);
}

async function createEvent(
  req: IncomingMessage,
  res: ServerResponse,
  prefix: string,
): Promise<void> {
  const a = requireUser(req, res);
  if (!a) return;
  if (a.user.role !== "organizer" && a.user.role !== "admin") return forbidden(req, res);
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
  eventOwners.set(event.id, a.user.id);
  sendJson(res, 201, event, { Location: `${prefix}/events/${event.id}` });
}

// PUT replaces the whole event (name and seats required). The id comes from the
// URL; an `id` in the body is ignored. Existence is checked before the body.
async function replaceEvent(
  id: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const a = requireUser(req, res);
  if (!a) return;
  if (!events.some((e) => e.id === id)) {
    sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
    return;
  }
  if (!canEdit(a.user, id)) return forbidden(req, res);

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
  const a = requireUser(req, res);
  if (!a) return;
  const index = events.findIndex((e) => e.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
    return;
  }
  if (a.user.role !== "admin") return forbidden(req, res);
  events.splice(index, 1);
  eventOwners.delete(id);
  res.writeHead(204, ignoredBodyHeaders(req));
  res.end();
}

// ---------- v1-only handlers (stubs and mock data, lecture 06) ----------

const PAGE_SIZE = 10;
const SORT_FIELDS = ["id", "name", "seats"] as const;
type SortField = (typeof SORT_FIELDS)[number];

function badQuery(res: ServerResponse, details: string[]): void {
  sendJson(res, 400, { error: "Bad Request", details });
}

// Query policy: city, sort and page are scalar (a repeated key is a 400); sort
// is "id|name|seats" with an optional "-" for descending; page is a positive
// integer. Unknown keys are ignored. Events have no city, so city is accepted
// and echoed back but does not filter (deliberate simplification).
function listEventsV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const city = scalar(ctx.query, "city");
  const sort = scalar(ctx.query, "sort");
  const page = scalar(ctx.query, "page");
  const details: string[] = [];
  if (!city.ok) details.push("city must not be repeated");
  if (!sort.ok) details.push("sort must not be repeated");
  if (!page.ok) details.push("page must not be repeated");

  const sortText = sort.ok ? (sort.value ?? "id") : "id";
  const sortMatch = /^(-?)(id|name|seats)$/.exec(sortText);
  if (sort.ok && !sortMatch) details.push("sort must be id, name or seats, optionally prefixed with -");

  const pageText = page.ok ? (page.value ?? "1") : "1";
  if (page.ok && !/^[1-9][0-9]{0,8}$/.test(pageText)) details.push("page must be a positive integer");

  if (details.length > 0 || !sortMatch) return badQuery(res, details);

  const field = sortMatch[2] as SortField;
  const direction = sortMatch[1] === "-" ? -1 : 1;
  const sorted = [...events].sort((a, b) => {
    const x = a[field];
    const y = b[field];
    return (x < y ? -1 : x > y ? 1 : 0) * direction;
  });
  const pageNumber = Number(pageText);
  const data = sorted.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  sendJson(res, 200, {
    data,
    meta: { page: pageNumber, pageSize: PAGE_SIZE, total: events.length, sort: sortText, city: city.ok ? (city.value ?? null) : null },
  });
}

// Mock search: case-insensitive substring match on the name; no q returns all.
function searchEventsV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const q = scalar(ctx.query, "q");
  if (!q.ok) return badQuery(res, ["q must not be repeated"]);
  const needle = (q.value ?? "").toLowerCase();
  sendJson(res, 200, {
    data: events.filter((e) => e.name.toLowerCase().includes(needle)),
    meta: { q: q.value ?? null },
  });
}

// Synthetic tickets derived from the event; nothing is reserved or stored.
function listTickets(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const id = Number(ctx.params["id"]);
  const event = events.find((e) => e.id === id);
  if (!event) return sendJson(res, 404, { error: "Not Found" });
  const tickets = Array.from({ length: Math.min(event.seats, 3) }, (_, i) => ({
    ticketId: `T-${id}-${i + 1}`,
    eventId: id,
    type: "general",
  }));
  sendJson(res, 200, { data: tickets });
}

// Booking is out of scope for this lecture: the route exists, nothing happens.
function bookingStub(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 501, { error: "Not Implemented", detail: "booking is a stub" }, ignoredBodyHeaders(req));
}

// PATCH changes only the fields sent (name and/or seats); the merged result is
// validated like a full event, and nothing is stored if it is invalid.
async function patchEvent(id: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const a = requireUser(req, res);
  if (!a) return;
  if (!events.some((e) => e.id === id)) {
    return sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
  }
  if (!canEdit(a.user, id)) return forbidden(req, res);

  const body = await readJson(req, res);
  if (!body) return;
  const v = body.value;
  if (typeof v !== "object" || v === null || Array.isArray(v) || !("name" in v || "seats" in v)) {
    return sendJson(res, 422, {
      error: "Unprocessable Content",
      details: ["body must be a JSON object with name and/or seats"],
    });
  }
  const { name, seats } = v as Record<string, unknown>;
  // Merge into the event as it is NOW, not as it was before the body arrived:
  // another request may have changed it while we waited (no lost update).
  const current = events.find((e) => e.id === id);
  if (!current) return sendJson(res, 404, { error: "Not Found" });
  const result = validateNewEvent({
    name: name === undefined ? current.name : name,
    seats: seats === undefined ? current.seats : seats,
  });
  if (!result.ok) return sendJson(res, 422, { error: "Unprocessable Content", details: result.details });

  const index = events.findIndex((e) => e.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Not Found" });
  const event: EventItem = { id, ...result.value };
  events[index] = event;
  sendJson(res, 200, event);
}

// ---------- route table ----------

export interface RouteContext {
  params: Record<string, string>;
  query: Query;
  allow: string;
  prefix: string; // "" for the legacy routes, "/api/v1" for v1
}
type AppHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void | Promise<void>;

// Canonical id: positive decimal, no leading zeros. Declared as a constraint so
// a non-matching segment never reaches a handler.
const ID = { id: /^[1-9][0-9]*$/ };

const optionsHandler: AppHandler = (req, res, ctx) => handleOptions(req, res, ctx.allow);
const idOf = (ctx: RouteContext): number => Number(ctx.params["id"]);

// The event routes of lecture 05. `v1` adds the lecture 06 extras; the legacy
// unversioned table stays exactly as lecture 05 clients know it.
function registerEventRoutes(r: Registrar<AppHandler>, v1: boolean): void {
  if (v1) {
    r.add("GET", "/events", listEventsV1);
    // Registered before "/events/:id" AND the id is constrained: two independent
    // protections against "search" being read as an id.
    r.add("GET", "/events/search", searchEventsV1);
    r.add("OPTIONS", "/events/search", optionsHandler);
  } else {
    r.add("GET", "/events", (_req, res) => sendJson(res, 200, events));
  }
  r.add("POST", "/events", (req, res, ctx) => createEvent(req, res, ctx.prefix));
  r.add("OPTIONS", "/events", optionsHandler);

  r.add("GET", "/events/:id", (req, res, ctx) => {
    const event = events.find((e) => e.id === idOf(ctx));
    if (event) sendEvent(req, res, event);
    else sendJson(res, 404, { error: "Not Found" });
  }, ID);
  r.add("PUT", "/events/:id", (req, res, ctx) => replaceEvent(idOf(ctx), req, res), ID);
  if (v1) r.add("PATCH", "/events/:id", (req, res, ctx) => patchEvent(idOf(ctx), req, res), ID);
  r.add("DELETE", "/events/:id", (req, res, ctx) => deleteEvent(idOf(ctx), req, res), ID);
  r.add("OPTIONS", "/events/:id", optionsHandler, ID);

  if (v1) {
    r.add("GET", "/events/:id/tickets", listTickets, ID);
    r.add("OPTIONS", "/events/:id/tickets", optionsHandler, ID);
    r.add("POST", "/auth/register", register);
    r.add("OPTIONS", "/auth/register", optionsHandler);
    r.add("POST", "/auth/login", login);
    r.add("OPTIONS", "/auth/login", optionsHandler);
    r.add("POST", "/auth/logout", logout);
    r.add("OPTIONS", "/auth/logout", optionsHandler);
    r.add("GET", "/auth/me", me);
    r.add("OPTIONS", "/auth/me", optionsHandler);
    r.add("GET", "/me/tickets", myTickets);
    r.add("OPTIONS", "/me/tickets", optionsHandler);
    r.add("GET", "/tickets/:id", ticketById);
    r.add("OPTIONS", "/tickets/:id", optionsHandler);
    r.add("POST", "/bookings", bookingStub);
    r.add("OPTIONS", "/bookings", optionsHandler);
  }
}

export const router = new Router<AppHandler>();
router.add("GET", "/health", (_req, res) => sendJson(res, 200, { status: "ok" }));
registerEventRoutes(router, false); // legacy, unversioned (kept for lecture 05 clients)
registerEventRoutes(router.group("/api/v1"), true); // "/api/v2" is not implemented: 404

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Origin-form targets start with "/". Parse them against a fixed host so a
  // leading "//" stays part of the path (404) instead of being read as a host,
  // which would make "//x/events" an extra URL for /events. Other forms, such
  // as absolute-form ("GET http://host/events"), still go through the parser.
  const target = req.url ?? "/";
  const url = new URL(
    target.startsWith("/") ? `http://localhost${target}` : target,
    "http://localhost",
  );
  applyCors(req, res);

  const result = router.match(req.method ?? "GET", url.pathname);
  switch (result.kind) {
    case "match":
      await result.handler(req, res, {
        params: result.params,
        query: parseQuery(url.searchParams),
        allow: result.allow,
        prefix: result.prefix,
      });
      return;
    case "method-not-allowed":
      methodNotAllowed(res, result.allow);
      return;
    case "bad-request":
      sendJson(res, 400, { error: "Bad Request" });
      return;
    case "not-found":
      sendJson(res, 404, { error: "Not Found" });
      return;
  }
}

export const server = createServer((req, res) => {
  if (process.env.LOG_REQUESTS === "1") {
    res.on("finish", () => {
      console.log(
        `${req.method} ${req.url} origin=${req.headers.origin ?? "-"} -> ${res.statusCode}`,
      );
    });
  }
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
  if (process.env.SEED_DEMO_USERS === "1") {
    // Trusted startup path for privileged synthetic users; random passwords are
    // printed once and never stored in the repository.
    for (const role of ["organizer", "admin"] as const) {
      const password = randomBytes(12).toString("base64url");
      await auth.createUser(`demo_${role}`, password, role);
      console.log(`demo user demo_${role} password ${password}`);
    }
  }
  server.listen(port, "127.0.0.1", () => {
    console.log(`EventHub listening on http://127.0.0.1:${port}`);
  });
}
