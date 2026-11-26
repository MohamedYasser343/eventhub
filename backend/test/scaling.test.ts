// Lecture 22: state that must be shared between API replicas, and a client address that survives a proxy.
// Two AuthService objects over the SAME database stand in for two API processes (the real two-process
// proof is the compose experiment in the lecture evidence). All data is synthetic.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { AuthService, InMemorySessionStore } from "../src/auth.ts";
import { pool } from "../src/db/pool.ts";
import { PgUserRepository } from "../src/modules/auth/user-repository.ts";
import { PgSessionStore } from "../src/modules/auth/session-store.ts";
import { clientAddress } from "../src/http/context.ts";
import { parseDatabaseConfig, parseServerConfig, ConfigError } from "../src/config.ts";
import { resetAll } from "./db.ts";

const replica = () => new AuthService(new PgUserRepository(pool), new PgSessionStore(pool));
const PW = "synthetic-password-12345";

before(async () => void (await resetAll()));
after(async () => void (await pool.end()));

test("a login created on replica A authenticates on replica B; logout on B revokes it on A", async () => {
  const a = replica();
  const b = replica();
  const u = await a.createUser("shared_user", PW, "organizer");
  assert.ok(u.ok);
  const { token } = await a.createSession(u.user.id);
  assert.equal((await b.authenticate(token))?.username, "shared_user");
  await b.destroySession(token);
  assert.equal(await a.authenticate(token), null, "revocation is visible to every replica at once");
});

test("the baseline problem stays demonstrable: per-process memory sessions are invisible to another instance", async () => {
  const a = new AuthService(new PgUserRepository(pool), new InMemorySessionStore());
  const b = new AuthService(new PgUserRepository(pool), new InMemorySessionStore());
  const u = await a.createUser("local_user", PW);
  assert.ok(u.ok);
  const { token } = await a.createSession(u.user.id);
  assert.ok(await a.authenticate(token));
  assert.equal(await b.authenticate(token), null);
});

test("expiry holds across replicas and expired rows are removed; only a hash is stored", async () => {
  const a = replica();
  const b = replica();
  let now = Date.now();
  a.now = () => now;
  b.now = () => now;
  const u = await a.createUser("expiring_user", PW);
  assert.ok(u.ok);
  const { token } = await a.createSession(u.user.id);
  assert.ok(await b.authenticate(token));
  now += 16 * 60_000;
  assert.equal(await b.authenticate(token), null);
  const rows = await pool.query("SELECT token_hash FROM sessions WHERE token_hash = $1 OR token_hash = $2", [token, "x"]);
  assert.equal(rows.rowCount, 0, "the raw token is never a key");
  assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id = $1", [u.user.id])).rowCount, 0, "expired row deleted on use");
});

test("deleting a user ends their sessions (ON DELETE CASCADE)", async () => {
  const a = replica();
  const u = await a.createUser("cascade_user", PW);
  assert.ok(u.ok);
  const { token } = await a.createSession(u.user.id);
  await pool.query("DELETE FROM users WHERE id = $1", [u.user.id]);
  assert.equal(await a.authenticate(token), null);
});

// ---------- client address behind a proxy ----------
const fake = (peer: string, xff?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;
const PROXY = new Set(["10.0.0.5"]);

test("clientAddress: header ignored unless the socket peer is a trusted proxy (spoofing negative case)", () => {
  assert.equal(clientAddress(fake("203.0.113.9", "1.2.3.4"), PROXY), "203.0.113.9", "direct client cannot choose its own address");
  assert.equal(clientAddress(fake("203.0.113.9", "1.2.3.4"), new Set()), "203.0.113.9", "no proxies configured: never trust");
  assert.equal(clientAddress(fake("10.0.0.5", "198.51.100.7"), PROXY), "198.51.100.7");
});

test("clientAddress: rightmost untrusted hop wins; a client-prepended entry is ignored; garbage falls back to the peer", () => {
  assert.equal(clientAddress(fake("10.0.0.5", "6.6.6.6, 198.51.100.7"), PROXY), "198.51.100.7", "the proxy appended the real client last");
  assert.equal(clientAddress(fake("10.0.0.5", "198.51.100.7, 10.0.0.5"), PROXY), "198.51.100.7");
  assert.equal(clientAddress(fake("10.0.0.5", "not-an-ip"), PROXY), "10.0.0.5");
  assert.equal(clientAddress(fake("10.0.0.5"), PROXY), "10.0.0.5");
  assert.equal(clientAddress(fake("::ffff:10.0.0.5", ["198.51.100.7"]), PROXY), "198.51.100.7", "IPv4-mapped peer is normalised");
});

test("config: TRUSTED_PROXIES and DB_POOL_MAX are validated and default safe", () => {
  assert.deepEqual(parseServerConfig({}).trustedProxies, []);
  assert.deepEqual(parseServerConfig({ TRUSTED_PROXIES: "127.0.0.1, ::1" }).trustedProxies, ["127.0.0.1", "::1"]);
  for (const bad of ["", "localhost", "10.0.0.0/8", "1.1.1.1,,2.2.2.2"]) assert.throws(() => parseServerConfig({ TRUSTED_PROXIES: bad }), ConfigError, bad);
  const db = { DATABASE_URL: "postgres://u:p@h/d" };
  assert.equal(parseDatabaseConfig(db).poolMax, 10);
  assert.equal(parseDatabaseConfig({ ...db, DB_POOL_MAX: "25" }).poolMax, 25);
  for (const bad of ["0", "101", "x", ""]) assert.throws(() => parseDatabaseConfig({ ...db, DB_POOL_MAX: bad }), ConfigError, bad);
});
