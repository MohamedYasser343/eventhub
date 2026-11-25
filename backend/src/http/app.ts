import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth.ts";
import { detailsOf, parseId } from "../validation.ts";
import type { FieldError } from "../validation.ts";
import { readJsonBody } from "../json.ts";
import type { Query } from "../router.ts";
import type { RequestContext } from "./context.ts";
import { compose } from "./middleware.ts";
import type { Middleware } from "./middleware.ts";

// Shared HTTP plumbing for controllers: the per-request context type, response
// helpers and the authentication middleware. Controllers import from here, not
// from server.ts (which only composes and wires).

export interface RouteContext extends RequestContext {
  params: Record<string, string>;
  query: Query;
  allow: string;
  prefix: string; // "" for the legacy routes, "/api/v1" for v1
  route: string; // matched route TEMPLATE ("/api/v1/events/:id"), or "unmatched": the bounded telemetry label
}
export type AppHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void | Promise<void>;
export type Authed = RouteContext & { user: NonNullable<RequestContext["user"]>; token: string };
export type AuthedHandler = (req: IncomingMessage, res: ServerResponse, ctx: Authed) => void | Promise<void>;

export const NO_STORE = { "Cache-Control": "no-store" };

export function sendJson(
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

// The request body is ignored (DELETE, or PUT on a missing event). If one was
// sent, close the connection so an unread, possibly huge body is not drained.
export function ignoredBodyHeaders(req: IncomingMessage): Record<string, string> {
  const hasBody =
    Number(req.headers["content-length"]) > 0 ||
    req.headers["transfer-encoding"] !== undefined;
  return hasBody ? { Connection: "close" } : {};
}

export function forbidden(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 403, { error: "Forbidden" }, ignoredBodyHeaders(req));
}

export function notFound(res: ServerResponse, extra: Record<string, string> = {}): void {
  sendJson(res, 404, { error: "Not Found" }, extra);
}

// 422: valid JSON that violates the contract. `details` is the legacy message
// list (kept for compatibility); `errors` adds stable field paths and codes.
export function unprocessable(res: ServerResponse, errors: FieldError[]): void {
  sendJson(res, 422, { error: "Unprocessable Content", details: detailsOf(errors), errors });
}

export function badQuery(res: ServerResponse, errors: FieldError[]): void {
  sendJson(res, 400, { error: "Bad Request", details: detailsOf(errors), errors });
}

// Reads and parses a JSON request body (see json.ts). On any problem the error
// response (415/413/400) has already been sent and null is returned. Wrapping the
// value lets a legitimate JSON `null` body be told apart from failure.
export async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ value: unknown } | null> {
  const result = await readJsonBody(req);
  if (result.ok) return { value: result.value };
  // 400 leaves the connection usable; 413/415 may leave an unread body behind.
  sendJson(res, result.status, { error: result.error }, result.status === 400 ? {} : { Connection: "close" });
  return null;
}

// Router guarantees the digit shape; parseId adds the safe-integer check. An
// unrepresentable id maps to -1, which no event has, so handlers answer 404.
export const idOf = (ctx: RouteContext): number => parseId(ctx.params["id"]) ?? -1;

function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

// Route middleware factory: 401 unless the request carries a valid session. On
// success the VERIFIED identity is stored on this request's context; nothing
// downstream reads identity from the client. A rejection never calls next(), so
// the handler (and any service or storage behind it) is not invoked.
export function createProtect(sessions: Pick<AuthService, "authenticate">): (h: AuthedHandler) => AppHandler {
  const requireAuth: Middleware<RouteContext> = async (req, res, ctx, next) => {
    const token = bearerToken(req);
    const user = token ? await sessions.authenticate(token) : null;
    if (!token || !user) {
      const challenge = req.headers.authorization === undefined ? "Bearer" : 'Bearer error="invalid_token"';
      sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": challenge, ...ignoredBodyHeaders(req) });
      return;
    }
    ctx.user = { id: user.id, username: user.username, role: user.role };
    ctx.token = token;
    await next();
  };
  // Marks a route as protected: requireAuth runs first, then the handler.
  return (h) => compose<RouteContext>([requireAuth], (req, res, ctx) => h(req, res, ctx as Authed));
}
