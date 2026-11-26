import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { cache } from "../src/cache.ts";
import { EVENT_KEY_PREFIX } from "../src/modules/events/public-cache.ts";
import type { EventItem } from "../src/modules/events/repository.ts";

export const SEED: EventItem[] = [
  { id: 1, name: "Synthetic Jazz Night", seats: 120 },
  { id: 2, name: "Synthetic Tech Meetup", seats: 80 },
];

// Empty users and events (and restart their ids) on the TEST database, after making
// sure the schema is migrated. Call once per test file, before creating any user.
export async function resetAll(): Promise<void> {
  await migrate(pool);
  await pool.query("TRUNCATE events, users, sessions RESTART IDENTITY CASCADE");
  await clearEventCache();
}

// Ids restart after TRUNCATE, so cached copies of "event 1" would be stale. Only this
// namespace is deleted, never FLUSHALL.
export const clearEventCache = () => cache.deletePrefix(EVENT_KEY_PREFIX);

// Replace every event with `seed`, all owned by one synthetic organizer nobody logs in
// as (so only an admin may edit them, like the old ownerless seed events). Ids restart
// at 1, so `seed` ids must be 1..n in order; the next created id is n + 1.
export async function resetEvents(seed: EventItem[] = SEED): Promise<void> {
  await pool.query("TRUNCATE events RESTART IDENTITY CASCADE");
  await clearEventCache();
  const owner = await pool.query<{ id: number }>(
    `INSERT INTO users (username, role, password_hash) VALUES ('seed_owner', 'organizer', 'x')
     ON CONFLICT (lower(username)) DO UPDATE SET username = users.username RETURNING id`,
  );
  for (const e of seed) {
    const r = await pool.query<{ id: number }>("INSERT INTO events (owner_id, name, seats) VALUES ($1, $2, $3) RETURNING id", [owner.rows[0]!.id, e.name, e.seats]);
    if (r.rows[0]!.id !== e.id) throw new Error("seed ids must be 1..n in order");
  }
}

export async function dbEvents(): Promise<EventItem[]> {
  return (await pool.query<EventItem>("SELECT id, name, seats FROM events ORDER BY id")).rows;
}
export async function dbOwnerOf(id: number): Promise<number | undefined> {
  return (await pool.query<{ owner_id: number }>("SELECT owner_id FROM events WHERE id = $1", [id])).rows[0]?.owner_id;
}
export async function dbOwners(): Promise<[number, number][]> {
  return (await pool.query<{ id: number; owner_id: number }>("SELECT id, owner_id FROM events ORDER BY id")).rows.map((r) => [r.id, r.owner_id]);
}
