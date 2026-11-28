import type { IncomingMessage, ServerResponse } from "node:http";
import { idOf, NO_STORE, notFound, sendJson, unprocessable } from "../../http/app.ts";
import type { Authed } from "../../http/app.ts";
import { readJsonBody } from "../../json.ts";
import type { BookingService } from "./service.ts";

export function createBookingsController(bookings: BookingService) {
  return {
    // POST /events/:id/bookings  { "quantity"?: 1..10 }
    // 201 booked | 404 no such event | 409 sold out (expected outcome, not an error) | 422 invalid body.
    async create(req: IncomingMessage, res: ServerResponse, ctx: Authed): Promise<void> {
      // An empty body means "one seat"; anything else must be valid JSON.
      let input: unknown;
      if (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"] !== undefined) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error }, parsed.status === 400 ? NO_STORE : { ...NO_STORE, Connection: "close" });
        input = parsed.value;
      }
      const r = await bookings.book(ctx.user.id, idOf(ctx), input);
      if (r.ok) return sendJson(res, 201, { data: r.booking, seatsLeft: r.seatsLeft }, NO_STORE);
      if (r.reason === "invalid") return unprocessable(res, r.errors);
      if (r.reason === "not-found") return notFound(res, NO_STORE);
      sendJson(res, 409, { error: "Conflict", code: "SOLD_OUT", detail: "not enough seats left" }, NO_STORE);
    },
  };
}
