// Lecture 15 experiment: substring scan vs PostgreSQL full-text search (GIN) on SYNTHETIC
// event names. DESTRUCTIVE: truncates events/users in the TEST database only (name must end
// with _test). Run: ROWS=20000 npm run experiment:search   (ROWS default 20000)
import os from "node:os";
import pg from "pg";

const url = process.env["TEST_DATABASE_URL"];
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("TEST_DATABASE_URL must point at a *_test database");
const ROWS = Number(process.env["ROWS"] ?? 20_000);
const REPS = 15;
const pool = new pg.Pool({ connectionString: url, max: 1 });

// ~300 words, Zipf-ish: low indexes are common, high indexes rare. "zephyr" appears in ~1 row
// per 1000; "summit" is common; "labtop" never appears.
const WORDS = ["summit", "conference", "workshop", "night", "meetup", "festival", "expo", "forum", "gala", "jazz", "ai", "backend", "engineering", "cairo", "design"];
const SQL_NAME = `(SELECT string_agg(w, ' ') FROM (
  SELECT CASE WHEN random() < 0.0004 THEN 'zephyr'
              ELSE (ARRAY[${WORDS.map((w) => `'${w}'`).join(",")}])[1 + floor(power(random(), 2) * ${WORDS.length})::int] END AS w
  FROM generate_series(1, 2 + (g % 3))) t)`;

const FTS = "to_tsvector('simple', name)";
const cases = (term: string) => ({
  "substring position() (the list ?q= filter)": { sql: `SELECT id, name, seats FROM events WHERE position(lower($1) in lower(name)) > 0 ORDER BY id LIMIT 10`, p: [term] },
  "ILIKE '%term%'": { sql: `SELECT id, name, seats FROM events WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 10`, p: [term] },
  "FTS ranked (production query)": {
    sql: `SELECT id, name, seats FROM events WHERE ${FTS} @@ plainto_tsquery('simple', $1) ORDER BY ts_rank(${FTS}, plainto_tsquery('simple', $1)) DESC, id ASC LIMIT 10`,
    p: [term],
  },
});

async function timed(sql: string, p: string[]): Promise<{ median: number; max: number; rows: number }> {
  const ms: number[] = [];
  let rows = 0;
  for (let i = 0; i < REPS + 2; i++) {
    const t = process.hrtime.bigint();
    rows = (await pool.query(sql, p)).rowCount ?? 0;
    if (i >= 2) ms.push(Number(process.hrtime.bigint() - t) / 1e6); // first 2 runs warm up
  }
  ms.sort((a, b) => a - b);
  return { median: ms[Math.floor(ms.length / 2)]!, max: ms[ms.length - 1]!, rows };
}
async function plan(sql: string, p: string[]): Promise<string> {
  return (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, p)).rows.map((r) => r["QUERY PLAN"]).join("\n");
}
async function report(title: string) {
  console.log(`\n==== ${title} ====`);
  for (const term of ["zephyr", "summit", "labtop"]) {
    console.log(`\n-- term "${term}" (matches: ${(await pool.query("SELECT count(*) n FROM events WHERE " + FTS + " @@ plainto_tsquery('simple', $1)", [term])).rows[0].n} rows by token)`);
    for (const [name, c] of Object.entries(cases(term))) {
      const t = await timed(c.sql, c.p);
      console.log(`${name.padEnd(45)} median ${t.median.toFixed(2)} ms  max ${t.max.toFixed(2)} ms  (${REPS} warm runs, ${t.rows} rows returned)`);
    }
  }
  for (const term of ["zephyr", "summit"]) {
    const c = cases(term);
    console.log(`\n-- plan: ILIKE, "${term}"\n${await plan(c["ILIKE '%term%'"].sql, c["ILIKE '%term%'"].p)}`);
    console.log(`\n-- plan: FTS, "${term}"\n${await plan(c["FTS ranked (production query)"].sql, c["FTS ranked (production query)"].p)}`);
  }
}

await pool.query("TRUNCATE events, users RESTART IDENTITY CASCADE");
await pool.query("INSERT INTO users (username, role, password_hash) VALUES ('exp_owner', 'organizer', 'x')");
await pool.query("DROP INDEX IF EXISTS events_name_fts_idx");
const version = (await pool.query<{ v: string }>("SELECT version() AS v")).rows[0]!.v;
console.log(`date: ${new Date().toISOString()}\nhost: ${os.cpus()[0]?.model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.platform()} ${os.release()}\nnode: ${process.version}\npostgres: ${version}\nrows: ${ROWS} synthetic names of 2-4 words from a 16-word vocabulary (skewed), 'zephyr' injected at ~0.04%\nnote: one machine, Postgres in Docker, ${REPS} warm runs per query via the pg client (includes client round trip); not a benchmark of production.`);
await pool.query(`INSERT INTO events (owner_id, name, seats) SELECT (SELECT min(id) FROM users), ${SQL_NAME}, 10 FROM generate_series(1, $1) g`, [ROWS]);
await pool.query("ANALYZE events");
const size = async (rel: string) => (await pool.query<{ s: string }>("SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS s", [rel])).rows[0]!.s;
console.log(`\nsample names: ${(await pool.query("SELECT name FROM events ORDER BY id LIMIT 4")).rows.map((r) => r.name).join(" | ")}\ntable size: ${await size("events")}`);
await report("BEFORE the GIN index (FTS has to compute tsvectors per row)");

const t = process.hrtime.bigint();
await pool.query(`CREATE INDEX events_name_fts_idx ON events USING GIN (${FTS})`);
console.log(`\nCREATE INDEX took ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms; index size ${await size("events_name_fts_idx")}`);
await pool.query("ANALYZE events");
await report("AFTER the GIN index");

// Write cost: same bulk INSERT with and without the index (one run each; indicative only).
const extra = Math.max(1000, Math.floor(ROWS / 4));
const ins = async () => {
  const s = process.hrtime.bigint();
  await pool.query(`INSERT INTO events (owner_id, name, seats) SELECT (SELECT min(id) FROM users), ${SQL_NAME}, 10 FROM generate_series(1, $1) g`, [extra]);
  return Number(process.hrtime.bigint() - s) / 1e6;
};
const withIdx = await ins();
await pool.query("DROP INDEX events_name_fts_idx");
const without = await ins();
console.log(`\n==== write cost ====\ninsert ${extra} rows with the GIN index: ${withIdx.toFixed(0)} ms\ninsert ${extra} rows without it:        ${without.toFixed(0)} ms (one run each)`);

await pool.query("TRUNCATE events, users RESTART IDENTITY CASCADE");
await pool.query("CREATE INDEX events_name_fts_idx ON events USING GIN (to_tsvector('simple', name))"); // restore the migrated schema
await pool.end();
