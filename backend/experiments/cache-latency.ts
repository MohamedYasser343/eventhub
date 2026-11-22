// Lecture 13 experiment: cold (miss) vs warm (hit) GET /events/1, then a Redis outage.
// DESTRUCTIVE to the database it points at (it resets events), so it refuses anything
// whose name does not end in _test. Run: npm run experiment:cache
// Needs the eventhub-pg and eventhub-redis containers (npm run db:up). It stops and
// restarts ONLY the container named eventhub-redis for the outage phase.
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

const dbName = new URL(process.env.TEST_DATABASE_URL ?? "x:///").pathname.slice(1);
if (!dbName.endsWith("_test")) throw new Error("TEST_DATABASE_URL (…_test) required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
if (!process.env.REDIS_URL) throw new Error("TEST_REDIS_URL required");

const { server, publicEventCache } = await import("../src/server.ts");
const { cache } = await import("../src/cache.ts");
const { pool } = await import("../src/db/pool.ts");
const { resetAll, resetEvents } = await import("./../test/db.ts");
const { eventKey } = await import("../src/modules/events/public-cache.ts");

await resetAll();
await resetEvents();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ms = async (): Promise<number> => {
  const t = process.hrtime.bigint();
  const res = await fetch(`${base}/events/1`);
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(2)} ms  p95 ${pct(xs, 95).toFixed(2)} ms  (n=${xs.length})`;

console.log(`node ${process.version}, ${process.platform}, redis ${process.env.REDIS_URL!.replace(/\/\/.*@/, "//")}, 1 synthetic row`);
await ms();
for (let round = 1; round <= 5; round++) {
  const cold: number[] = [], warm: number[] = [];
  publicEventCache.resetStats();
  for (let i = 0; i < 200; i++) {
    await cache.del(eventKey(1)); // force a miss
    cold.push(await ms());
    warm.push(await ms()); // immediately after the fill: a hit
  }
  const s = publicEventCache.stats;
  console.log(`round ${round}: cold ${fmt(cold)} | warm ${fmt(warm)} | hits ${s.hits} misses ${s.misses} sourceReads ${s.sourceReads}`);
}

// ---- outage ----
await ms(); // warm
execFileSync("docker", ["stop", "eventhub-redis"], { stdio: "ignore" });
publicEventCache.resetStats();
const down: number[] = [];
for (let i = 0; i < 100; i++) down.push(await ms());
console.log(`redis STOPPED: all 100 GETs returned 200 from Postgres | ${fmt(down)} | max ${Math.max(...down).toFixed(1)} ms | errors ${publicEventCache.stats.errors} sourceReads ${publicEventCache.stats.sourceReads}`);
execFileSync("docker", ["start", "eventhub-redis"], { stdio: "ignore" });
const t0 = Date.now();
for (;;) {
  publicEventCache.resetStats();
  await ms();
  await ms();
  if (publicEventCache.stats.hits >= 1) break;
  if (Date.now() - t0 > 15_000) throw new Error("did not recover in 15 s");
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`redis RESTARTED: first cache hit again after ${Date.now() - t0} ms (client reconnected by itself)`);

server.close();
await pool.end();
process.exit(0);
