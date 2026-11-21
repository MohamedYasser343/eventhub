import type pg from "pg";
import { withTransaction } from "../../src/db/pool.ts";

// ISOLATED lecture 12 lab: not wired to any route. Inventory is events.seats; the
// only extra object is a lab table created and dropped by the test.
export const LAB_DDL = `
  CREATE TABLE IF NOT EXISTS lab_bookings (
    id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events (id),
    user_id  BIGINT NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

export type BookResult = { ok: true; bookingId: number; pids: number[] } | { ok: false; reason: "sold-out" };

// Atomic conditional decrement + booking insert on ONE connection in ONE transaction.
// Throws (after ROLLBACK) if the insert fails, so the decrement is undone.
export function book(pool: pg.Pool, eventId: number, userId: number): Promise<BookResult> {
  return withTransaction(async (c) => {
    const pids: number[] = [];
    const pid = async () => pids.push((await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    await pid();
    const dec = await c.query("UPDATE events SET seats = seats - 1 WHERE id = $1 AND seats > 0 RETURNING id", [eventId]);
    if (dec.rowCount !== 1) return { ok: false as const, reason: "sold-out" as const }; // nothing changed; COMMIT is harmless
    await pid();
    const ins = await c.query<{ id: number }>("INSERT INTO lab_bookings (event_id, user_id) VALUES ($1, $2) RETURNING id", [eventId, userId]);
    await pid();
    return { ok: true as const, bookingId: ins.rows[0]!.id, pids };
  }, pool);
}

// The BROKEN version, kept as a negative control: read, compute in the app, write back.
export async function bookNaive(pool: pg.Pool, eventId: number, userId: number): Promise<boolean> {
  const seats = (await pool.query<{ seats: number }>("SELECT seats FROM events WHERE id = $1", [eventId])).rows[0]!.seats;
  if (seats <= 0) return false;
  await new Promise((r) => setTimeout(r, 5)); // widen the window like real network/app latency
  await pool.query("UPDATE events SET seats = $2 WHERE id = $1", [eventId, seats - 1]);
  await pool.query("INSERT INTO lab_bookings (event_id, user_id) VALUES ($1, $2)", [eventId, userId]);
  return true;
}
