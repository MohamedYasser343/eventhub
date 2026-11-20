# ADR-008: Request validation and transformation policy

Status: Proposed (awaiting owner confirmation)
Date: 2026-11-20
Related lecture: [09 — Validation & Transformation](../lectures/09-validation-transformation.md)

## Context
Validation lived inline in `server.ts`: one event validator, ad-hoc query regexes, and `Number(ctx.params.id)` for ids. Error bodies were a flat `details: string[]` with no stable field path or code. The router only guarantees the id *shape*, so a 20-digit id was converted to an imprecise number. Booking is a 501 stub and events have no price.

## Options
1. Keep inline checks (no change).
2. Native pure validators in one module, error type `{path, code, message}` (chosen).
3. A schema library (Zod/Joi). Not chosen: the rules are few and the lecture is about understanding the checks first; adding a dependency needs owner approval.

## Decision
- New module `backend/src/validation.ts`: pure functions returning `{ok, value}` or `{ok:false, errors[]}`; no HTTP or store access.
- **Error shape:** responses keep `details: string[]` (legacy, same messages and statuses) and add `errors: [{path, code, message}]`. Additive, so no client breaks. Messages never echo submitted values. Query errors are reported in the fixed order city, sort, page.
- **Unknown fields:** existing event write endpoints and registration keep ignoring extras, but only `name` and `seats` are projected, so `id`, `role`, `ownerId` can never be written. The new booking contract is strict (unknown key -> `UNKNOWN_FIELD`).
- **PATCH:** absent key keeps the current value; `null`, `""`, `0` are real values; the merged result is validated like a PUT.
- **Name length** counts UTF-16 code units (`String.length`), after trimming. Passwords are never trimmed or normalised.
- **Ids:** `parseId` requires a safe integer; anything else behaves as a missing resource (404), as before.
- **Page:** decimal digits only, 1 to 9 digits, default 1. No `limit` parameter was added (public API change, needs approval).
- **Booking exercise (pure, no endpoint, `/bookings` stays 501):** body `eventId`, `quantity` (1-10, illustrative), optional `expectedUnitPriceMinor`. The server price (mock table, integer minor units, EGP) is the only authority; total is derived. A mismatching expectation yields typed `PRICE_CHANGED` conflict; an absent expectation uses the current server price (it detects change, it does not lock a price).

## Trade-offs and consequences
- Two parallel error fields add a little payload until a deliberate migration drops `details`.
- Ignoring extras on legacy endpoints is lenient; strictness there would be a breaking change and is left to the owner.
- UTF-16 length lets an emoji count as 2; grapheme counting was not done.
- Validation does not make a later write atomic: an availability check is still racy until persistence and transactions exist (deferred).

## Evidence
`backend/test/validation.test.ts` (unit) and `backend/test/validation-http.test.ts` (HTTP). See the implementation evidence in the lecture note. No benchmarks.
