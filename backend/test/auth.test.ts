import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../src/server.ts";
import type { EventItem } from "../src/server.ts";
import { AuthService, ticketsByUser, verifyPassword } from "../src/auth.ts";
import { pool } from "../src/db/pool.ts";
import { PgUserRepository } from "../src/modules/auth/user-repository.ts";
import { dbEvents, dbOwnerOf, resetEvents, SEED } from "./db.ts";
import { useServer, userToken } from "./helpers.ts";

const api = useServer({ asAdmin: false });
const v1 = (p: string) => `${api.base}/api/v1${p}`;
const J = { "Content-Type": "application/json" };
const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
let n = 0;
const uname = () => `user_${process.pid}_${n++}`;
const PW = "correct horse battery";

let seed: EventItem[] = [];
before(() => { seed = structuredClone(SEED); });
beforeEach(async () => { await resetEvents(seed); });
after(() => { auth.now = Date.now; });

const post = (path: string, body: unknown, headers: Record<string, string> = J) =>
  fetch(v1(path), { method: "POST", headers, body: JSON.stringify(body) });
const mkEvent = (token: string) => post("/events", { name: "Owned", seats: 5 }, as(token, J));

// ---------- registration ----------
test("register: 201, no password or hash in response, role from body ignored", async () => {
  const username = uname();
  const res = await post("/auth/register", { username, password: PW, role: "admin", id: 999 });
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["id", "role", "username"]);
  assert.equal(JSON.parse(text).role, "attendee");
  assert.ok(!text.includes(PW) && !text.includes("scrypt"));
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("same password, two users: distinct salted hashes, both verify", async () => {
  const a = uname(), b = uname();
  await post("/auth/register", { username: a, password: PW });
  await post("/auth/register", { username: b, password: PW });
  const find = async (name: string) => {
    for (let id = 1; id < 1000; id++) { const u = await auth.userById(id); if (u?.username === name) return u; }
    throw new Error("missing");
  };
  const ua = await find(a), ub = await find(b);
  assert.notEqual(ua.passwordHash, ub.passwordHash);
  assert.match(ua.passwordHash, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword(PW, ua.passwordHash), true);
  assert.equal(await verifyPassword("wrong password!!", ua.passwordHash), false);
});

test("register: duplicate 409 (case-insensitive), weak input 422, bad body 415/400", async () => {
  const username = uname();
  assert.equal((await post("/auth/register", { username, password: PW })).status, 201);
  assert.equal((await post("/auth/register", { username: username.toUpperCase(), password: PW })).status, 409);
  assert.equal((await post("/auth/register", { username: uname(), password: "short" })).status, 422);
  assert.equal((await post("/auth/register", { username: "a b", password: PW })).status, 422);
  assert.equal((await post("/auth/register", { username: uname(), password: "x".repeat(129) })).status, 422);
  assert.equal((await post("/auth/register", null)).status, 422);
  assert.equal((await post("/auth/register", { username: uname(), password: PW }, { "Content-Type": "text/plain" })).status, 415);
});

// ---------- login ----------
test("login: valid credentials give a Bearer token; wrong password and unknown user look identical", async () => {
  const username = uname();
  await post("/auth/register", { username, password: PW });
  const ok = await post("/auth/login", { username, password: PW });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { token: string; tokenType: string; user: { role: string } };
  assert.equal(body.tokenType, "Bearer");
  assert.ok(body.token.length >= 43);
  const bad = await post("/auth/login", { username, password: "wrong wrong wrong" });
  const unknown = await post("/auth/login", { username: uname(), password: "wrong wrong wrong" });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(await bad.text(), await unknown.text());
});

test("login: two logins give different session ids (never client-chosen)", async () => {
  const username = uname();
  await post("/auth/register", { username, password: PW });
  const a = (await (await post("/auth/login", { username, password: PW })).json()) as { token: string };
  const b = (await (await post("/auth/login", { username, password: PW })).json()) as { token: string };
  assert.notEqual(a.token, b.token);
});

test("login rate limit: 5 failures then 429 with Retry-After, even for the right password; window resets", async () => {
  const username = uname();
  await post("/auth/register", { username, password: PW });
  let now = Date.now();
  auth.now = () => now;
  for (let i = 0; i < 5; i++) assert.equal((await post("/auth/login", { username, password: "nope nope nope" })).status, 401);
  const blocked = await post("/auth/login", { username, password: PW });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  now += 61_000;
  assert.equal((await post("/auth/login", { username, password: PW })).status, 200);
  auth.now = Date.now;
});

// ---------- credentials on protected routes ----------
test("missing, malformed, tampered and unknown tokens are 401 with a challenge; no mutation", async () => {
  const { token } = await userToken(api.base, "admin");
  const body = JSON.stringify({ name: "X", seats: 1 });
  const cases: [string, Record<string, string>][] = [
    ["none", J],
    ["wrong scheme", { ...J, Authorization: `Basic ${token}` }],
    ["malformed", { ...J, Authorization: "Bearer a b c" }],
    ["tampered", as(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), J)],
    ["unknown", as("A".repeat(43), J)],
  ];
  for (const [name, headers] of cases) {
    const res = await fetch(v1("/events"), { method: "POST", headers, body });
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/, name);
  }
  assert.equal((await fetch(v1("/auth/me"))).status, 401);
  assert.equal((await dbEvents()).length, seed.length);
});

test("expired session is 401 (controlled clock) and is removed", async () => {
  const clock = Date.now(); // frozen clock: the session is issued exactly at `clock`
  auth.now = () => clock;
  const { token } = await userToken(api.base, "attendee");
  assert.equal((await fetch(v1("/auth/me"), { headers: as(token) })).status, 200);
  const real = clock;
  auth.now = () => real + auth.sessionTtlMs - 1;
  assert.equal((await fetch(v1("/auth/me"), { headers: as(token) })).status, 200); // just before expiry
  auth.now = () => real + auth.sessionTtlMs + 1;
  assert.equal((await fetch(v1("/auth/me"), { headers: as(token) })).status, 401);
  auth.now = Date.now;
  assert.equal((await fetch(v1("/auth/me"), { headers: as(token) })).status, 401); // gone for good
});

test("logout revokes server-side; replaying the old token is 401; other sessions survive", async () => {
  const u = await userToken(api.base, "attendee");
  const second = (await (await post("/auth/login", { username: u.username, password: u.password })).json()) as { token: string };
  assert.equal((await fetch(v1("/auth/me"), { headers: as(u.token) })).status, 200);
  assert.equal((await fetch(v1("/auth/logout"), { method: "POST", headers: as(u.token) })).status, 204);
  assert.equal((await fetch(v1("/auth/me"), { headers: as(u.token) })).status, 401);
  assert.equal((await fetch(v1("/auth/logout"), { method: "POST", headers: as(u.token) })).status, 401);
  assert.equal((await fetch(v1("/auth/me"), { headers: as(second.token) })).status, 200);
});

test("sessions live in one instance's memory: a new instance (restart) or another instance rejects them", async () => {
  const a = new AuthService(new PgUserRepository(pool));
  const created = await a.createUser(uname(), PW);
  assert.ok(created.ok);
  const { token } = a.createSession(created.user.id);
  assert.ok(await a.authenticate(token));
  assert.equal(await new AuthService(new PgUserRepository(pool)).authenticate(token), null);
});

// ---------- authorization ----------
test("attendee cannot create/replace/patch/delete events (403, no change)", async () => {
  const { token } = await userToken(api.base, "attendee");
  assert.equal((await mkEvent(token)).status, 403);
  const h = as(token, J);
  const b = JSON.stringify({ name: "Hacked", seats: 1 });
  assert.equal((await fetch(v1("/events/1"), { method: "PUT", headers: h, body: b })).status, 403);
  assert.equal((await fetch(v1("/events/1"), { method: "PATCH", headers: h, body: b })).status, 403);
  assert.equal((await fetch(v1("/events/1"), { method: "DELETE", headers: as(token) })).status, 403);
  assert.deepEqual(await dbEvents(), seed);
});

test("organizer owns what they create; another organizer is 403; admin can edit; DELETE is admin-only", async () => {
  const o1 = await userToken(api.base, "organizer");
  const o2 = await userToken(api.base, "organizer");
  const admin = await userToken(api.base, "admin");
  const created = await mkEvent(o1.token);
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as EventItem;
  assert.equal(await dbOwnerOf(id), o1.id);

  const patch = (t: string) => fetch(v1(`/events/${id}`), { method: "PATCH", headers: as(t, J), body: '{"seats":9}' });
  assert.equal((await patch(o1.token)).status, 200);
  assert.equal((await patch(o2.token)).status, 403);
  assert.equal((await patch(admin.token)).status, 200);
  const put = (t: string) => fetch(v1(`/events/${id}`), { method: "PUT", headers: as(t, J), body: '{"name":"P","seats":2}' });
  assert.equal((await put(o2.token)).status, 403);
  assert.equal((await put(o1.token)).status, 200);

  assert.equal((await fetch(v1(`/events/${id}`), { method: "DELETE", headers: as(o1.token) })).status, 403);
  assert.equal((await fetch(v1(`/events/${id}`), { method: "DELETE", headers: as(admin.token) })).status, 204);
});

test("client-supplied owner/role fields cannot override server-side ownership", async () => {
  const o1 = await userToken(api.base, "organizer");
  const o2 = await userToken(api.base, "organizer");
  const res = await post("/events", { name: "Mine", seats: 1, ownerId: o2.id, role: "admin" }, as(o1.token, J));
  const { id } = (await res.json()) as EventItem;
  assert.equal(await dbOwnerOf(id), o1.id);
});

test("legacy unversioned mutations are protected too (no bypass); reads stay public", async () => {
  assert.equal((await fetch(`${api.base}/events`, { method: "POST", headers: J, body: '{"name":"X","seats":1}' })).status, 401);
  assert.equal((await fetch(`${api.base}/events/1`, { method: "DELETE" })).status, 401);
  assert.equal((await fetch(`${api.base}/events`)).status, 200);
  assert.equal((await fetch(v1("/events/1"))).status, 200);
});

test("role changes apply immediately: a demoted organizer is refused on the next request", async () => {
  const o = await userToken(api.base, "organizer");
  assert.equal((await mkEvent(o.token)).status, 201);
  await auth.setRole(o.id, "attendee");
  assert.equal((await mkEvent(o.token)).status, 403); // same token, current role read from the store
});

test("OPTIONS preflight needs no credentials and allows the Authorization header", async () => {
  const res = await fetch(v1("/events"), {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
});

// ---------- private resources ----------
test("tickets: only the caller's own; changing the id or a userId parameter reveals nothing", async () => {
  const a = await userToken(api.base, "attendee");
  const b = await userToken(api.base, "attendee");
  ticketsByUser.set(a.id, [{ ticketId: `T-A-${a.id}`, eventId: 1 }]);
  ticketsByUser.set(b.id, [{ ticketId: `T-B-${b.id}`, eventId: 1 }]);

  assert.equal((await fetch(v1("/me/tickets"))).status, 401);
  const mine = (await (await fetch(v1(`/me/tickets?userId=${b.id}`), { headers: as(a.token) })).json()) as { data: { ticketId: string }[] };
  assert.deepEqual(mine.data.map((t) => t.ticketId), [`T-A-${a.id}`]);
  assert.equal((await fetch(v1(`/tickets/T-A-${a.id}`), { headers: as(a.token) })).status, 200);
  const other = await fetch(v1(`/tickets/T-B-${b.id}`), { headers: as(a.token) });
  const missing = await fetch(v1("/tickets/T-NOPE"), { headers: as(a.token) });
  assert.equal(other.status, 404); // concealment: same answer as a missing ticket
  assert.equal(await other.text(), await missing.text());
});
