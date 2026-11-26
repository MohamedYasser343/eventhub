import type { IncomingMessage, ServerResponse } from "node:http";
import { NO_STORE, readJson, sendJson } from "../../http/app.ts";
import type { Authed } from "../../http/app.ts";
import type { AccountService } from "./service.ts";

export function createAuthController(accounts: AccountService, addressOf: (req: IncomingMessage) => string = (req) => req.socket.remoteAddress ?? "?") {
  return {
    async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const body = await readJson(req, res);
      if (!body) return;
      const r = await accounts.register(body.value, addressOf(req));
      if (r.ok) return sendJson(res, 201, r.user, NO_STORE);
      if (r.kind === "rate-limited") {
        return sendJson(res, 429, { error: "Too Many Requests" }, { ...NO_STORE, "Retry-After": String(r.retryAfter) });
      }
      if (r.kind === "invalid") return sendJson(res, 422, { error: "Unprocessable Content", details: r.details }, NO_STORE);
      sendJson(res, 409, { error: "Username already taken" }, NO_STORE);
    },

    async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const body = await readJson(req, res);
      if (!body) return;
      const r = await accounts.login(body.value, addressOf(req));
      if (r.ok) {
        return sendJson(res, 200, {
          token: r.token,
          tokenType: "Bearer",
          expiresAt: new Date(r.expiresAt).toISOString(),
          user: r.user,
        }, NO_STORE);
      }
      if (r.kind === "rate-limited") {
        return sendJson(res, 429, { error: "Too Many Requests" }, { ...NO_STORE, "Retry-After": String(r.retryAfter) });
      }
      sendJson(res, 401, { error: "Invalid credentials" }, NO_STORE);
    },

    async logout(_req: IncomingMessage, res: ServerResponse, ctx: Authed): Promise<void> {
      await accounts.logout(ctx.token);
      res.writeHead(204, NO_STORE);
      res.end();
    },

    me(_req: IncomingMessage, res: ServerResponse, ctx: Authed): void {
      const { id, username, role } = ctx.user;
      sendJson(res, 200, { id, username, role }, NO_STORE);
    },
  };
}
