import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import test, { after, before, describe } from "node:test";
import { auth } from "../src/server.ts";
import { pool } from "../src/db/pool.ts";
import { PgBookingRepository } from "../src/modules/bookings/repository.ts";
import { resetEvents } from "./db.ts";
import { useServer } from "./helpers.ts";

// Lecture 23: POST /api/v1/events/:id/bookings. Buyers are synthetic users inserted directly (no password
// login), each with its own session, so the login limiter is not part of what is measured.
const ctx = useServer();
const v1 = (p: string) => `${ctx.base}/api/v1${p}`;

async function makeBuyers(n: number, prefix: string): Promise<{ id: number; token: string }[]> {
  const out: { id: number; token: string }[] = [];
  for (let i = 0; i < n; i++) {
    const r = await pool.query<{ id: number }>("INSERT INTO users (username, role, password_hash) VALUES ($1, 'attendee', 'x') RETURNING id", [`${prefix}_${i}`]);
    out.push({ id: r.rows[0]!.id, token: (await auth.createSession(r.rows[0]!.id)).token });
  }
  return out;
}
const post = (base: string, eventId: number, token: string, body?: unknown) =>
  fetch(`${base}/api/v1/events/${eventId}/bookings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const stock = async (id: number) => (await pool.query<{ seats: number }>("SELECT seats FROM events WHERE id = $1", [id])).rows[0]!.seats;
const rows = async (id: number) => (await pool.query<{ n: number; q: number }>("SELECT count(*)::int AS n, coalesce(sum(quantity),0)::int AS q FROM bookings WHERE event_id = $1", [id])).rows[0]!;

describe("booking invariant", () => {
  let buyers: { id: number; token: string }[] = [];
  before(async () => {
    buyers = await makeBuyers(100, "bk");
  });

  test("100 distinct buyers, 10 seats: exactly 10 x 201, 90 x 409, stock 0, 10 booking rows", async () => {
    await resetEvents([{ id: 1, name: "Last ten", seats: 10 }]);
    const res = await Promise.all(buyers.map((b) => post(ctx.base, 1, b.token)));
    const statuses = res.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 10);
    assert.equal(statuses.filter((s) => s === 409).length, 90, `unexpected statuses: ${[...new Set(statuses)]}`);
    assert.equal(await stock(1), 0);
    assert.deepEqual(await rows(1), { n: 10, q: 10 });
    const distinct = (await pool.query<{ n: number }>("SELECT count(DISTINCT user_id)::int AS n FROM bookings WHERE event_id = 1")).rows[0]!.n;
    assert.equal(distinct, 10, "one booking per winning buyer");
    const sold = (await res.find((r) => r.status === 409)!.json()) as { code: string };
    assert.equal(sold.code, "SOLD_OUT");
  });

  test("quantities: never oversold, stock = start - booked", async () => {
    await resetEvents([{ id: 1, name: "Quantities", seats: 25 }]);
    const res = await Promise.all(buyers.slice(0, 40).map((b, i) => post(ctx.base, 1, b.token, { quantity: (i % 4) + 1 })));
    assert.ok(res.every((r) => r.status === 201 || r.status === 409));
    const r = await rows(1);
    assert.ok(r.q <= 25);
    assert.equal(await stock(1), 25 - r.q);
    assert.equal(res.filter((x) => x.status === 201).length, r.n);
  });

  test("a request for more seats than remain is refused whole (no partial booking)", async () => {
    await resetEvents([{ id: 1, name: "Few", seats: 3 }]);
    assert.equal((await post(ctx.base, 1, buyers[0]!.token, { quantity: 4 })).status, 409);
    assert.equal(await stock(1), 3);
    assert.equal((await rows(1)).n, 0);
  });

  test("failure after the decrement and before the insert: rollback, stock intact, next booking works", async () => {
    await resetEvents([{ id: 1, name: "Fault", seats: 5 }]);
    let armed = true;
    const repo = new PgBookingRepository(pool, {
      afterDecrement: async () => {
        if (armed) throw new Error("injected");
      },
    });
    await assert.rejects(repo.book(1, buyers[0]!.id, 2), /injected/);
    assert.equal(await stock(1), 5, "decrement undone");
    assert.equal((await rows(1)).n, 0);
    armed = false;
    const ok = await repo.book(1, buyers[0]!.id, 2);
    assert.ok(ok.ok && ok.seatsLeft === 3);
    assert.equal(await stock(1), 3);
    assert.equal(pool.idleCount, pool.totalCount, "connection released");
  });

  test("NEGATIVE: 401, 404, invalid quantity and malformed body mutate nothing", async () => {
    await resetEvents([{ id: 1, name: "Negatives", seats: 5 }]);
    const t = buyers[0]!.token;
    assert.equal((await fetch(v1("/events/1/bookings"), { method: "POST", headers: { Authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(v1("/events/1/bookings"), { method: "POST", headers: { "X-Test-Anon": "1" } })).status, 401);
    assert.equal((await post(ctx.base, 999, t)).status, 404);
    for (const q of [0, -1, 11, 1.5, "2", null, 1e9]) {
      const r = await post(ctx.base, 1, t, { quantity: q });
      assert.equal(r.status, 422, `quantity ${JSON.stringify(q)}`);
    }
    assert.equal((await post(ctx.base, 1, t, [1])).status, 422);
    const bad = await fetch(v1("/events/1/bookings"), { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(bad.status, 400);
    assert.equal(await stock(1), 5);
    assert.equal((await rows(1)).n, 0);
  });

  test("buyer id comes from the session: a userId in the body is ignored; empty body means one seat", async () => {
    await resetEvents([{ id: 1, name: "Identity", seats: 5 }]);
    const r = await post(ctx.base, 1, buyers[1]!.token, { userId: buyers[2]!.id });
    assert.equal(r.status, 201);
    const owner = (await pool.query<{ user_id: number; quantity: number }>("SELECT user_id, quantity FROM bookings")).rows[0]!;
    assert.deepEqual(owner, { user_id: buyers[1]!.id, quantity: 1 });
    assert.equal((await post(ctx.base, 1, buyers[1]!.token)).status, 201); // no body at all
    assert.equal(await stock(1), 3);
  });

  test("the public event detail is not served stale after a booking", async () => {
    await resetEvents([{ id: 1, name: "Cache", seats: 5 }]);
    await fetch(v1("/events/1"));
    await post(ctx.base, 1, buyers[0]!.token, { quantity: 2 });
    const after = (await (await fetch(v1("/events/1"))).json()) as { seats: number };
    assert.equal(after.seats, 3);
  });

  test("the legacy stub POST /bookings is unchanged (501)", async () => {
    const r = await fetch(v1("/bookings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 501);
  });
});

// Two independent API processes + this one's pool... only the two child processes receive requests,
// so a process-local lock could not possibly protect the stock: PostgreSQL has to.
describe("two API processes sharing PostgreSQL", () => {
  const children: ChildProcess[] = [];
  const ports = [48231, 48232];
  const start = async (port: number) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: { PATH: process.env["PATH"] ?? "", ...process.env, PORT: String(port), LOG_REQUESTS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`API on ${port} did not start`);
  };
  before(async () => {
    await Promise.all(ports.map(start));
  });
  after(async () => {
    for (const c of children) c.kill("SIGTERM");
    await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : c.once("exit", r)))));
  });

  test("100 buyers split across two processes, 10 seats: exactly 10 bookings", async () => {
    await resetEvents([{ id: 1, name: "Two procs", seats: 10 }]);
    const buyers = await makeBuyers(100, "mp");
    const res = await Promise.all(buyers.map((b, i) => post(`http://127.0.0.1:${ports[i % 2]}`, 1, b.token)));
    const statuses = res.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 10);
    assert.equal(statuses.filter((s) => s === 409).length, 90, `unexpected statuses: ${[...new Set(statuses)]}`);
    assert.equal(await stock(1), 0);
    assert.deepEqual(await rows(1), { n: 10, q: 10 });
  });
});
