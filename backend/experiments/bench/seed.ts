// Lecture 21: build the SYNTHETIC benchmark database (never dev, never test).
//   BENCH_DATABASE_URL=postgres://.../eventhub_bench ROWS=300000 npm run bench:seed
// The database name MUST end in _bench. It is created if missing, migrated, then events are
// (re)generated deterministically: name = "<Category> <City> <md5(n)>" so a query can be
// broad (a category word, ~1/8 of rows) or selective (an md5 prefix, ~1 row).
import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";

const raw = process.env["BENCH_DATABASE_URL"];
if (!raw) throw new Error("BENCH_DATABASE_URL is required");
const url = new URL(raw);
const dbName = url.pathname.slice(1);
if (!dbName.endsWith("_bench")) throw new Error("BENCH_DATABASE_URL must point at a database whose name ends in _bench");
const ROWS = Number(process.env["ROWS"] ?? 300_000);
if (!Number.isInteger(ROWS) || ROWS < 1 || ROWS > 5_000_000) throw new Error("ROWS must be 1..5000000");

const admin = new pg.Client({ connectionString: new URL("/postgres", url).toString() });
await admin.connect();
if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount === 0) {
  await admin.query(`CREATE DATABASE "${dbName}"`); // identifier validated above (suffix check); no user data
  console.log(`created database ${dbName}`);
}
await admin.end();

const pool = new pg.Pool({ connectionString: raw, max: 1 });
console.log("migrations applied:", (await migrate(pool)).join(", ") || "none");
await pool.query("TRUNCATE events RESTART IDENTITY CASCADE");
// One synthetic organizer. The hash is a placeholder that matches no password: nobody can log in as it.
await pool.query(
  "INSERT INTO users (username, role, password_hash) VALUES ('bench_organizer', 'organizer', 'scrypt$placeholder-no-login') ON CONFLICT DO NOTHING",
);
const t0 = Date.now();
await pool.query(
  `INSERT INTO events (owner_id, name, seats)
   SELECT (SELECT id FROM users WHERE username = 'bench_organizer'),
          (ARRAY['Conference','Concert','Workshop','Festival','Meetup','Seminar','Expo','Hackathon'])[1 + g % 8]
            || ' ' || (ARRAY['Alexandria','Cairo','Giza','Luxor','Aswan','Dahab','Siwa','Tanta','Suez','Mansoura'])[1 + (g / 8) % 10]
            || ' ' || md5(g::text),
          (random() * 100000)::int
   FROM generate_series(1, $1) g`,
  [ROWS],
);
await pool.query("ANALYZE events");
const { rows } = await pool.query<{ n: string; broad: string; broad2: string; size: string }>(
  `SELECT count(*) AS n,
          count(*) FILTER (WHERE position('conference' in lower(name)) > 0) AS broad,
          count(*) FILTER (WHERE position('conference' in lower(name)) > 0 AND seats >= 50000) AS broad2,
          pg_size_pretty(pg_total_relation_size('events')) AS size
   FROM events`,
);
console.log(`seeded ${ROWS} events in ${Date.now() - t0} ms:`, rows[0]);
await pool.end();
