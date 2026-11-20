import type { Role } from "../../auth.ts";

// Pure business policy from the lecture 10 discussion (no HTTP, no storage, no
// clock of its own: `now` is passed in so tests are deterministic). It is an
// exercise: there is no booking cancellation endpoint yet.
//
//  - A user may cancel only their OWN booking, and only with >= 24h left
//    before the event (exactly 24h is allowed).
//  - An admin may override the ownership and time restriction (assumed policy).
//  - A booking that is already cancelled/completed cannot be cancelled again,
//    for anyone: that invariant is independent of admin status.
export const MIN_HOURS_BEFORE_EVENT = 24;
const HOUR_MS = 3_600_000;

export type Denial = "NOT_OWNER" | "TOO_LATE" | "NOT_ACTIVE";
export type Decision = { allowed: true } | { allowed: false; reason: Denial };

export interface CancellationFacts {
  actor: { id: number; role: Role };
  booking: { ownerId: number; status: "active" | "cancelled" | "completed" };
  eventStartsAt: number; // epoch ms
  now: number; // epoch ms
}

export function canCancelBooking(f: CancellationFacts): Decision {
  if (f.booking.status !== "active") return { allowed: false, reason: "NOT_ACTIVE" };
  if (f.actor.role === "admin") return { allowed: true };
  if (f.booking.ownerId !== f.actor.id) return { allowed: false, reason: "NOT_OWNER" };
  if (f.eventStartsAt - f.now < MIN_HOURS_BEFORE_EVENT * HOUR_MS) return { allowed: false, reason: "TOO_LATE" };
  return { allowed: true };
}
