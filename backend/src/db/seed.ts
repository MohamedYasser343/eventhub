import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AuthService } from "../auth.ts";
import type { pool as Pool } from "./pool.ts";

// Trusted, idempotent development seed: privileged synthetic users (random passwords,
// printed once, never stored in the repository) and the two synthetic events.
export async function seedDemo(auth: AuthService, pool: typeof Pool): Promise<void> {
  for (const role of ["organizer", "admin"] as const) {
    const password = randomBytes(12).toString("base64url");
    const r = await auth.createUser(`demo_${role}`, password, role);
    console.log(r.ok ? `created demo_${role} with password ${password}` : `demo_${role} already exists (password unchanged)`);
  }
  const { rowCount } = await pool.query(
    `INSERT INTO events (owner_id, name, seats)
     SELECT (SELECT id FROM users WHERE lower(username) = 'demo_organizer'), v.name, v.seats
     FROM (VALUES ('Synthetic Jazz Night', 120), ('Synthetic Tech Meetup', 80)) AS v(name, seats)
     WHERE NOT EXISTS (SELECT 1 FROM events)`,
  );
  console.log(rowCount ? `inserted ${rowCount} synthetic events` : "events already present; nothing inserted");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import("./pool.ts");
  const { migrate } = await import("./migrate.ts");
  const { AuthService } = await import("../auth.ts");
  const { PgUserRepository } = await import("../modules/auth/user-repository.ts");
  await migrate(pool);
  await seedDemo(new AuthService(new PgUserRepository(pool)), pool);
  await pool.end();
}
