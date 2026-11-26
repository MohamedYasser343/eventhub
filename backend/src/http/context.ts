import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
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

// Lecture 22: the address used for per-client rate limits. Behind a reverse proxy every connection's socket
// peer is the PROXY, so keying on it alone would put all clients in one bucket (one attacker could lock
// everyone out). X-Forwarded-For is believed ONLY when the socket peer is a configured trusted proxy;
// from any other peer the header is client-controlled and ignored. The header is read from the right
// (the entry a trusted proxy appended), skipping trusted proxy hops; a malformed entry falls back to the peer.
export function clientAddress(req: IncomingMessage, trusted: ReadonlySet<string>): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? "?");
  if (trusted.size === 0 || !trusted.has(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const raw = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((p) => normalizeIp(p.trim())).filter((p) => p !== "");
  for (let i = raw.length - 1; i >= 0; i--) {
    const hop = raw[i]!;
    if (isIP(hop) === 0) return peer; // garbage: do not guess
    if (!trusted.has(hop)) return hop;
  }
  return peer;
}
const normalizeIp = (ip: string): string => (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);
