import { isDbUnavailable } from "../db/pool.ts";
import { log } from "../observability/logger.ts";
import { sendJson } from "./app.ts";
import type { RouteContext } from "./app.ts";
import type { Middleware } from "./middleware.ts";

// Lecture 16: the one place where an UNEXPECTED failure becomes an HTTP response.
// Expected outcomes (validation, 404, 409, ...) never throw; services return them as
// typed outcomes and controllers map them. What reaches this boundary is either
//   - a dependency problem (PostgreSQL unreachable)  -> 503 + Retry-After, or
//   - a bug / anything unknown                       -> 500.
// Both bodies are generic and carry the request id so a user can quote it; the cause
// (SQL, host, stack, message) goes nowhere but is reduced to a "kind" for the log.

export const RETRY_AFTER_SECONDS = "5";

// `emit` is an optional override (tests); by default the failure goes through the structured logger.
export type ErrorLog = (record: Record<string, unknown>) => void;

export function createErrorBoundary(emit?: ErrorLog): Middleware<RouteContext> {
  return async (_req, res, ctx, next) => {
    try {
      await next();
    } catch (err) {
      const unavailable = isDbUnavailable(err);
      const kind = unavailable ? "db-unavailable" : "unexpected";
      const name = err instanceof Error ? err.name : "unknown";
      // Logged ONCE, here, with request id/trace id from the request scope. Name only: no message, SQL or stack.
      if (emit) emit({ requestId: ctx.requestId, level: "error", kind, error: name });
      else log("error", unavailable ? "request.dependency_unavailable" : "request.unexpected_error", { kind, error: name, route: ctx.route });
      if (res.headersSent) {
        // A second JSON response is impossible; cut the stream so the client sees a failure.
        if (!res.writableEnded) res.end();
        return;
      }
      if (unavailable) {
        sendJson(res, 503, { error: "Service Unavailable", requestId: ctx.requestId }, { "Retry-After": RETRY_AFTER_SECONDS, "Cache-Control": "no-store" });
      } else {
        sendJson(res, 500, { error: "Internal Server Error", requestId: ctx.requestId }, { "Cache-Control": "no-store" });
      }
    }
  };
}
