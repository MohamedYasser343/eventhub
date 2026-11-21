// Lecture 12 experiment: EXPLAIN (ANALYZE, BUFFERS) of the collection queries on
// SYNTHETIC rows, before and after candidate indexes. DESTRUCTIVE: truncates events
// in the TEST database only (name must end with _test). Run: npm run experiment:explain
import os from "node:os";
import pg from "pg";

const url = process.env["TEST_DATABASE_URL"];
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("TEST_DATABASE_URL must point at a *_test database");
const ROWS = Number(process.env["ROWS"] ?? 200_000);
const pool = new pg.Pool({ connectionString: url, max: 1 });

const QUERIES: Record<string, string> = {
  "A: sort=seats (page 1, limit 10)": "SELECT id, name, seats FROM events ORDER BY seats ASC, id ASC LIMIT 10 OFFSET 0",
  "B: sort=name (page 1, limit 10)": 'SELECT id, name, seats FROM events ORDER BY name COLLATE "C" ASC, id ASC LIMIT 10 OFFSET 0',
  "C: sort=seats, minSeats=99000 (page 1)": "SELECT id, name, seats FROM events WHERE seats >= 99000 ORDER BY seats ASC, id ASC LIMIT 10 OFFSET 0",
  "D: sort=seats, deep page (OFFSET 100000)": "SELECT id, name, seats FROM events ORDER BY seats ASC, id ASC LIMIT 10 OFFSET 100000",
};
const INDEXES = [
  'CREATE INDEX events_seats_id_idx ON events (seats, id)',
  'CREATE INDEX events_name_c_id_idx ON events ((name COLLATE "C"), id)',
];

async function explain(sql: string): Promise<string> {
  const run = async () => (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  await run(); // warm the cache; report the second run
  return run();
}
async function report(title: string) {
  console.log(`\n==== ${title} ====`);
  for (const [name, sql] of Object.entries(QUERIES)) console.log(`\n-- ${name}\n${sql}\n${await explain(sql)}`);
}
async function insertBatch(n: number): Promise<number> {
  const t = process.hrtime.bigint();
  await pool.query(
    `INSERT INTO events (owner_id, name, seats)
     SELECT (SELECT min(id) FROM users), 'Synthetic ' || md5(g::text), (random() * 100000)::int FROM generate_series(1, $1) g`,
    [n],
  );
  return Number(process.hrtime.bigint() - t) / 1e6;
}

await pool.query("TRUNCATE events, users RESTART IDENTITY CASCADE");
await pool.query("INSERT INTO users (username, role, password_hash) VALUES ('exp_owner', 'organizer', 'x')");
await pool.query("DROP INDEX IF EXISTS events_seats_id_idx, events_name_c_id_idx");

const version = (await pool.query<{ v: string }>("SELECT version() AS v")).rows[0]!.v;
console.log(`date: ${new Date().toISOString()}\nhost: ${os.cpus()[0]?.model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.platform()} ${os.release()}\nnode: ${process.version}\npostgres: ${version}\nrows: ${ROWS} synthetic events (random seats 0..100000, md5 names)\nnote: single machine, Postgres in Docker, one warm run per query; not a benchmark.`);

const insertNoIdx = await insertBatch(ROWS);
await pool.query("ANALYZE events");
const size = async (rel: string) => (await pool.query<{ s: string }>("SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS s", [rel])).rows[0]!.s;
console.log(`\ntable size: ${await size("events")}; primary key index: ${await size("events_pkey")}; owner index: ${await size("events_owner_id_idx")}`);
await report("BEFORE candidate indexes");

for (const ddl of INDEXES) await pool.query(ddl);
await pool.query("ANALYZE events");
console.log(`\nindex sizes: seats,id = ${await size("events_seats_id_idx")}; name,id = ${await size("events_name_c_id_idx")}`);
await report("AFTER candidate indexes");

// Write cost: same 50k-row INSERT with 0 vs 2 extra indexes (one run each; indicative only).
const extra = 50_000;
const withIdx = await insertBatch(extra);
await pool.query("DROP INDEX events_seats_id_idx, events_name_c_id_idx");
await pool.query("ANALYZE events");
const withoutIdx = await insertBatch(extra);
console.log(`\n==== write cost ====\ninsert ${extra} rows with 2 extra indexes: ${withIdx.toFixed(0)} ms\ninsert ${extra} rows without them:        ${withoutIdx.toFixed(0)} ms\n(bulk load of ${ROWS} rows without extra indexes took ${insertNoIdx.toFixed(0)} ms)`);

await pool.query("TRUNCATE events, users RESTART IDENTITY CASCADE");
await pool.end();
