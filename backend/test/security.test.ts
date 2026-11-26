import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../src/server.ts";
import { FixedWindowLimiter } from "../src/auth.ts";
import { logSettings, logSink } from "../src/observability/logger.ts";
import { pool } from "../src/db/pool.ts";
import { dbEvents } from "./db.ts";
import { useServer, userToken } from "./helpers.ts";

// Lecture 20: regression tests for the hardening done in this lesson. The controls that earlier
// lessons already test (401, ownership, mass assignment, SQL-like input, JWT lab, CORS, redaction,
// generic 500) are listed with file:line in the evidence section of docs/lectures/20-backend-security.md.
// All data is synthetic.

const api = useServer({ asAdmin: false });
const v1 = (p: string) => `${api.base}/api/v1${p}`;
const J = { "Content-Type": "application/json" };
const PW = "correct horse battery";
let n = 0;
const uname = () => `sec_${process.pid}_${n++}`;
const post = (path: string, body: unknown, headers: Record<string, string> = J) =>
  fetch(v1(path), { method: "POST", headers, body: JSON.stringify(body) });

let now = Date.now();
beforeEach(() => {
  now = Date.now();
  auth.now = () => now;
  // Every test starts from empty limiter state: all requests come from 127.0.0.1.
  for (const l of [auth.limiter, auth.addressLimiter, auth.registerLimiter]) (l as unknown as { hits: Map<string, unknown> }).hits.clear();
});
afterEach(() => {
  auth.now = Date.now;
});
after(() => {
  auth.now = Date.now;
});

// ---------- the limiter itself ----------
test("limiter: exactly `max` events pass, the next is blocked with a positive Retry-After; the window then resets", () => {
  let t = 1_000;
  const l = new FixedWindowLimiter(() => t, 3, 60_000, 100);
  for (let i = 0; i < 3; i++) {
    assert.equal(l.retryAfter("k"), 0, `event ${i + 1} may proceed`);
    l.fail("k");
  }
  assert.equal(l.retryAfter("k"), 60); // boundary: the 4th is refused
  t += 59_999;
  assert.equal(l.retryAfter("k"), 1);
  t += 1; // window end: allowed again
  assert.equal(l.retryAfter("k"), 0);
});

test("limiter: keys are isolated (another key is untouched)", () => {
  const l = new FixedWindowLimiter(() => 0, 2, 60_000, 100);
  l.fail("a|alice");
  l.fail("a|alice");
  assert.ok(l.retryAfter("a|alice") > 0);
  assert.equal(l.retryAfter("a|bob"), 0);
  assert.equal(l.retryAfter("b|alice"), 0);
});

test("limiter: a flood of junk keys cannot wipe an existing lockout in one step; memory stays bounded", () => {
  const l = new FixedWindowLimiter(() => 0, 2, 60_000, 50);
  // 25 junk keys first, then the victim's lockout, then more junk than is needed to hit the cap once.
  for (let i = 0; i < 25; i++) l.fail(`old${i}`);
  l.fail("victim");
  l.fail("victim");
  assert.ok(l.retryAfter("victim") > 0);
  for (let i = 0; i < 40; i++) l.fail(`junk${i}`); // 25 + 1 + 40 = 66 > 50
  assert.ok(l.size <= 50, `bounded (size ${l.size})`);
  assert.ok(l.retryAfter("victim") > 0, "the lockout survived the overflow (the old behaviour cleared everything)");
});

test("limiter: expired entries are evicted before any live one", () => {
  let t = 0;
  const l = new FixedWindowLimiter(() => t, 2, 1_000, 3);
  l.fail("live-old");
  t = 5_000;
  l.fail("x");
  l.fail("y");
  l.fail("x"); // x count 2 (still live)
  l.fail("z"); // full: live-old is expired and goes; x and y stay
  assert.equal(l.size, 3);
  assert.ok(l.retryAfter("x") > 0);
});

// ---------- login: spraying many usernames from one address ----------
test("login: one address spraying many usernames is limited after 20 failures (even for a valid login)", async () => {
  const victim = uname();
  await post("/auth/register", { username: victim, password: PW });
  for (let i = 0; i < 20; i++) {
    assert.equal((await post("/auth/login", { username: `nobody_${i}`, password: "wrong wrong wrong" })).status, 401);
  }
  // The 21st attempt, a different username, is refused BEFORE any scrypt work.
  const sprayed = await post("/auth/login", { username: "nobody_x", password: "wrong wrong wrong" });
  assert.equal(sprayed.status, 429);
  assert.ok(Number(sprayed.headers.get("retry-after")) > 0);
  // The per-address limit is address-wide, so the real account is also refused from this address...
  assert.equal((await post("/auth/login", { username: victim, password: PW })).status, 429);
  // ...and only for the window.
  now += 61_000;
  assert.equal((await post("/auth/login", { username: victim, password: PW })).status, 200);
});

test("login: a successful login does not reset the per-address spray counter", async () => {
  const own = uname();
  await post("/auth/register", { username: own, password: PW }); // the attacker's own valid account
  for (let i = 0; i < 19; i++) await post("/auth/login", { username: `ghost_${i}`, password: "wrong wrong wrong" });
  assert.equal((await post("/auth/login", { username: own, password: PW })).status, 200); // would be a reset trick
  assert.equal((await post("/auth/login", { username: "ghost_a", password: "wrong wrong wrong" })).status, 401); // 20th failure
  assert.equal((await post("/auth/login", { username: "ghost_b", password: "wrong wrong wrong" })).status, 429);
});

// ---------- registration: bounded account creation ----------
test("register: 20 attempts per address per minute, then 429 + Retry-After, nothing created, window resets", async () => {
  const names: string[] = [];
  for (let i = 0; i < 20; i++) {
    names.push(uname());
    assert.equal((await post("/auth/register", { username: names[i], password: PW })).status, 201);
  }
  const blockedName = uname();
  const blocked = await post("/auth/register", { username: blockedName, password: PW });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE lower(username) = $1", [blockedName.toLowerCase()])).rowCount, 0, "a refused registration creates no user");
  now += 61_000;
  assert.equal((await post("/auth/register", { username: blockedName, password: PW })).status, 201);
});

test("register: invalid bodies do not consume the budget (they never reach scrypt)", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await post("/auth/register", { username: "x", password: "short" })).status, 422);
  assert.equal((await post("/auth/register", { username: uname(), password: PW })).status, 201);
});

// ---------- sessions ----------
test("expired sessions are swept when new ones are created, so the table cannot grow forever", async () => {
  const u = uname();
  await post("/auth/register", { username: u, password: PW });
  const userId = (await pool.query<{ id: number }>("SELECT id FROM users WHERE lower(username) = $1", [u.toLowerCase()])).rows[0]!.id;
  const count = async () => Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM sessions")).rows[0]!.n);
  for (let i = 0; i < 5; i++) await auth.createSession(userId);
  assert.ok((await count()) >= 5);
  now += 16 * 60_000; // past the 15 minute TTL; nobody presents the old tokens again
  await auth.createSession(userId);
  for (let i = 0; i < 50 && (await count()) !== 1; i++) await new Promise((r) => setTimeout(r, 20)); // the sweep runs in the background
  assert.equal(await count(), 1);
});

// ---------- response headers ----------
test("every kind of response carries nosniff and a locked-down CSP (200, 201, 204, 401, 404, 405, 422)", async () => {
  const admin = await userToken(api.base, "admin");
  const responses = [
    await fetch(v1("/events")), // 200
    await fetch(v1("/events/999999")), // 404
    await fetch(v1("/events"), { method: "DELETE" }), // 405
    await fetch(v1("/auth/me")), // 401
    await fetch(v1("/events"), { method: "OPTIONS" }), // 204
    await post("/events", { name: "" }, { ...J, Authorization: `Bearer ${admin.token}` }), // 422
    await post("/auth/logout", {}, { ...J, Authorization: `Bearer ${admin.token}` }), // 204
    await post("/events", { name: "Header check", seats: 1 }, { ...J, Authorization: `Bearer ${(await userToken(api.base, "admin")).token}` }), // 201
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 404, 405, 401, 204, 422, 204, 201]);
  for (const r of responses) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${r.status}`);
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'", `${r.status}`);
    await r.arrayBuffer();
  }
});

// ---------- secrets never reach the log ----------
test("logs: a login and an authenticated request never contain the password, the token or the Authorization header", async () => {
  const lines: string[] = [];
  const prev = logSink.write;
  const prevLevel = logSettings.level;
  logSink.write = (l) => lines.push(l);
  logSettings.level = "debug";
  try {
    const u = uname();
    const secretPw = "very-secret-password-123";
    await post("/auth/register", { username: u, password: secretPw });
    await post("/auth/login", { username: u, password: "wrong-secret-password-456" });
    const ok = (await (await post("/auth/login", { username: u, password: secretPw })).json()) as { token: string };
    await fetch(v1("/auth/me"), { headers: { Authorization: `Bearer ${ok.token}` } });
    assert.ok(lines.length > 0, "something was logged");
    const all = lines.join("\n");
    for (const secret of [secretPw, "wrong-secret-password-456", ok.token]) assert.ok(!all.includes(secret), "secret found in logs");
    assert.doesNotMatch(all, /Bearer /i);
  } finally {
    logSink.write = prev;
    logSettings.level = prevLevel;
  }
});

// ---------- no state change after a refused mutation (two organizers) ----------
test("a refused cross-owner mutation leaves the stored event byte-for-byte unchanged", async () => {
  const a = await userToken(api.base, "organizer");
  const b = await userToken(api.base, "organizer");
  const created = await post("/events", { name: "A's event", seats: 7 }, { ...J, Authorization: `Bearer ${a.token}` });
  const ev = (await created.json()) as { id: number };
  const snapshot = JSON.stringify((await dbEvents()).find((e) => e.id === ev.id));
  const h = { ...J, Authorization: `Bearer ${b.token}` };
  for (const [method, body] of [["PUT", { name: "hijack", seats: 1 }], ["PATCH", { seats: 1 }], ["DELETE", undefined]] as const) {
    const r = await fetch(v1(`/events/${ev.id}`), { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 403, method);
  }
  assert.equal(JSON.stringify((await dbEvents()).find((e) => e.id === ev.id)), snapshot);
});
