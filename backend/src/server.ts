import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseQuery, Router } from "./router.ts";
import type { Query, Registrar } from "./router.ts";
import { AuthService, ticketsByUser } from "./auth.ts";
import { pool } from "./db/pool.ts";
import { cache, cacheTtlSeconds } from "./cache.ts";
import { loadConfig, parseServerConfig } from "./config.ts";
import { seedDemo } from "./db/seed.ts";
import { PgUserRepository } from "./modules/auth/user-repository.ts";
import { createProtect, forbidden, ignoredBodyHeaders, sendJson } from "./http/app.ts";
import type { AppHandler, RouteContext } from "./http/app.ts";
import { createRequestContext } from "./http/context.ts";
import { compose } from "./http/middleware.ts";
import { createErrorBoundary } from "./http/error-boundary.ts";
import { log, logSettings, logSink } from "./observability/logger.ts";
import { m, methodLabel, renderMetrics, SpanStatusCode, startRequestSpan, statusClass } from "./observability/otel.ts";
import { runInScope } from "./observability/scope.ts";
import { context } from "@opentelemetry/api";
import { createReadyHandler, liveHandler } from "./http/health.ts";
import type { Middleware } from "./http/middleware.ts";
import { createAuthController } from "./modules/auth/controller.ts";
import { AccountService } from "./modules/auth/service.ts";
import { createEventsController } from "./modules/events/controller.ts";
import { PgEventRepository } from "./modules/events/repository.ts";
import type { EventItem } from "./modules/events/repository.ts";
import { EventService } from "./modules/events/service.ts";
import { PublicEventCache } from "./modules/events/public-cache.ts";
import { createTicketsController } from "./modules/tickets/controller.ts";
import { InMemoryTicketRepository } from "./modules/tickets/repository.ts";
import { TicketService } from "./modules/tickets/service.ts";

export type { EventItem, RouteContext };
export { logSink }; // moved to observability/logger.ts in lecture 18; still importable from here


// Lecture 17: validated once, before anything is wired or listening.
const config = loadConfig(parseServerConfig);
logSettings.level = config.logLevel;
// One JSON line per event; null (the default, LOG_REQUESTS=0) disables output entirely.
if (config.logRequests) logSink.write = (line) => console.log(line);

// ---------- composition root ----------
// The only place where concrete classes are chosen and wired, by hand (no DI
// container). Dependencies point inward: controller -> service -> repository.
export const auth = new AuthService(new PgUserRepository(pool));
// Cache failures are logged as ids + operation only (never keys' values or the URL).
export const publicEventCache = new PublicEventCache(cache, cacheTtlSeconds, (what, id) =>
  log("warn", "cache.degraded", { cache: what, eventId: id }),
);
const eventService = new EventService(new PgEventRepository(pool), publicEventCache);
const ticketService = new TicketService(new InMemoryTicketRepository(ticketsByUser), eventService);
const accountService = new AccountService(auth);
const protect = createProtect(auth);
const eventsCtl = createEventsController(eventService);
const ticketsCtl = createTicketsController(ticketService);
const authCtl = createAuthController(accountService);

// Exactly one browser origin may read responses (CORS). Anything else gets no
// CORS headers, so the browser, not the server, blocks it.
const ALLOWED_ORIGIN = config.corsOrigin;

// Allow lists are no longer hard-coded: the router derives them from the routes
// registered for each path, so they cannot drift from what is really served.

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

// ---------- route table ----------

// Canonical id: positive decimal, no leading zeros. Declared as a constraint so
// a non-matching segment never reaches a handler.
const ID = { id: /^[1-9][0-9]*$/ };

const optionsHandler: AppHandler = (req, res, ctx) => handleOptions(req, res, ctx.allow);

// Booking is out of scope for now: the route exists, nothing happens.
function bookingStub(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 501, { error: "Not Implemented", detail: "booking is a stub" }, ignoredBodyHeaders(req));
}

// The event routes of lecture 05. `v1` adds the lecture 06 extras; the legacy
// unversioned table stays exactly as lecture 05 clients know it.
function registerEventRoutes(r: Registrar<AppHandler>, v1: boolean): void {
  if (v1) {
    r.add("GET", "/events", eventsCtl.listV1);
    // Registered before "/events/:id" AND the id is constrained: two independent
    // protections against "search" being read as an id.
    r.add("GET", "/events/search", eventsCtl.searchV1);
    r.add("OPTIONS", "/events/search", optionsHandler);
  } else {
    r.add("GET", "/events", eventsCtl.listLegacy);
  }
  r.add("POST", "/events", protect(eventsCtl.create));
  r.add("OPTIONS", "/events", optionsHandler);

  r.add("GET", "/events/:id", eventsCtl.get, ID);
  r.add("PUT", "/events/:id", protect(eventsCtl.replace), ID);
  if (v1) r.add("PATCH", "/events/:id", protect(eventsCtl.patch), ID);
  r.add("DELETE", "/events/:id", protect(eventsCtl.remove), ID);
  r.add("OPTIONS", "/events/:id", optionsHandler, ID);

  if (v1) {
    r.add("GET", "/events/:id/tickets", ticketsCtl.forEvent, ID);
    r.add("OPTIONS", "/events/:id/tickets", optionsHandler, ID);
    r.add("POST", "/auth/register", authCtl.register);
    r.add("OPTIONS", "/auth/register", optionsHandler);
    r.add("POST", "/auth/login", authCtl.login);
    r.add("OPTIONS", "/auth/login", optionsHandler);
    r.add("POST", "/auth/logout", protect(authCtl.logout));
    r.add("OPTIONS", "/auth/logout", optionsHandler);
    r.add("GET", "/auth/me", protect(authCtl.me));
    r.add("OPTIONS", "/auth/me", optionsHandler);
    r.add("GET", "/me/tickets", protect(ticketsCtl.mine));
    r.add("OPTIONS", "/me/tickets", optionsHandler);
    r.add("GET", "/tickets/:id", protect(ticketsCtl.byId));
    r.add("OPTIONS", "/tickets/:id", optionsHandler);
    r.add("POST", "/bookings", bookingStub);
    r.add("OPTIONS", "/bookings", optionsHandler);
  }
}

export const router = new Router<AppHandler>();
router.add("GET", "/health", (_req, res) => sendJson(res, 200, { status: "ok" }));
router.add("GET", "/health/live", liveHandler); // lecture 16: process answers
router.add("GET", "/health/ready", createReadyHandler(pool)); // lecture 16: PostgreSQL reachable (bounded)
// Lecture 18: operational metrics are not public (they reveal routes, volume and failure rates).
// Admin session required; there is deliberately no unauthenticated variant.
router.add(
  "GET",
  "/internal/metrics",
  protect((req, res, ctx) => {
    if (ctx.user.role !== "admin") return forbidden(req, res);
    return renderMetrics().then((body) => {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      res.end(body);
    });
  }),
);
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

// Lecture 18: the root of every trace and the source of every request metric. It sits OUTSIDE the
// error boundary so that a 500/503 produced by the boundary is still measured and logged, and it
// finalizes exactly once whether the response finished or the client went away.
const observe: Middleware<RouteContext> = async (req, res, ctx, next) => {
  res.setHeader("X-Request-Id", ctx.requestId); // on every response, set before anything can reply
  // An incoming traceparent is untrusted: extractParent() accepts only a well-formed one.
  const method = methodLabel(req.method);
  const { span: root, ctx: traceCtx } = startRequestSpan(req.headers["traceparent"], method);
  m.httpActive.add(1);
  let finalized = false;
  const finalize = (aborted: boolean): void => {
    if (finalized) return;
    finalized = true;
    m.httpActive.add(-1);
    const durationMs = Date.now() - ctx.startedAt;
    const status = aborted ? 499 : res.statusCode; // 499 = client closed the request (nothing was sent)
    const route = ctx.route; // a template or "unmatched": never the raw URL
    m.httpDuration.record(durationMs / 1000, { "http.request.method": method, "http.route": route, "http.response.status_class": aborted ? "aborted" : statusClass(status) });
    root.updateName(`${method} ${route}`);
    root.setAttribute("http.route", route);
    root.setAttribute("http.response.status_code", status);
    if (status >= 500) root.setStatus({ code: SpanStatusCode.ERROR });
    // The completion record is written while the root span is still the active context.
    context.with(traceCtx, () => {
      // 5xx: error. 4xx (validation, auth, not-found) are EXPECTED outcomes of a working server: info.
      const level = status >= 500 ? "error" : aborted ? "warn" : "info";
      log(level, aborted ? "request.aborted" : "request.completed", {
        method: req.method,
        // pathname only: the query string may carry data and is never logged
        path: new URL(req.url?.startsWith("/") ? `http://x${req.url}` : "http://x/", "http://x").pathname,
        route,
        status,
        durationMs,
        userId: ctx.user?.id ?? null,
      });
    });
    root.end();
  };
  res.once("finish", () => finalize(false));
  res.once("close", () => finalize(!res.writableFinished));
  await context.with(traceCtx, () => runInScope({ requestId: ctx.requestId }, next));
};

const cors: Middleware<RouteContext> = async (req, res, _ctx, next) => {
  applyCors(req, res);
  await next();
};

// Lecture 16: see http/error-boundary.ts (500 for bugs, 503 when PostgreSQL is unreachable).
const errorBoundary = createErrorBoundary();

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
      ctx.route = result.template;
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
    route: "unmatched",
  };
  // errorBoundary handles handler errors; this catch is only a last resort.
  pipeline(req, res, ctx).catch(() => res.destroy());
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (config.seedDemoUsers) await seedDemo(auth, pool); // same as `npm run seed`
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`EventHub listening on http://127.0.0.1:${config.port}`);
  });
}
