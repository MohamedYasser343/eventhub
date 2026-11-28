import type pg from "pg";
import { withTransaction } from "../../db/pool.ts";

export interface Booking {
  id: number;
  eventId: number;
  userId: number;
  quantity: number;
}
export type BookOutcome =
  | { ok: true; booking: Booking; seatsLeft: number }
  | { ok: false; reason: "not-found" | "sold-out" };

export interface BookingRepository {
  book(eventId: number, userId: number, quantity: number): Promise<BookOutcome>;
}

// Test-only seam: lets a test throw between the decrement and the insert to prove the ROLLBACK.
// Never wired from configuration or from a request.
export interface BookingFaults {
  afterDecrement?: () => Promise<void>;
}

export class PgBookingRepository implements BookingRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly faults: BookingFaults = {},
  ) {}

  // The database is the synchronization boundary (lecture 23): ONE connection, ONE transaction,
  // an atomic conditional decrement, then the booking row. Concurrent buyers of the same event
  // queue on the row lock and re-check `seats >= quantity` against the committed value, so the
  // stock can never go negative, in this process or in any other API process.
  book(eventId: number, userId: number, quantity: number): Promise<BookOutcome> {
    return withTransaction(async (c): Promise<BookOutcome> => {
      const dec = await c.query<{ seats: number }>(
        "UPDATE events SET seats = seats - $2 WHERE id = $1 AND seats >= $2 RETURNING seats",
        [eventId, quantity],
      );
      if (dec.rowCount !== 1) {
        // Nothing changed, so there is nothing to undo. Tell "no such event" from "not enough seats".
        const exists = await c.query("SELECT 1 FROM events WHERE id = $1", [eventId]);
        return { ok: false, reason: exists.rowCount === 1 ? "sold-out" : "not-found" };
      }
      await this.faults.afterDecrement?.();
      const ins = await c.query<{ id: number }>(
        "INSERT INTO bookings (event_id, user_id, quantity) VALUES ($1, $2, $3) RETURNING id",
        [eventId, userId, quantity],
      );
      return { ok: true, booking: { id: ins.rows[0]!.id, eventId, userId, quantity }, seatsLeft: dec.rows[0]!.seats };
    }, this.pool);
  }
}
