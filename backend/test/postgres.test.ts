import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import pg from "pg";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { useServer, userToken } from "./helpers.ts";
import { dbEvents, resetEvents, SEED } from "./db.ts";
import { book, bookNaive, LAB_DDL } from "./lab/booking-lab.ts";

// Lecture 12: persistence, constraints, parameter binding, migrations, transactions.
const api = useServer();
const v1 = (p: string) => `${api.base}/api/v1${p}`;
const JSON_H = { "Content-Type": "application/json" };

const sqlState = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no-error";
};

// ---------- constraints: the database is the second correctness boundary ----------
test("constraints reject invalid rows even when the HTTP layer is bypassed", async () => {
  await resetEvents();
  const owner = (await pool.query<{ id: number }>("SELECT id FROM users WHERE username = 'seed_owner'")).rows[0]!.id;
  const ins = (o: number, name: string, seats: number) =>
    pool.query("INSERT INTO events (owner_id, name, seats) VALUES ($1, $2, $3)", [o, name, seats]);
  assert.equal(await sqlState(ins(owner, "ok", -1)), "23514", "negative seats: CHECK");
  assert.equal(await sqlState(ins(owner, "ok", 100_001)), "23514", "too many seats: CHECK");
  assert.equal(await sqlState(ins(owner, "   ", 1)), "23514", "blank name: CHECK");
  assert.equal(await sqlState(ins(owner, "x".repeat(101), 1)), "23514", "long name: CHECK");
  assert.equal(await sqlState(ins(owner, null as unknown as string, 1)), "23502", "missing name: NOT NULL");
  assert.equal(await sqlState(ins(999_999, "ok", 1)), "23503", "unknown owner: FOREIGN KEY");
  assert.equal(await sqlState(pool.query("DELETE FROM users WHERE id = $1", [owner])), "23503", "owner with events: RESTRICT");
  assert.equal(await sqlState(pool.query("INSERT INTO users (username, role, password_hash) VALUES ('ab', 'attendee', 'h')")), "23514", "short username");
  assert.equal(await sqlState(pool.query("INSERT INTO users (username, role, password_hash) VALUES ('good_name', 'root', 'h')")), "23514", "unknown role");
  assert.deepEqual(await dbEvents(), SEED, "no rejected statement left a row behind");
});

test("duplicate username (case-insensitive) is a 409 over HTTP, a unique violation in SQL", async () => {
  const body = JSON.stringify({ username: "Dup_User_1", password: "correct horse battery" });
  assert.equal((await fetch(v1("/auth/register"), { method: "POST", headers: JSON_H, body })).status, 201);
  const again = await fetch(v1("/auth/register"), { method: "POST", headers: JSON_H, body: body.replace("Dup_User", "DUP_USER") });
  assert.equal(again.status, 409);
  assert.equal((await again.text()).includes("duplicate key"), false, "no raw SQL error text reaches the client");
  assert.equal(await sqlState(pool.query("INSERT INTO users (username, role, password_hash) VALUES ('dup_user_1', 'attendee', 'h')")), "23505");
});

test("concurrent registrations of one username: the database lets exactly one win", async () => {
  const mk = () => fetch(v1("/auth/register"), { method: "POST", headers: JSON_H, body: JSON.stringify({ username: "race_user_1", password: "correct horse battery" }) });
  const statuses = (await Promise.all(Array.from({ length: 6 }, mk))).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
});

test("updated_at trigger fires for every writer, including raw SQL", async () => {
  await resetEvents();
  const t0 = (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM events WHERE id = 1")).rows[0]!.updated_at;
  await new Promise((r) => setTimeout(r, 15));
  await pool.query("UPDATE events SET seats = seats WHERE id = 1");
  const t1 = (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM events WHERE id = 1")).rows[0]!.updated_at;
  assert.ok(t1 > t0);
});

// ---------- parameter binding ----------
test("SQL-looking input is data: it matches literally and nothing is dropped", async () => {
  await resetEvents();
  const org = await userToken(api.base, "organizer");
  const evil = "x'); DROP TABLE events; --";
  const created = await fetch(v1("/events"), { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${org.token}` }, body: JSON.stringify({ name: evil, seats: 3 }) });
  assert.equal(created.status, 201);
  const found = (await (await fetch(v1(`/events?q=${encodeURIComponent("DROP TABLE")}`))).json()) as { data: { name: string }[]; meta: { total: number } };
  assert.deepEqual(found.data.map((e) => e.name), [evil]);
  assert.equal((await dbEvents()).length, SEED.length + 1, "table still exists with all rows");
  // LIKE wildcards are literal, not patterns.
  for (const q of ["%", "_", "' OR 1=1 --"]) {
    const r = (await (await fetch(v1(`/events?q=${encodeURIComponent(q)}`))).json()) as { meta: { total: number } };
    assert.equal(r.meta.total, 0, `q=${q}`);
  }
  // The sort column is an allowlist, never interpolated from the request.
  assert.equal((await fetch(v1(`/events?sort=${encodeURIComponent("name; DROP TABLE events")}`))).status, 400);
  assert.equal((await fetch(v1(`/events?sort=${encodeURIComponent("-seats,(select 1)")}`))).status, 400);
  assert.equal((await fetch(v1(`/events?minSeats=${encodeURIComponent("0 OR 1=1")}`))).status, 400);
});

test("collection order is deterministic: ties on seats are broken by id, name sort is byte-wise", async () => {
  await resetEvents([{ id: 1, name: "b", seats: 5 }, { id: 2, name: "B", seats: 5 }, { id: 3, name: "a", seats: 5 }]);
  const get = async (q: string) => ((await (await fetch(v1(`/events?${q}`))).json()) as { data: { id: number }[] }).data.map((e) => e.id);
  assert.deepEqual(await get("sort=seats"), [1, 2, 3]);
  assert.deepEqual(await get("sort=-seats"), [1, 2, 3]);
  assert.deepEqual(await get("sort=name"), [2, 3, 1]); // "B" < "a" < "b" under the C collation
  await resetEvents();
});

// ---------- migrations ----------
test("migrations rebuild the schema in an empty database and re-running applies nothing", async () => {
  const name = "eventhub_migrate_test";
  const admin = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env["DATABASE_URL"]!);
  url.pathname = `/${name}`;
  const fresh = new pg.Pool({ connectionString: url.toString(), max: 2 });
  try {
    assert.deepEqual(await migrate(fresh), ["001_users_events.sql", "002_notification_lab.sql", "003_event_name_fts.sql"]);
    assert.deepEqual(await migrate(fresh), [], "second run is a no-op");
    const tables = (await fresh.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.t);
    assert.deepEqual(tables, ["events", "mock_provider_sent", "notification_deliveries", "schema_migrations", "users"]);
    // concurrent runners serialize on the advisory lock
    await fresh.query("DROP TABLE events, users, notification_deliveries, mock_provider_sent, schema_migrations; DROP FUNCTION set_updated_at()");
    const runs = await Promise.all([migrate(fresh), migrate(fresh)]);
    assert.equal(runs.flat().length, 3, "exactly one runner applied each file (3 files, no double application)");
    await fresh.query("UPDATE schema_migrations SET checksum = 'tampered'");
    await assert.rejects(migrate(fresh), /modified after being applied/);
  } finally {
    await fresh.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});

// ---------- transactions (isolated lab, no route) ----------
test.describe("inventory lab", () => {
  let userIds: number[] = [];
  before(async () => {
    await pool.query(LAB_DDL);
    userIds = [];
    for (let i = 0; i < 30; i++) {
      userIds.push((await pool.query<{ id: number }>("INSERT INTO users (username, role, password_hash) VALUES ($1, 'attendee', 'x') RETURNING id", [`lab_user_${i}`])).rows[0]!.id);
    }
  });
  after(async () => {
    await pool.query("DROP TABLE IF EXISTS lab_bookings");
  });
  const stock = async (id: number) => (await pool.query<{ seats: number }>("SELECT seats FROM events WHERE id = $1", [id])).rows[0]!.seats;
  const rows = async (id: number) => (await pool.query<{ n: number }>("SELECT count(*) AS n FROM lab_bookings WHERE event_id = $1", [id])).rows[0]!.n;

  test("two buyers, one last seat: at most one allocation; check the data, not the statuses", async () => {
    await resetEvents([{ id: 1, name: "Last seat", seats: 1 }]);
    await pool.query("TRUNCATE lab_bookings");
    const results = await Promise.all([book(pool, 1, userIds[0]!), book(pool, 1, userIds[1]!)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).length, 1);
    assert.equal(await stock(1), 0);
    assert.equal(await rows(1), 1);
  });

  test("30 contenders for 7 seats: exactly 7 bookings, stock 0, never negative", async () => {
    await resetEvents([{ id: 1, name: "Seven", seats: 7 }]);
    await pool.query("TRUNCATE lab_bookings");
    const results = await Promise.all(userIds.map((u) => book(pool, 1, u)));
    assert.equal(results.filter((r) => r.ok).length, 7);
    assert.equal(await stock(1), 0);
    assert.equal(await rows(1), 7);
  });

  test("zero stock and unknown event: sold out, nothing written", async () => {
    await resetEvents([{ id: 1, name: "Empty", seats: 0 }]);
    await pool.query("TRUNCATE lab_bookings");
    assert.deepEqual(await book(pool, 1, userIds[0]!), { ok: false, reason: "sold-out" });
    assert.deepEqual(await book(pool, 999, userIds[0]!), { ok: false, reason: "sold-out" });
    assert.equal(await rows(1), 0);
  });

  test("INSERT fails after the decrement: ROLLBACK restores stock; every statement used one connection", async () => {
    await resetEvents([{ id: 1, name: "Rollback", seats: 5 }]);
    await pool.query("TRUNCATE lab_bookings");
    // user 999999 does not exist: the foreign key makes the INSERT fail AFTER the UPDATE succeeded
    await assert.rejects(book(pool, 1, 999_999), (e: { code?: string }) => e.code === "23503");
    assert.equal(await stock(1), 5, "decrement undone");
    assert.equal(await rows(1), 0);
    const ok = await book(pool, 1, userIds[0]!);
    assert.ok(ok.ok && ok.pids.length === 3 && new Set(ok.pids).size === 1, "BEGIN, UPDATE, INSERT, COMMIT ran on the same backend process");
    assert.equal(await stock(1), 4);
  });

  test("a failed transaction releases its connection (no pool leak)", async () => {
    await resetEvents([{ id: 1, name: "Leak", seats: 5 }]);
    for (let i = 0; i < 25; i++) await assert.rejects(book(pool, 1, 999_999)); // pool max is 10
    assert.equal(pool.idleCount, pool.totalCount, "all connections returned");
    assert.equal(await stock(1), 5);
  });

  test("NEGATIVE CONTROL: read-then-write loses updates (the race the atomic UPDATE avoids)", async () => {
    await resetEvents([{ id: 1, name: "Naive", seats: 10 }]);
    await pool.query("TRUNCATE lab_bookings");
    const ok = await Promise.all(userIds.slice(0, 8).map((u) => bookNaive(pool, 1, u)));
    const sold = ok.filter(Boolean).length;
    const left = await stock(1);
    assert.equal(sold, 8);
    assert.ok(left > 10 - sold, `lost update expected: sold ${sold} but stock is ${left} (should be ${10 - sold})`);
  });

  test("pool exhaustion fails fast instead of hanging", async () => {
    const tiny = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 1, connectionTimeoutMillis: 150 });
    const held = await tiny.connect();
    try {
      await assert.rejects(tiny.query("SELECT 1"), /timeout/i);
    } finally {
      held.release();
      await tiny.end();
    }
  });
});

// ---------- persistence: restart the backend PROCESS, same database ----------
test("data written before an app restart is readable after it (users included; sessions are not)", async () => {
  await resetEvents();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const start = () =>
    new Promise<{ stop: () => Promise<void>; out: string[] }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        env: { ...process.env, PORT: String(port), SEED_DEMO_USERS: "1" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const out: string[] = [];
      child.stdout.on("data", (d: Buffer) => {
        out.push(...d.toString().split("\n").filter(Boolean));
        if (out.some((l) => l.includes("listening"))) resolve({ out, stop: () => new Promise((r) => { child.once("exit", () => r()); child.kill("SIGTERM"); }) });
      });
      child.on("error", reject);
    });
  const login = async (password: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: "POST", headers: { ...JSON_H, "X-Test-Anon": "1" }, body: JSON.stringify({ username: "demo_organizer", password }) });
    return { status: r.status, token: ((await r.json()) as { token?: string }).token };
  };
  // Process A: creates demo users (random password printed), writes an event.
  const a = await start();
  const password = /demo_organizer with password (\S+)/.exec(a.out.join("\n"))?.[1];
  assert.ok(password, "first start created the demo organizer");
  const ta = await login(password);
  assert.equal(ta.status, 200);
  const created = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${ta.token}`, "X-Test-Anon": "1" }, body: JSON.stringify({ name: "Survives restart", seats: 4 }) });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: number };
  await a.stop();
  // Process B: a NEW process, nothing shared but the database.
  const b = await start();
  try {
    assert.match(b.out.join("\n"), /demo_organizer already exists/, "user survived: seed did not recreate it");
    const read = await fetch(`http://127.0.0.1:${port}/api/v1/events/${id}`);
    assert.deepEqual(await read.json(), { id, name: "Survives restart", seats: 4 });
    const stale = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${ta.token}`, "X-Test-Anon": "1" } });
    assert.equal(stale.status, 401, "sessions are in memory and do not survive (documented)");
    assert.equal((await login(password)).status, 200, "the persisted user can log in again with the same password");
  } finally {
    await b.stop();
  }
});

test("database outage becomes a safe 503 (lecture 16; was 500) without driver details", async () => {
  const real = pool.query.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].includes("FROM events")) return Promise.reject(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), { code: "ECONNREFUSED" }));
    return real(...a);
  };
  try {
    const r = await fetch(v1("/events/1"));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: "Service Unavailable", requestId: r.headers.get("x-request-id") });
    assert.equal(/hunter2|ECONNREFUSED/.test(text), false);
  } finally {
    (pool as unknown as { query: unknown }).query = real;
  }
});
