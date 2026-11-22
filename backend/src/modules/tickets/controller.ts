import type { IncomingMessage, ServerResponse } from "node:http";
import { idOf, NO_STORE, notFound, sendJson } from "../../http/app.ts";
import type { Authed, RouteContext } from "../../http/app.ts";
import type { TicketService } from "./service.ts";

export function createTicketsController(tickets: TicketService) {
  return {
    mine(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
      sendJson(res, 200, { data: tickets.mine(ctx.user.id) }, NO_STORE);
    },
    byId(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
      const ticket = tickets.ownedById(ctx.user.id, ctx.params["id"] ?? "");
      if (!ticket) return notFound(res, NO_STORE);
      sendJson(res, 200, ticket, NO_STORE);
    },
    async forEvent(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
      const data = await tickets.forEvent(idOf(ctx));
      if (!data) return notFound(res);
      sendJson(res, 200, { data });
    },
  };
}
