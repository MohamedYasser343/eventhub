import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { compose } from "../src/http/middleware.ts";
import type { Middleware } from "../src/http/middleware.ts";
import { EventService } from "../src/modules/events/service.ts";
import type { EventItem, EventRepository } from "../src/modules/events/repository.ts";
import { canCancelBooking } from "../src/modules/bookings/cancellation-policy.ts";
import { logSink } from "../src/server.ts";
import { pool } from "../src/db/pool.ts";
import { dbOwners } from "./db.ts";
import { dbEvents, resetEvents, SEED } from "./db.ts";
import { useServer, userToken } from "./helpers.ts";

// ---------- service with a fake repository: no HTTP server involved ----------

class FakeRepo implements EventRepository {
  calls: string[] = [];
  items = new Map<number, EventItem>([[1, { id: 1, name: "One", seats: 5 }]]);
  owners = new Map<number, number>([[1, 7]]);
  async findById(id: number) { this.calls.push("findById"); return this.items.get(id); }
  async findAll() { this.calls.push("findAll"); return [...this.items.values()]; }
  async query() { this.calls.push("query"); return { data: [...this.items.values()], total: this.items.size }; }
  async search() { this.calls.push("search"); return [...this.items.values()]; }
  async insert(f: { name: string; seats: number }, ownerId: number) {
    this.calls.push("insert");
    const e = { id: 2, ...f }; this.items.set(2, e); this.owners.set(2, ownerId); return e;
  }
  async replace(id: number, f: { name: string; seats: number }) {
    this.calls.push("replace");
    if (!this.items.has(id)) return undefined;
    const e = { id, ...f }; this.items.set(id, e); return e;
  }
  async remove(id: number) { this.calls.push("remove"); return this.items.delete(id); }
  async ownerOf(id: number) { return this.owners.get(id); }
}
const attendee = { id: 1, role: "attendee" as const };
const owner = { id: 7, role: "organizer" as const };
const other = { id: 8, role: "organizer" as const };
const admin = { id: 99, role: "admin" as const };

test("service: attendee cannot create; nothing reaches storage", async () => {
  const repo = new FakeRepo();
  const r = await new EventService(repo).create(attendee, { name: "X", seats: 1 });
  assert.deepEqual(r, { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(repo.calls, []);
});

test("service: invalid input is rejected before insert (no mutation)", async () => {
  const repo = new FakeRepo();
  const r = await new EventService(repo).create(owner, { name: "", seats: -1 });
  assert.equal(r.ok, false);
  assert.equal(repo.calls.includes("insert"), false);
});

test("service: create records the ACTOR as owner, never a client field", async () => {
  const repo = new FakeRepo();
  const r = await new EventService(repo).create(owner, { name: "Mine", seats: 3, ownerId: 1, role: "admin" });
  assert.equal(r.ok, true);
  assert.equal(repo.owners.get(2), owner.id);
});

test("service: replace/patch order is 404, then 403, then 422; owner and admin may edit", async () => {
  const svc = new EventService(new FakeRepo());
  assert.deepEqual(await svc.replace(owner, 42, {}), { ok: false, error: { kind: "not-found" } });
  assert.deepEqual(await svc.replace(other, 1, { name: "x", seats: 1 }), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(await svc.patch(attendee, 1, { seats: 1 }), { ok: false, error: { kind: "forbidden" } });
  const bad = await svc.patch(owner, 1, { seats: -5 });
  assert.equal(!bad.ok && bad.error.kind, "invalid");
  const ok = await svc.patch(owner, 1, { seats: 9 });
  assert.deepEqual(ok, { ok: true, value: { id: 1, name: "One", seats: 9 } });
  assert.equal((await svc.replace(admin, 1, { name: "A", seats: 2 })).ok, true);
});

test("service: remove is admin-only, 404 first", async () => {
  const repo = new FakeRepo();
  const svc = new EventService(repo);
  const gone = await svc.remove(admin, 5);
  assert.equal(!gone.ok && gone.error.kind, "not-found");
  assert.equal((await svc.remove(owner, 1)).ok, false);
  assert.equal(repo.items.has(1), true);
  assert.equal((await svc.remove(admin, 1)).ok, true);
});

// ---------- middleware runner ----------

type C = { trace: string[] };
const res = {} as never;
const req = {} as never;

test("middleware: runs in order, onion-style, then the handler", async () => {
  const ctx: C = { trace: [] };
  const mw = (n: string): Middleware<C> => async (_q, _s, c, next) => { c.trace.push(`${n}>`); await next(); c.trace.push(`<${n}`); };
  await compose<C>([mw("a"), mw("b")], (_q, _s, c) => void c.trace.push("handler"))(req, res, ctx);
  assert.deepEqual(ctx.trace, ["a>", "b>", "handler", "<b", "<a"]);
});

test("middleware: short-circuit means downstream is never invoked", async () => {
  const ctx: C = { trace: [] };
  const reject: Middleware<C> = (_q, _s, c) => void c.trace.push("rejected");
  let downstream = 0;
  await compose<C>([reject, async (_q, _s, _c, next) => { downstream++; await next(); }], () => void downstream++)(req, res, ctx);
  assert.equal(downstream, 0);
});

test("middleware: calling next() twice is an error, not a second run", async () => {
  let handled = 0;
  const twice: Middleware<C> = async (_q, _s, _c, next) => { await next(); await next(); };
  await assert.rejects(compose<C>([twice], () => void handled++)(req, res, { trace: [] }), /multiple times/);
  assert.equal(handled, 1);
});

test("middleware: a downstream rejection reaches the upstream catch", async () => {
  const seen: string[] = [];
  const boundary: Middleware<C> = async (_q, _s, _c, next) => { try { await next(); } catch (e) { seen.push((e as Error).message); } };
  await compose<C>([boundary], async () => { throw new Error("boom"); })(req, res, { trace: [] });
  assert.deepEqual(seen, ["boom"]);
});

// ---------- cancellation policy (pure, fixed clock) ----------

const NOW = Date.parse("2026-12-01T00:00:00Z");
const H = 3_600_000;
const facts = (a: { id: number; role: "attendee" | "admin" }, ownerId: number, hours: number, status: "active" | "cancelled" | "completed" = "active") =>
  ({ actor: a, booking: { ownerId, status }, eventStartsAt: NOW + hours * H, now: NOW });

test("cancellation policy table", () => {
  const u = { id: 1, role: "attendee" as const };
  assert.deepEqual(canCancelBooking(facts(u, 1, 30)), { allowed: true });
  assert.deepEqual(canCancelBooking(facts(u, 1, 24)), { allowed: true }); // inclusive boundary
  assert.deepEqual(canCancelBooking(facts(u, 1, 23)), { allowed: false, reason: "TOO_LATE" });
  assert.deepEqual(canCancelBooking(facts(u, 1, 24 - 1 / 3600)), { allowed: false, reason: "TOO_LATE" }); // 1 s short
  assert.deepEqual(canCancelBooking(facts(u, 2, 40)), { allowed: false, reason: "NOT_OWNER" });
  assert.deepEqual(canCancelBooking(facts({ id: 9, role: "admin" }, 2, 1)), { allowed: true });
  // lifecycle invariant is independent of admin status
  assert.deepEqual(canCancelBooking(facts({ id: 9, role: "admin" }, 2, 100, "cancelled")), { allowed: false, reason: "NOT_ACTIVE" });
  assert.deepEqual(canCancelBooking(facts(u, 1, 100, "completed")), { allowed: false, reason: "NOT_ACTIVE" });
});

// ---------- through HTTP: request id, logging, isolation, error boundary ----------

const api = useServer();
const json = { "Content-Type": "application/json" };

async function withLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const prev = logSink.write;
  logSink.write = (l) => lines.push(l);
  try {
    return { result: await fn(), lines };
  } finally {
    logSink.write = prev;
  }
}

test("every response carries a distinct X-Request-Id (200, 401, 404, 405, 422)", async () => {
  const ids = new Set<string>();
  const calls: [string, RequestInit][] = [
    ["/health", {}],
    ["/events/999", {}],
    ["/events", { method: "DELETE" }],
    ["/api/v1/auth/me", { headers: { "X-Test-Anon": "1" } }], // 401
    ["/events", { method: "POST", headers: json, body: JSON.stringify({ name: "", seats: -1 }) }], // 422
  ];
  for (const [path, init] of calls) {
    const r = await fetch(`${api.base}${path}`, init);
    const id = r.headers.get("x-request-id");
    assert.match(id ?? "", /^[A-Za-z0-9._-]{8,64}$/, path);
    ids.add(id!);
  }
  assert.equal(ids.size, calls.length);
});

test("a safe inbound X-Request-Id is kept; an unsafe one is replaced", async () => {
  const kept = await fetch(`${api.base}/health`, { headers: { "X-Request-Id": "client-trace-12345" } });
  assert.equal(kept.headers.get("x-request-id"), "client-trace-12345");
  const bad = await fetch(`${api.base}/health`, { headers: { "X-Request-Id": "x y\"<script>" } });
  assert.notEqual(bad.headers.get("x-request-id"), "x y\"<script>");
  const short = await fetch(`${api.base}/health`, { headers: { "X-Request-Id": "a" } });
  assert.notEqual(short.headers.get("x-request-id"), "a");
});

test("log line carries the response's request id and nothing sensitive", async () => {
  const secret = "s3cr3t-query-value";
  const { result, lines } = await withLog(() =>
    fetch(`${api.base}/api/v1/events?city=${secret}`, { headers: { "X-Request-Id": "trace-for-logging" } }),
  );
  assert.equal(result.headers.get("x-request-id"), "trace-for-logging");
  await new Promise((r) => setTimeout(r, 20));
  const joined = lines.join("\n");
  const entry = JSON.parse(lines.find((l) => l.includes("trace-for-logging"))!);
  assert.equal(entry.requestId, "trace-for-logging");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/api/v1/events");
  assert.equal(entry.status, 200);
  assert.equal(entry.userId !== undefined, true);
  assert.equal(joined.includes(secret), false, "query string must not be logged");
  assert.equal(joined.includes(api.adminToken), false, "token must not be logged");
  assert.equal(/bearer/i.test(joined), false);
});

test("rejected protected request (401) never reaches the service or storage", async () => {
  const before = JSON.stringify(await dbEvents());
  const ownersBefore = await dbOwners();
  const { lines } = await withLog(async () => {
    const r = await fetch(`${api.base}/events`, {
      method: "POST",
      headers: { ...json, "X-Test-Anon": "1", Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ name: "Intruder", seats: 1 }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /invalid_token/);
    const del = await fetch(`${api.base}/events/1`, { method: "DELETE", headers: { "X-Test-Anon": "1" } });
    assert.equal(del.status, 401);
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.stringify(await dbEvents()), before);
  assert.deepEqual(await dbOwners(), ownersBefore);
  assert.equal(lines.filter((l) => JSON.parse(l).status === 401).length, 2);
});

test("public routes stay public (no Authorization needed)", async () => {
  for (const p of ["/health", "/events", "/api/v1/events", "/api/v1/events/1/tickets"]) {
    const r = await fetch(`${api.base}${p}`, { headers: { "X-Test-Anon": "1" } });
    assert.equal(r.status, 200, p);
  }
});

// Sends headers now, the body only when told to: lets two requests be in flight
// (past authentication, awaiting their bodies) at the same moment.
function slowPost(base: string, token: string, body: string) {
  const url = new URL(`${base}/events`);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const done = new Promise<{ status: number; requestId: string; body: EventItem }>((resolve, reject) => {
    const rq = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", agent: false,
        headers: { ...json, Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body) } },
      (rs) => {
        let data = "";
        rs.on("data", (c) => (data += c));
        rs.on("end", () => resolve({ status: rs.statusCode!, requestId: String(rs.headers["x-request-id"]), body: JSON.parse(data) }));
      },
    );
    rq.on("error", reject);
    rq.flushHeaders();
    void gate.then(() => rq.end(body));
  });
  return { release, done };
}

test("interleaved authenticated requests keep their own identity and request id", async () => {
  const alice = await userToken(api.base, "organizer");
  const bob = await userToken(api.base, "organizer");
  const a = slowPost(api.base, alice.token, JSON.stringify({ name: "Alice event", seats: 1, ownerId: bob.id }));
  const b = slowPost(api.base, bob.token, JSON.stringify({ name: "Bob event", seats: 2, ownerId: alice.id }));
  // Both are authenticated and waiting on their body. Finish Bob first, then Alice:
  // completion order is the reverse of arrival order, a global "currentUser" would break.
  b.release();
  const rb = await b.done;
  a.release();
  const ra = await a.done;
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.requestId, rb.requestId);
  const owners = new Map(await dbOwners());
  assert.equal(owners.get(ra.body.id), alice.id);
  assert.equal(owners.get(rb.body.id), bob.id);
});

test("impersonation attempt: body ownerId/role/id are ignored", async () => {
  const org = await userToken(api.base, "organizer");
  const r = await fetch(`${api.base}/events`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${org.token}` },
    body: JSON.stringify({ name: "Mine", seats: 1, id: 1, ownerId: 1, role: "admin" }),
  });
  const created = (await r.json()) as EventItem;
  assert.equal(r.status, 201);
  assert.notEqual(created.id, 1);
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "seats"]);
  assert.equal((await dbOwners()).find(([id]) => id === created.id)?.[1], org.id);
});

test("an exception downstream becomes one safe 500 with the request id", async () => {
  // A real storage failure: the database call throws an error carrying a secret.
  const realQuery = pool.query.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].includes("INSERT INTO events")) throw new Error("db password is hunter2");
    return realQuery(...a);
  };
  const before = (await dbEvents()).length;
  try {
    const { result, lines } = await withLog(() =>
      fetch(`${api.base}/events`, { method: "POST", headers: json, body: JSON.stringify({ name: "Boom", seats: 1 }) }),
    );
    assert.equal(result.status, 500);
    const text = await result.text();
    assert.deepEqual(JSON.parse(text), { error: "Internal Server Error" });
    assert.equal(text.includes("hunter2"), false);
    assert.ok(result.headers.get("x-request-id"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.join("\n").includes("hunter2"), false, "error message must not be logged");
    assert.ok(lines.some((l) => JSON.parse(l).level === "error"));
  } finally {
    (pool as unknown as { query: unknown }).query = realQuery;
  }
  assert.equal((await dbEvents()).length, before);
  // the server is still healthy afterwards
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
});
