import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseQuery, Router, scalar } from "./router.ts";
import { detailsOf, PAGE_SIZE, parseId, parseListQuery, validateEventInput, validateEventPatch } from "./validation.ts";
import type { FieldError } from "./validation.ts";
import type { Query, Registrar } from "./router.ts";
import { readJsonBody } from "./json.ts";
import { auth, eventOwners, publicUser, ticketsByUser } from "./auth.ts";
import { createRequestContext } from "./http/context.ts";
import type { RequestContext } from "./http/context.ts";
import { compose } from "./http/middleware.ts";
import type { Middleware } from "./http/middleware.ts";
import { InMemoryEventRepository } from "./modules/events/repository.ts";
import type { EventItem } from "./modules/events/repository.ts";
import { EventService } from "./modules/events/service.ts";
import type { EventError, Outcome } from "./modules/events/service.ts";

export type { EventItem };

// In-memory store with synthetic data. State resets on restart.
export const events: EventItem[] = [
  { id: 1, name: "Synthetic Jazz Night", seats: 120 },
  { id: 2, name: "Synthetic Tech Meetup", seats: 80 },
];

// Composition root (lecture 10): dependencies are wired by hand, here, once.
// Handlers talk to the service; only the repository touches the store.
const eventService = new EventService(new InMemoryEventRepository(events, eventOwners));

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

// 422: valid JSON that violates the contract. `details` is the legacy message
// list (kept for compatibility); `errors` adds stable field paths and codes.
function unprocessable(res: ServerResponse, errors: FieldError[]): void {
  sendJson(res, 422, { error: "Unprocessable Content", details: detailsOf(errors), errors });
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

// Route middleware: 401 unless the request carries a valid session. On success the
// VERIFIED identity is stored on this request's context; nothing downstream reads
// identity from the client. A rejection never calls next(), so the handler (and
// any service or storage behind it) is not invoked. The unread body is not drained
// (see ignoredBodyHeaders).
const requireAuth: Middleware<RouteContext> = async (req, res, ctx, next) => {
  const token = bearerToken(req);
  const user = token ? auth.authenticate(token) : null;
  if (!token || !user) {
    const challenge = req.headers.authorization === undefined ? "Bearer" : 'Bearer error="invalid_token"';
    sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": challenge, ...ignoredBodyHeaders(req) });
    return;
  }
  ctx.user = { id: user.id, username: user.username, role: user.role };
  ctx.token = token;
  await next();
};

type Authed = RouteContext & { user: NonNullable<RequestContext["user"]>; token: string };
type AuthedHandler = (req: IncomingMessage, res: ServerResponse, ctx: Authed) => void | Promise<void>;
// Marks a route as protected: requireAuth runs first, then the handler.
const protect = (h: AuthedHandler): AppHandler =>
  compose<RouteContext>([requireAuth], (req, res, ctx) => h(req, res, ctx as Authed));

function forbidden(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 403, { error: "Forbidden" }, ignoredBodyHeaders(req));
}

// Controller side of EventError: the only place domain failures become statuses.
function sendEventError(req: IncomingMessage, res: ServerResponse, error: EventError): void {
  switch (error.kind) {
    case "not-found":
      return sendJson(res, 404, { error: "Not Found" }, ignoredBodyHeaders(req));
    case "forbidden":
      return forbidden(req, res);
    case "invalid":
      return unprocessable(res, error.errors);
  }
}

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

function logout(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
  auth.destroySession(ctx.token); // server-side revocation: the old token is dead immediately
  res.writeHead(204, NO_STORE);
  res.end();
}

function me(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
  sendJson(res, 200, publicUser(ctx.user), NO_STORE);
}

// Own tickets only: the caller comes from the session, never from the URL or query.
function myTickets(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
  sendJson(res, 200, { data: ticketsByUser.get(ctx.user.id) ?? [] }, NO_STORE);
}

// Object-level check by id: someone else's ticket is indistinguishable from a missing one (404).
function ticketById(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
  const ticket = (ticketsByUser.get(ctx.user.id) ?? []).find((t) => t.ticketId === ctx.params["id"]);
  if (!ticket) return sendJson(res, 404, { error: "Not Found" }, NO_STORE);
  sendJson(res, 200, ticket, NO_STORE);
}

async function createEvent(req: IncomingMessage, res: ServerResponse, ctx: Authed): Promise<void> {
  // Role is checked before the body is read, as before; the service re-checks.
  if (!eventService.canCreate(ctx.user)) return forbidden(req, res);
  const body = await readJson(req, res);
  if (!body) return;
  const r = eventService.create(ctx.user, body.value);
  if (!r.ok) return sendEventError(req, res, r.error);
  sendJson(res, 201, r.value, { Location: `${ctx.prefix}/events/${r.value.id}` });
}

// Shared by PUT and PATCH. Existence (404) and permission (403) are decided before
// the body is read; the service re-checks against the store as it is after the
// body arrives, so a concurrent delete or change is still handled.
async function modifyEvent(
  op: "replace" | "patch",
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Authed,
): Promise<void> {
  const id = idOf(ctx);
  const pre = eventService.authorizeEdit(ctx.user, id);
  if (!pre.ok) return sendEventError(req, res, pre.error);
  const body = await readJson(req, res);
  if (!body) return;
  const r: Outcome<EventItem> = eventService[op](ctx.user, id, body.value);
  if (!r.ok) return sendEventError(req, res, r.error);
  sendJson(res, 200, r.value);
}

function deleteEvent(req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
  const r = eventService.remove(ctx.user, idOf(ctx));
  if (!r.ok) return sendEventError(req, res, r.error);
  res.writeHead(204, ignoredBodyHeaders(req));
  res.end();
}

// ---------- v1-only handlers (stubs and mock data, lecture 06) ----------

function badQuery(res: ServerResponse, errors: FieldError[]): void {
  sendJson(res, 400, { error: "Bad Request", details: detailsOf(errors), errors });
}

// Query policy (validation.ts): city, sort and page are scalar (a repeated key
// is a 400); sort is "id|name|seats" with an optional "-" for descending; page
// is a positive integer of at most 9 digits. Unknown keys are ignored. Events
// have no city, so city is accepted and echoed back but does not filter
// (deliberate simplification).
function listEventsV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const q = parseListQuery(ctx.query);
  if (!q.ok) return badQuery(res, q.errors);
  const { city, sort, page, offset } = q.value;
  const all = eventService.list();
  const sorted = [...all].sort((a, b) => {
    const x = a[sort.field];
    const y = b[sort.field];
    return (x < y ? -1 : x > y ? 1 : 0) * sort.direction;
  });
  sendJson(res, 200, {
    data: sorted.slice(offset, offset + PAGE_SIZE),
    meta: { page, pageSize: PAGE_SIZE, total: all.length, sort: sort.text, city },
  });
}

// Mock search: case-insensitive substring match on the name; no q returns all.
function searchEventsV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const q = scalar(ctx.query, "q");
  if (!q.ok) return badQuery(res, [{ path: "q", code: "REPEATED", message: "q must not be repeated" }]);
  sendJson(res, 200, {
    data: eventService.search(q.value ?? ""),
    meta: { q: q.value ?? null },
  });
}

// Synthetic tickets derived from the event; nothing is reserved or stored.
function listTickets(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const id = idOf(ctx);
  const event = eventService.get(id);
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

// ---------- route table ----------

export interface RouteContext extends RequestContext {
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
// Router guarantees the digit shape; parseId adds the safe-integer check. An
// unrepresentable id maps to -1, which no event has, so handlers answer 404.
const idOf = (ctx: RouteContext): number => parseId(ctx.params["id"]) ?? -1;

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
    r.add("GET", "/events", (_req, res) => sendJson(res, 200, eventService.list()));
  }
  r.add("POST", "/events", protect(createEvent));
  r.add("OPTIONS", "/events", optionsHandler);

  r.add("GET", "/events/:id", (req, res, ctx) => {
    const event = eventService.get(idOf(ctx));
    if (event) sendEvent(req, res, event);
    else sendJson(res, 404, { error: "Not Found" });
  }, ID);
  r.add("PUT", "/events/:id", protect((req, res, ctx) => modifyEvent("replace", req, res, ctx)), ID);
  if (v1) r.add("PATCH", "/events/:id", protect((req, res, ctx) => modifyEvent("patch", req, res, ctx)), ID);
  r.add("DELETE", "/events/:id", protect(deleteEvent), ID);
  r.add("OPTIONS", "/events/:id", optionsHandler, ID);

  if (v1) {
    r.add("GET", "/events/:id/tickets", listTickets, ID);
    r.add("OPTIONS", "/events/:id/tickets", optionsHandler, ID);
    r.add("POST", "/auth/register", register);
    r.add("OPTIONS", "/auth/register", optionsHandler);
    r.add("POST", "/auth/login", login);
    r.add("OPTIONS", "/auth/login", optionsHandler);
    r.add("POST", "/auth/logout", protect(logout));
    r.add("OPTIONS", "/auth/logout", optionsHandler);
    r.add("GET", "/auth/me", protect(me));
    r.add("OPTIONS", "/auth/me", optionsHandler);
    r.add("GET", "/me/tickets", protect(myTickets));
    r.add("OPTIONS", "/me/tickets", optionsHandler);
    r.add("GET", "/tickets/:id", protect(ticketById));
    r.add("OPTIONS", "/tickets/:id", optionsHandler);
    r.add("POST", "/bookings", bookingStub);
    r.add("OPTIONS", "/bookings", optionsHandler);
  }
}

export const router = new Router<AppHandler>();
router.add("GET", "/health", (_req, res) => sendJson(res, 200, { status: "ok" }));
registerEventRoutes(router, false); // legacy, unversioned (kept for lecture 05 clients)
registerEventRoutes(router.group("/api/v1"), true); // "/api/v2" is not implemented: 404

// ---------- request pipeline (lecture 10) ----------
//
//   request -> [context + request id + log] -> [cors] -> [error boundary]
//           -> route match -> [route middleware, e.g. requireAuth] -> handler
//           -> service -> repository
//
// Global middleware runs for every request, including 404/405. Route middleware
// runs only for the matched route, so public routes stay public.

// One JSON line per finished request; null disables. Never logs the query string,
// headers (Authorization), or bodies: only ids, method, path, status, timing.
export const logSink: { write: ((line: string) => void) | null } = {
  write: process.env.LOG_REQUESTS === "1" ? (line) => console.log(line) : null,
};

const observe: Middleware<RouteContext> = async (req, res, ctx, next) => {
  res.setHeader("X-Request-Id", ctx.requestId); // on every response, set before anything can reply
  res.on("finish", () => {
    logSink.write?.(
      JSON.stringify({
        requestId: ctx.requestId,
        method: req.method,
        path: new URL(req.url?.startsWith("/") ? `http://x${req.url}` : "http://x/", "http://x").pathname,
        status: res.statusCode,
        durationMs: Date.now() - ctx.startedAt,
        userId: ctx.user?.id ?? null,
      }),
    );
  });
  await next();
};

const cors: Middleware<RouteContext> = async (req, res, _ctx, next) => {
  applyCors(req, res);
  await next();
};

// Wraps everything downstream: a throw or rejection becomes one safe 500 (no stack,
// no message), or just ends the response if headers were already sent.
const errorBoundary: Middleware<RouteContext> = async (_req, res, ctx, next) => {
  try {
    await next();
  } catch (err) {
    logSink.write?.(
      JSON.stringify({ requestId: ctx.requestId, level: "error", error: err instanceof Error ? err.name : "unknown" }),
    );
    if (!res.headersSent) sendJson(res, 500, { error: "Internal Server Error" });
    else if (!res.writableEnded) res.end();
  }
};

function dispatch(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> | void {
  // Origin-form targets start with "/". Parse them against a fixed host so a
  // leading "//" stays part of the path (404) instead of being read as a host,
  // which would make "//x/events" an extra URL for /events. Other forms, such
  // as absolute-form ("GET http://host/events"), still go through the parser.
  const target = req.url ?? "/";
  const url = new URL(
    target.startsWith("/") ? `http://localhost${target}` : target,
    "http://localhost",
  );

  const result = router.match(req.method ?? "GET", url.pathname);
  switch (result.kind) {
    case "match":
      ctx.params = result.params;
      ctx.query = parseQuery(url.searchParams);
      ctx.allow = result.allow;
      ctx.prefix = result.prefix;
      return result.handler(req, res, ctx);
    case "method-not-allowed":
      return methodNotAllowed(res, result.allow);
    case "bad-request":
      return sendJson(res, 400, { error: "Bad Request" });
    case "not-found":
      return sendJson(res, 404, { error: "Not Found" });
  }
}

const pipeline = compose<RouteContext>([observe, cors, errorBoundary], dispatch);

export const server = createServer((req, res) => {
  const ctx: RouteContext = {
    ...createRequestContext(req, res),
    params: {},
    query: Object.create(null) as Query,
    allow: "",
    prefix: "",
  };
  // errorBoundary handles handler errors; this catch is only a last resort.
  pipeline(req, res, ctx).catch(() => res.destroy());
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
