import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { scalar } from "../../router.ts";
import { PAGE_SIZE, parseListQuery } from "../../validation.ts";
import { badQuery, forbidden, idOf, ignoredBodyHeaders, notFound, readJson, sendJson, unprocessable } from "../../http/app.ts";
import type { Authed, RouteContext } from "../../http/app.ts";
import type { EventItem } from "./repository.ts";
import type { EventError, EventService, Outcome } from "./service.ts";

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

// The only place event domain failures become HTTP statuses.
function sendEventError(req: IncomingMessage, res: ServerResponse, error: EventError): void {
  switch (error.kind) {
    case "not-found":
      return notFound(res, ignoredBodyHeaders(req));
    case "forbidden":
      return forbidden(req, res);
    case "invalid":
      return unprocessable(res, error.errors);
  }
}

export function createEventsController(events: EventService) {
  // Shared by PUT and PATCH. Existence (404) and permission (403) are decided before
  // the body is read; the service re-checks against the store as it is after the
  // body arrives, so a concurrent delete or change is still handled.
  async function modify(op: "replace" | "patch", req: IncomingMessage, res: ServerResponse, ctx: Authed): Promise<void> {
    const id = idOf(ctx);
    const pre = events.authorizeEdit(ctx.user, id);
    if (!pre.ok) return sendEventError(req, res, pre.error);
    const body = await readJson(req, res);
    if (!body) return;
    const r: Outcome<EventItem> = events[op](ctx.user, id, body.value);
    if (!r.ok) return sendEventError(req, res, r.error);
    sendJson(res, 200, r.value);
  }

  return {
    // Legacy unversioned list: the bare array of lecture 05.
    listLegacy(_req: IncomingMessage, res: ServerResponse): void {
      sendJson(res, 200, events.list());
    },

    // Query policy (validation.ts): city, sort and page are scalar (a repeated key
    // is a 400); sort is "id|name|seats" with an optional "-" for descending; page
    // is a positive integer of at most 9 digits. Unknown keys are ignored. Events
    // have no city, so city is accepted and echoed back but does not filter
    // (deliberate simplification).
    listV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
      const q = parseListQuery(ctx.query);
      if (!q.ok) return badQuery(res, q.errors);
      const { city, sort, page, offset } = q.value;
      const all = events.list();
      const sorted = [...all].sort((a, b) => {
        const x = a[sort.field];
        const y = b[sort.field];
        return (x < y ? -1 : x > y ? 1 : 0) * sort.direction;
      });
      sendJson(res, 200, {
        data: sorted.slice(offset, offset + PAGE_SIZE),
        meta: { page, pageSize: PAGE_SIZE, total: all.length, sort: sort.text, city },
      });
    },

    // Mock search: case-insensitive substring match on the name; no q returns all.
    searchV1(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
      const q = scalar(ctx.query, "q");
      if (!q.ok) return badQuery(res, [{ path: "q", code: "REPEATED", message: "q must not be repeated" }]);
      sendJson(res, 200, { data: events.search(q.value ?? ""), meta: { q: q.value ?? null } });
    },

    get(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
      const event = events.get(idOf(ctx));
      if (!event) return notFound(res);
      const etag = etagOf(JSON.stringify(event));
      const headers = { ETag: etag, "Cache-Control": "no-cache" };
      if (etagMatches(req.headers["if-none-match"], etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      sendJson(res, 200, event, headers);
    },

    async create(req: IncomingMessage, res: ServerResponse, ctx: Authed): Promise<void> {
      // Role is checked before the body is read, as before; the service re-checks.
      if (!events.canCreate(ctx.user)) return forbidden(req, res);
      const body = await readJson(req, res);
      if (!body) return;
      const r = events.create(ctx.user, body.value);
      if (!r.ok) return sendEventError(req, res, r.error);
      sendJson(res, 201, r.value, { Location: `${ctx.prefix}/events/${r.value.id}` });
    },

    replace: (req: IncomingMessage, res: ServerResponse, ctx: Authed) => modify("replace", req, res, ctx),
    patch: (req: IncomingMessage, res: ServerResponse, ctx: Authed) => modify("patch", req, res, ctx),

    remove(req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
      const r = events.remove(ctx.user, idOf(ctx));
      if (!r.ok) return sendEventError(req, res, r.error);
      res.writeHead(204, ignoredBodyHeaders(req));
      res.end();
    },
  };
}
