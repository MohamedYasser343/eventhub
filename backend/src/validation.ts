// Request-contract validation (lecture 09). Pure functions: unknown in, typed
// result out. No HTTP objects, no store access, so each rule is unit testable.
// Policy and trade-offs are recorded in docs/decisions/008-validation-policy.md.

export interface FieldError {
  path: string; // "name", "seats", "page", "" for the whole body
  code: string; // stable, machine-readable
  message: string; // human-readable, never echoes the offending value
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

// Legacy 422/400 bodies carry `details: string[]`; it stays, `errors` is added.
export const detailsOf = (errors: FieldError[]): string[] => errors.map((e) => e.message);

const fail = (path: string, code: string, message: string): { ok: false; errors: FieldError[] } => ({
  ok: false,
  errors: [{ path, code, message }],
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- events ----------

export const MAX_NAME_LENGTH = 100;
export const MAX_SEATS = 100_000;

export interface EventFields {
  name: string;
  seats: number;
}

// Full representation (POST, PUT). Unknown keys, including `id`, are ignored
// and never copied: only the two approved fields are projected (legacy policy).
export function validateEventInput(input: unknown): Result<EventFields> {
  if (!isObject(input)) return fail("", "BODY_NOT_OBJECT", "body must be a JSON object");
  const { name, seats } = input;
  const errors: FieldError[] = [];

  // `.length` counts UTF-16 code units, so an emoji counts as 2. Documented policy.
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (typeof name !== "string") {
    errors.push({ path: "name", code: "TYPE", message: "name must be a string" });
  } else if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    errors.push({ path: "name", code: "LENGTH", message: `name must be 1-${MAX_NAME_LENGTH} characters after trimming` });
  }

  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 0 || seats > MAX_SEATS) {
    errors.push({ path: "seats", code: "RANGE", message: `seats must be an integer between 0 and ${MAX_SEATS}` });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name: trimmed, seats: seats as number } };
}

// Partial representation (PATCH). Absent key = keep current; null, "" and 0 are
// real values and are validated, not treated as absent. The merged result is
// validated like a full event, so a PATCH can never store what a PUT would reject.
export function validateEventPatch(input: unknown, current: EventFields): Result<EventFields> {
  if (!isObject(input) || !(Object.hasOwn(input, "name") || Object.hasOwn(input, "seats"))) {
    return fail("", "PATCH_EMPTY", "body must be a JSON object with name and/or seats");
  }
  return validateEventInput({
    name: Object.hasOwn(input, "name") ? input["name"] : current.name,
    seats: Object.hasOwn(input, "seats") ? input["seats"] : current.seats,
  });
}

// ---------- path ids and query ----------

// Router already guarantees the canonical shape /^[1-9][0-9]*$/. This adds the
// numeric half: digits beyond 2^53 would round to a different number.
// Returns null when the id cannot be a real event id (handlers answer 404).
export function parseId(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9][0-9]*$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
export const MAX_Q_LENGTH = 100;
const MAX_PAGE_DIGITS = 9;

// Syntax first (decimal digits only: no "", " 2", "2e1", "0x2", "+2", "02"),
// then conversion. Number("") is 0 and parseInt("20abc") is 20, so neither is used raw.
export function parsePage(text: string | undefined): Result<number> {
  const raw = text ?? "1";
  if (!new RegExp(`^[1-9][0-9]{0,${MAX_PAGE_DIGITS - 1}}$`).test(raw)) {
    return fail("page", "INVALID_PAGE", "page must be a positive integer");
  }
  return { ok: true, value: Number(raw) };
}

export const SORT_FIELDS = ["id", "name", "seats"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export interface SortSpec {
  text: string; // as sent (echoed in meta)
  field: SortField;
  direction: 1 | -1;
}

export function parseSort(text: string | undefined): Result<SortSpec> {
  const raw = text ?? "id";
  const m = /^(-?)(id|name|seats)$/.exec(raw);
  if (!m) return fail("sort", "INVALID_SORT", "sort must be id, name or seats, optionally prefixed with -");
  return { ok: true, value: { text: raw, field: m[2] as SortField, direction: m[1] === "-" ? -1 : 1 } };
}

// limit: 1..MAX_LIMIT, decimal digits only. Out-of-bounds values are REJECTED
// (400), not silently capped, so a client never receives a different page size
// than it asked for (ADR-010).
export function parseLimit(text: string | undefined): Result<number> {
  const raw = text ?? String(DEFAULT_LIMIT);
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > MAX_LIMIT) {
    return fail("limit", "INVALID_LIMIT", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { ok: true, value: Number(raw) };
}

// minSeats: non-negative integer, at most 9 digits ("0" allowed, no leading zeros).
export function parseMinSeats(text: string | undefined): Result<number | null> {
  if (text === undefined) return { ok: true, value: null };
  if (!/^(0|[1-9][0-9]{0,8})$/.test(text)) {
    return fail("minSeats", "INVALID_MIN_SEATS", "minSeats must be a non-negative integer");
  }
  return { ok: true, value: Number(text) };
}

// q: case-insensitive substring of the name; an empty q matches everything.
export function parseNameFilter(text: string | undefined): Result<string | null> {
  if (text === undefined) return { ok: true, value: null };
  if (text.length > MAX_Q_LENGTH) {
    return fail("q", "INVALID_Q", `q must be at most ${MAX_Q_LENGTH} characters`);
  }
  return { ok: true, value: text };
}

type Query = Record<string, string[]>;

export interface ListQuery {
  city: string | null;
  q: string | null;
  minSeats: number | null;
  sort: SortSpec;
  page: number;
  limit: number;
  offset: number; // safe: page <= 10^9 - 1 and limit <= 100, so offset < 10^11
}

// city is echoed only (events have no city). A repeated scalar key is ambiguous and rejected. Unknown keys are ignored
// (legacy policy). All independent errors are reported together.
export function parseListQuery(query: Query): Result<ListQuery> {
  const errors: FieldError[] = [];
  const one = (key: string): string | undefined | "REPEATED" => {
    const values = query[key];
    if (values === undefined) return undefined;
    if (values.length !== 1) {
      errors.push({ path: key, code: "REPEATED", message: `${key} must not be repeated` });
      return "REPEATED";
    }
    return values[0];
  };
  const city = one("city");
  const sortRaw = one("sort");
  const pageRaw = one("page");
  const limitRaw = one("limit");
  const qRaw = one("q");
  const minSeatsRaw = one("minSeats");

  const sort = sortRaw === "REPEATED" ? null : parseSort(sortRaw);
  if (sort && !sort.ok) errors.push(...sort.errors);
  const page = pageRaw === "REPEATED" ? null : parsePage(pageRaw);
  if (page && !page.ok) errors.push(...page.errors);
  const limit = limitRaw === "REPEATED" ? null : parseLimit(limitRaw);
  if (limit && !limit.ok) errors.push(...limit.errors);
  const q = qRaw === "REPEATED" ? null : parseNameFilter(qRaw);
  if (q && !q.ok) errors.push(...q.errors);
  const minSeats = minSeatsRaw === "REPEATED" ? null : parseMinSeats(minSeatsRaw);
  if (minSeats && !minSeats.ok) errors.push(...minSeats.errors);

  if (errors.length > 0 || !sort?.ok || !page?.ok || !limit?.ok || !q?.ok || !minSeats?.ok) {
    // Deterministic order so clients and tests can rely on it.
    const order = ["city", "q", "minSeats", "sort", "page", "limit"];
    errors.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      city: city === undefined || city === "REPEATED" ? null : city,
      q: q.value,
      minSeats: minSeats.value,
      sort: sort.value,
      page: page.value,
      limit: limit.value,
      offset: (page.value - 1) * limit.value,
    },
  };
}

export interface SearchQuery {
  q: string; // trimmed, 1..MAX_Q_LENGTH characters
  page: number;
  limit: number;
  offset: number;
}

// Search policy (lecture 15): q is REQUIRED (a blank search is a client bug, not "list all";
// use GET /events for that), trimmed, at most MAX_Q_LENGTH characters. A repeated key is
// ambiguous and rejected. Words are matched by the database as plain tokens (no operators).
export function parseSearchQuery(query: Query): Result<SearchQuery> {
  const errors: FieldError[] = [];
  const one = (key: string): string | undefined | "REPEATED" => {
    const values = query[key];
    if (values === undefined) return undefined;
    if (values.length !== 1) {
      errors.push({ path: key, code: "REPEATED", message: `${key} must not be repeated` });
      return "REPEATED";
    }
    return values[0];
  };
  const qRaw = one("q");
  const pageRaw = one("page");
  const limitRaw = one("limit");
  let q = "";
  if (qRaw !== "REPEATED") {
    q = (qRaw ?? "").trim();
    if (q.length === 0) errors.push({ path: "q", code: "REQUIRED", message: "q is required and must not be blank" });
    else if (q.length > MAX_Q_LENGTH) errors.push({ path: "q", code: "INVALID_Q", message: `q must be at most ${MAX_Q_LENGTH} characters` });
  }
  const page = pageRaw === "REPEATED" ? null : parsePage(pageRaw);
  if (page && !page.ok) errors.push(...page.errors);
  const limit = limitRaw === "REPEATED" ? null : parseLimit(limitRaw);
  if (limit && !limit.ok) errors.push(...limit.errors);
  if (errors.length > 0 || !page?.ok || !limit?.ok) {
    const order = ["q", "page", "limit"];
    errors.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
    return { ok: false, errors };
  }
  return { ok: true, value: { q, page: page.value, limit: limit.value, offset: (page.value - 1) * limit.value } };
}

// ---------- booking exercise (pure, synthetic; no endpoint, no persistence) ----------

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10; // illustrative, owner may change it
export const CURRENCY = "EGP";

export interface BookingInput {
  eventId: number;
  quantity: number;
  // Optional comparison value, never an authority: "the unit price I was shown".
  expectedUnitPriceMinor?: number;
}

const BOOKING_KEYS = ["eventId", "quantity", "expectedUnitPriceMinor"];

// Strict contract: any other key (ticketPrice, total, role, userId, ...) is
// rejected, so a client cannot even try to set a server-owned field.
export function validateBookingInput(input: unknown): Result<BookingInput> {
  if (!isObject(input)) return fail("", "BODY_NOT_OBJECT", "body must be a JSON object");
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!BOOKING_KEYS.includes(key)) {
      errors.push({ path: key, code: "UNKNOWN_FIELD", message: "unknown field" });
    }
  }
  const { eventId, quantity, expectedUnitPriceMinor } = input;
  if (typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId < 1) {
    errors.push({ path: "eventId", code: "INVALID_ID", message: "eventId must be a positive integer" });
  }
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    errors.push({ path: "quantity", code: "RANGE", message: `quantity must be an integer between ${MIN_QUANTITY} and ${MAX_QUANTITY}` });
  }
  if (
    Object.hasOwn(input, "expectedUnitPriceMinor") &&
    (typeof expectedUnitPriceMinor !== "number" || !Number.isSafeInteger(expectedUnitPriceMinor) || expectedUnitPriceMinor < 0)
  ) {
    errors.push({ path: "expectedUnitPriceMinor", code: "INVALID_PRICE", message: "expectedUnitPriceMinor must be a non-negative integer (minor units)" });
  }
  if (errors.length > 0) return { ok: false, errors };
  const value: BookingInput = { eventId: eventId as number, quantity: quantity as number };
  if (expectedUnitPriceMinor !== undefined) value.expectedUnitPriceMinor = expectedUnitPriceMinor as number;
  return { ok: true, value };
}

// Server-defined mock price list, in integer minor units (piasters). Not a pricing model.
export const MOCK_UNIT_PRICE_MINOR: ReadonlyMap<number, number> = new Map([
  [1, 10_000], // 100.00 EGP
  [2, 5_000], // 50.00 EGP
]);

export interface Quote {
  eventId: number;
  quantity: number;
  currency: typeof CURRENCY;
  unitPriceMinor: number;
  totalMinor: number;
}

export type PricingResult =
  | { ok: true; quote: Quote }
  | { ok: false; kind: "invalid"; errors: FieldError[] }
  | { ok: false; kind: "unknown-event" }
  | { ok: false; kind: "conflict"; code: "PRICE_CHANGED"; currentUnitPriceMinor: number };

// Policy: the server price is the only authority and the total is always derived
// from it. An expectation, when sent, only DETECTS a stale view (conflict); it is
// never used as the price. Without one the current server price applies (no lock).
export function priceBooking(
  input: unknown,
  prices: ReadonlyMap<number, number> = MOCK_UNIT_PRICE_MINOR,
): PricingResult {
  const parsed = validateBookingInput(input);
  if (!parsed.ok) return { ok: false, kind: "invalid", errors: parsed.errors };
  const { eventId, quantity, expectedUnitPriceMinor } = parsed.value;

  const unitPriceMinor = prices.get(eventId);
  if (unitPriceMinor === undefined) return { ok: false, kind: "unknown-event" };
  if (expectedUnitPriceMinor !== undefined && expectedUnitPriceMinor !== unitPriceMinor) {
    return { ok: false, kind: "conflict", code: "PRICE_CHANGED", currentUnitPriceMinor: unitPriceMinor };
  }
  const totalMinor = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(totalMinor)) {
    return { ok: false, kind: "invalid", errors: [{ path: "quantity", code: "RANGE", message: "total is not representable" }] };
  }
  return { ok: true, quote: { eventId, quantity, currency: CURRENCY, unitPriceMinor, totalMinor } };
}
