import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const LOCK_KEY = 120_001; // arbitrary app-wide advisory lock id for "migrating"

// Forward-only, versioned SQL files (NNN_name.sql). Each file runs in its own
// transaction and is recorded in schema_migrations with its checksum, so running
// the tool again applies nothing twice, and an edited, already-applied file is
// refused instead of silently diverging. Returns the names applied this run.
export async function migrate(pool: pg.Pool, dir: string = DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]); // two runners never interleave
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(dir + file, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import("./pool.ts");
  const applied = await migrate(pool);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  await pool.end();
}
