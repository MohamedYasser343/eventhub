import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Role } from "../auth.ts";

// Lecture 10: state that belongs to ONE request. A fresh object is created per
// incoming request and passed explicitly; there is no global "currentUser".
export interface RequestContext {
  requestId: string;
  startedAt: number;
  // Set only by the authenticate middleware from a verified session, never from
  // anything the client put in a body, query or custom header.
  user?: { id: number; username: string; role: Role };
  token?: string; // the verified bearer token (needed by logout)
  signal?: AbortSignal; // aborts when the client disconnects before the response
}

// An incoming X-Request-Id is untrusted input: it is accepted only if it is a
// short token of safe characters (it ends up in a header and in log lines).
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdFor(req: IncomingMessage): string {
  const given = req.headers["x-request-id"];
  return typeof given === "string" && SAFE_ID.test(given) ? given : randomUUID();
}

export function createRequestContext(req: IncomingMessage, res: ServerResponse, now: () => number = Date.now): RequestContext {
  const ac = new AbortController();
  // The response closing before it finished means the client went away. (Listening
  // on res, not the shared keep-alive socket, avoids piling up listeners.)
  res.once("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return { requestId: requestIdFor(req), startedAt: now(), signal: ac.signal };
}
