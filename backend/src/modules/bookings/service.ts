import type { FieldError, Result } from "../../validation.ts";
import type { PublicEventCache } from "../events/public-cache.ts";
import type { BookOutcome, BookingRepository } from "./repository.ts";

export const MAX_QUANTITY = 10; // mirrors the CHECK in migration 007

// Body: optional object with an optional integer `quantity` (default 1). Unknown keys are ignored.
export function validateBookingInput(input: unknown): Result<{ quantity: number }> {
  if (input === undefined) return { ok: true, value: { quantity: 1 } };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", code: "BODY_NOT_OBJECT", message: "body must be a JSON object" }] };
  }
  const q = (input as Record<string, unknown>)["quantity"];
  if (q === undefined) return { ok: true, value: { quantity: 1 } };
  if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
    const errors: FieldError[] = [{ path: "quantity", code: "RANGE", message: `quantity must be an integer between 1 and ${MAX_QUANTITY}` }];
    return { ok: false, errors };
  }
  return { ok: true, value: { quantity: q } };
}

export type BookingResult = BookOutcome | { ok: false; reason: "invalid"; errors: FieldError[] };

export class BookingService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly publicCache?: PublicEventCache,
  ) {}

  // The buyer id comes from the verified session, never from the body. Invalid input is
  // rejected before any connection is checked out, so it cannot mutate anything.
  async book(userId: number, eventId: number, input: unknown): Promise<BookingResult> {
    const v = validateBookingInput(input);
    if (!v.ok) return { ok: false, reason: "invalid", errors: v.errors };
    const r = await this.repo.book(eventId, userId, v.value.quantity);
    if (r.ok) await this.publicCache?.invalidate(eventId); // after COMMIT: the cached seat count is stale
    return r;
  }
}
