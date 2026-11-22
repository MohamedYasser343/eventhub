import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cache as realCache, parseTtlSeconds, RedisCache } from "../src/cache.ts";
import type { Cache } from "../src/cache.ts";
import { pool } from "../src/db/pool.ts";
import { EVENT_KEY_PREFIX, eventKey, PublicEventCache } from "../src/modules/events/public-cache.ts";
import type { EventItem, EventRepository } from "../src/modules/events/repository.ts";
import { TicketService } from "../src/modules/tickets/service.ts";
import { EventService } from "../src/modules/events/service.ts";
import { publicEventCache } from "../src/server.ts";
import { dbEvents, resetEvents } from "./db.ts";
import { useServer } from "./helpers.ts";

// ---------- fakes: isolate the service from Postgres and Redis ----------
class MapCache implements Cache {
  store = new Map<string, string>();
  failGet = false;
  failSet = false;
  failDel = false;
  async get(k: string) {
    if (this.failGet) throw new Error("down");
    return this.store.get(k) ?? null;
  }
  async set(k: string, v: string) {
    if (this.failSet) throw new Error("down");
    this.store.set(k, v);
  }
  async del(k: string) {
    if (this.failDel) throw new Error("down");
    this.store.delete(k);
  }
  async deletePrefix() {}
}

class CountingRepo implements EventRepository {
  reads = 0;
  failReplace = false;
  rows = new Map<number, EventItem>([[1, { id: 1, name: "A", seats: 10 }]]);
  gate: Promise<void> | undefined; // lets a test hold a read open
  async findById(id: number) {
    this.reads++;
    const row = this.rows.get(id);
    const snapshot = row && { ...row };
    if (this.gate) await this.gate;
    return snapshot;
  }
  async replace(id: number, f: { name: string; seats: number }) {
    if (this.failReplace) throw new Error("tx failed");
    if (!this.rows.has(id)) return undefined;
    const e = { id, ...f };
    this.rows.set(id, e);
    return e;
  }
  async remove(id: number) {
    return this.rows.delete(id);
  }
  async ownerOf() {
    return 1;
  }
  async findAll() {
    return [...this.rows.values()];
  }
  async query(): Promise<never> {
    throw new Error("unused");
  }
  async search(): Promise<never> {
    throw new Error("unused");
  }
  async insert(): Promise<never> {
    throw new Error("unused");
  }
}

const admin = { id: 1, role: "admin" as const };
function setup() {
  const backend = new MapCache();
  const repo = new CountingRepo();
  const pc = new PublicEventCache(backend, 60);
  return { backend, repo, pc, svc: new EventService(repo, pc) };
}

test("cache-aside: cold miss reads the source and fills; warm hit skips the source", async () => {
  const { repo, pc, svc, backend } = setup();
  assert.deepEqual(await svc.getPublic(1), { id: 1, name: "A", seats: 10 });
  assert.equal(repo.reads, 1);
  assert.ok(backend.store.has(eventKey(1)));
  assert.deepEqual(await svc.getPublic(1), { id: 1, name: "A", seats: 10 });
  assert.equal(repo.reads, 1, "a hit must not read the primary store");
  assert.deepEqual([pc.stats.hits, pc.stats.misses, pc.stats.sourceReads], [1, 1, 1]);
});

test("not-found is never cached (ids are serial: event 3 may exist a second later)", async () => {
  const { repo, svc, backend } = setup();
  assert.equal(await svc.getPublic(3), undefined);
  assert.equal(backend.store.size, 0);
  repo.rows.set(3, { id: 3, name: "New", seats: 1 });
  assert.equal((await svc.getPublic(3))?.name, "New");
});

test("authorization and other reads never use the cache", async () => {
  const { repo, svc } = setup();
  await svc.getPublic(1); // warms the cache
  const before = repo.reads;
  await svc.authorizeEdit(admin, 1);
  assert.equal(repo.reads, before + 1, "authorizeEdit reads the authoritative store");
  await svc.get(1);
  assert.equal(repo.reads, before + 2, "get() (used by tickets) is uncached");
});

test("replace/patch/remove invalidate after commit; a failed write does not", async () => {
  const { repo, svc, backend } = setup();
  await svc.getPublic(1);
  repo.failReplace = true;
  await assert.rejects(svc.replace(admin, 1, { name: "B", seats: 5 }));
  assert.ok(backend.store.has(eventKey(1)), "failed mutation must leave the cache alone");
  repo.failReplace = false;
  assert.equal((await svc.replace(admin, 1, { name: "B", seats: 5 })).ok, true);
  assert.equal(backend.store.has(eventKey(1)), false);
  assert.equal((await svc.getPublic(1))?.name, "B", "next read reflects the update");
  assert.equal((await svc.patch(admin, 1, { seats: 6 })).ok, true);
  assert.equal((await svc.getPublic(1))?.seats, 6);
  assert.equal((await svc.remove(admin, 1)).ok, true);
  assert.equal(await svc.getPublic(1), undefined, "deleted event must not stay visible");
});

test("a forbidden or invalid edit does not touch the cache", async () => {
  const { svc, backend } = setup();
  await svc.getPublic(1);
  const org = { id: 2, role: "organizer" as const }; // ownerOf() is 1
  assert.equal((await svc.replace(org, 1, { name: "X", seats: 1 })).ok, false);
  assert.equal((await svc.replace(admin, 1, { name: "", seats: 1 })).ok, false);
  assert.ok(backend.store.has(eventKey(1)));
});

test("DEL failing after commit: success is still returned, staleness is counted (bounded by TTL)", async () => {
  const { svc, pc, backend } = setup();
  await svc.getPublic(1);
  backend.failDel = true;
  assert.equal((await svc.replace(admin, 1, { name: "B", seats: 5 })).ok, true);
  assert.equal(pc.stats.invalidationErrors, 1);
  assert.equal((await svc.getPublic(1))?.name, "A", "documented: stale until the TTL expires");
});

test("cache down: reads fall back to the source, never to a fake not-found", async () => {
  const { svc, backend, pc } = setup();
  backend.failGet = true;
  backend.failSet = true;
  assert.equal((await svc.getPublic(1))?.name, "A");
  assert.equal((await svc.getPublic(404)), undefined); // a real not-found stays a not-found
  assert.ok(pc.stats.errors >= 2);
});

test("malformed, wrong-shape and wrong-id cached values count as misses and are replaced", async () => {
  const bad = ["{not json", "null", '"str"', '{"id":1,"name":"A"}', '{"id":2,"name":"A","seats":1}', '{"id":1,"name":"A","seats":1,"owner":9}', '{"id":1,"name":"A","seats":"1"}'];
  for (const raw of bad) {
    const { svc, repo, backend, pc } = setup();
    backend.store.set(eventKey(1), raw);
    assert.equal((await svc.getPublic(1))?.name, "A", raw);
    assert.equal(repo.reads, 1, raw);
    assert.equal(pc.stats.corrupt, 1, raw);
    assert.equal(backend.store.get(eventKey(1)), '{"id":1,"name":"A","seats":10}', "refilled with the good copy");
  }
});

test("stampede (characterization, not fixed): N parallel cold reads cause N source reads", async () => {
  const { svc, repo } = setup();
  await Promise.all(Array.from({ length: 20 }, () => svc.getPublic(1)));
  assert.equal(repo.reads, 20);
  await svc.getPublic(1);
  assert.equal(repo.reads, 20, "after the burst the key is warm");
});

test("race (characterization): a reader that started before an update can re-cache the OLD value", async () => {
  const { svc, repo, backend } = setup();
  let release!: () => void;
  repo.gate = new Promise<void>((r) => (release = r));
  const slowRead = svc.getPublic(1); // reads {A} from the source, then waits
  await new Promise((r) => setImmediate(r));
  repo.gate = undefined;
  await svc.replace(admin, 1, { name: "B", seats: 5 }); // commit + DEL (nothing to delete yet)
  release();
  assert.equal((await slowRead)?.name, "A");
  assert.equal(JSON.parse(backend.store.get(eventKey(1))!).name, "A", "stale copy cached after the invalidation");
  // Why it is accepted here: the window is one in-flight read and the TTL bounds it. Not a consistency guarantee.
});

test("last ticket: even with a stale cached copy, ticket logic reads the authoritative store", async () => {
  const { svc, repo } = setup();
  await svc.getPublic(1); // cache holds seats: 10
  repo.rows.set(1, { id: 1, name: "A", seats: 0 }); // sold out in the source of truth
  assert.equal((await svc.getPublic(1))?.seats, 10, "the public view may be stale (advisory)");
  const tickets = await new TicketService({ findByUser: () => [] }, svc).forEvent(1);
  assert.equal(tickets?.length, 0, "TicketService uses get(), never the cache");
});

test("TTL config: whole seconds 1..86400, default 60, anything else is a startup error", () => {
  assert.equal(parseTtlSeconds(undefined), 60);
  assert.equal(parseTtlSeconds("5"), 5);
  for (const bad of ["0", "-1", "1.5", "abc", "86401", "1e5"]) assert.throws(() => parseTtlSeconds(bad), /CACHE_TTL_SECONDS/, bad);
});

// ---------- HTTP + real Redis (skipped when TEST_REDIS_URL is not set) ----------
const redis = process.env.REDIS_URL ? { skip: false } : { skip: "TEST_REDIS_URL not set" };
const api = useServer();
after(() => pool.end().catch(() => {}));

test("HTTP + Redis: miss then hit, same body and ETag, 304 on a hit, TTL set", redis, async () => {
  await resetEvents();
  publicEventCache.resetStats();
  const a = await fetch(`${api.base}/events/1`);
  const b = await fetch(`${api.base}/events/1`);
  assert.equal(a.status, 200);
  const aBody = await a.json();
  assert.deepEqual(await b.json(), aBody);
  assert.equal(a.headers.get("etag"), b.headers.get("etag"));
  assert.deepEqual([publicEventCache.stats.hits, publicEventCache.stats.misses, publicEventCache.stats.sourceReads], [1, 1, 1]);
  const c = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": a.headers.get("etag")! } });
  assert.equal(c.status, 304);
  assert.equal(publicEventCache.stats.sourceReads, 1);
  assert.deepEqual((await dbEvents()).find((e) => e.id === 1), aBody);
});

test("HTTP + Redis: PUT, PATCH and DELETE are visible on the very next GET; 404 stays 404", redis, async () => {
  await resetEvents();
  await fetch(`${api.base}/events/1`); // warm
  const put = await fetch(`${api.base}/api/v1/events/1`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed", seats: 7 }) });
  assert.equal(put.status, 200);
  assert.equal(((await (await fetch(`${api.base}/events/1`)).json()) as EventItem).name, "Renamed");
  await fetch(`${api.base}/api/v1/events/1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seats: 9 }) });
  assert.equal(((await (await fetch(`${api.base}/events/1`)).json()) as EventItem).seats, 9);
  assert.equal((await fetch(`${api.base}/api/v1/events/1`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${api.base}/events/1`)).status, 404);
  assert.equal((await fetch(`${api.base}/events/999`)).status, 404);
  assert.equal(await realCache.get(eventKey(999)), null, "no negative caching");
});

test("HTTP + Redis: an entry expires after its TTL and is refreshed from the source", redis, async () => {
  await resetEvents();
  const short = new PublicEventCache(realCache, 1);
  const svc = new EventService({ findById: async (id: number) => (await dbEvents()).find((e) => e.id === id) } as EventRepository, short);
  await svc.getPublic(1);
  assert.ok(await realCache.get(eventKey(1)));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await realCache.get(eventKey(1)), null, "expired by TTL");
  await svc.getPublic(1);
  assert.equal(short.stats.sourceReads, 2);
});

test("RedisCache: unreachable server fails fast and boundedly, and never crashes the process", async () => {
  const dead = new RedisCache("redis://127.0.0.1:1", 100); // nothing listens on port 1
  const t0 = Date.now();
  await assert.rejects(dead.get("k"));
  assert.ok(Date.now() - t0 < 250, "bounded by the timeout, no queueing");
  const svc = new EventService(new CountingRepo(), new PublicEventCache(dead, 60));
  assert.equal((await svc.getPublic(1))?.name, "A");
  await dead.close();
});

test("keys: every key uses the versioned public namespace", () => {
  assert.equal(eventKey(42), `${EVENT_KEY_PREFIX}42`);
  assert.equal(eventKey(42), "event:public:v1:42");
});
