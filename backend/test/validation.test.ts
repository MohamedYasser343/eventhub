import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseId, parseListQuery, parsePage, priceBooking, validateBookingInput,
  validateEventInput, validateEventPatch,
} from "../src/validation.ts";

const codes = (r: { ok: boolean; errors?: { path: string; code: string }[] }) =>
  (r.errors ?? []).map((e) => `${e.path}:${e.code}`);

// ---------- events ----------

test("event: valid input is trimmed and projected; id and extras are dropped", () => {
  const r = validateEventInput({ id: 9, name: "  Show  ", seats: 5, role: "admin" });
  assert.deepEqual(r, { ok: true, value: { name: "Show", seats: 5 } });
});

test("event: type, shape and range errors carry stable path:code", () => {
  for (const body of [null, [], "x", 5, true]) {
    assert.deepEqual(codes(validateEventInput(body) as never), [":BODY_NOT_OBJECT"]);
  }
  assert.deepEqual(codes(validateEventInput({}) as never), ["name:TYPE", "seats:RANGE"]);
  assert.deepEqual(codes(validateEventInput({ name: 1, seats: "5" }) as never), ["name:TYPE", "seats:RANGE"]);
  assert.deepEqual(codes(validateEventInput({ name: null, seats: null }) as never), ["name:TYPE", "seats:RANGE"]);
  assert.deepEqual(codes(validateEventInput({ name: [], seats: [] }) as never), ["name:TYPE", "seats:RANGE"]);
});

test("event: name boundaries after trimming (empty, whitespace, 1, 100, 101)", () => {
  assert.deepEqual(codes(validateEventInput({ name: "", seats: 1 }) as never), ["name:LENGTH"]);
  assert.deepEqual(codes(validateEventInput({ name: " \t\n ", seats: 1 }) as never), ["name:LENGTH"]);
  assert.equal(validateEventInput({ name: "a", seats: 1 }).ok, true);
  assert.equal(validateEventInput({ name: "a".repeat(100), seats: 1 }).ok, true);
  assert.equal(validateEventInput({ name: ` ${"a".repeat(100)} `, seats: 1 }).ok, true); // trim first
  assert.deepEqual(codes(validateEventInput({ name: "a".repeat(101), seats: 1 }) as never), ["name:LENGTH"]);
});

test("event: Unicode length counts UTF-16 code units (documented policy)", () => {
  assert.equal(validateEventInput({ name: "😀".repeat(50), seats: 1 }).ok, true); // 100 units
  assert.equal(validateEventInput({ name: "😀".repeat(51), seats: 1 }).ok, false); // 102 units
});

test("event: seats boundaries, decimals, overflow, non-finite", () => {
  for (const ok of [0, 1, 100_000]) assert.equal(validateEventInput({ name: "a", seats: ok }).ok, true, String(ok));
  for (const bad of [-1, 100_001, 1.5, 1e21, Number.MAX_SAFE_INTEGER + 2, "10", true]) {
    assert.deepEqual(codes(validateEventInput({ name: "a", seats: bad }) as never), ["seats:RANGE"], String(bad));
  }
});

test("event: errors never echo the submitted value", () => {
  const r = validateEventInput({ name: "SECRET-VALUE-123".repeat(20), seats: "SECRET-SEATS" });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

// ---------- patch ----------

const current = { name: "Old", seats: 7 };

test("patch: absent keeps current, present is validated on the merged result", () => {
  assert.deepEqual(validateEventPatch({ seats: 0 }, current), { ok: true, value: { name: "Old", seats: 0 } });
  assert.deepEqual(validateEventPatch({ name: " New " }, current), { ok: true, value: { name: "New", seats: 7 } });
});

test("patch: null, empty string and wrong types are values, not 'absent'", () => {
  assert.deepEqual(codes(validateEventPatch({ name: null }, current) as never), ["name:TYPE"]);
  assert.deepEqual(codes(validateEventPatch({ name: "" }, current) as never), ["name:LENGTH"]);
  assert.deepEqual(codes(validateEventPatch({ seats: null }, current) as never), ["seats:RANGE"]);
  assert.deepEqual(codes(validateEventPatch({ seats: "3" }, current) as never), ["seats:RANGE"]);
});

test("patch: empty or non-object body is rejected; unknown-only body too", () => {
  for (const body of [{}, [], null, "x", { id: 5 }, { role: "admin" }]) {
    assert.deepEqual(codes(validateEventPatch(body, current) as never), [":PATCH_EMPTY"]);
  }
});

test("patch: does not mutate its input or the current event", () => {
  const input = { seats: 3 };
  const cur = { name: "Old", seats: 7 };
  validateEventPatch(input, cur);
  validateEventPatch({ seats: -1 }, cur);
  assert.deepEqual(input, { seats: 3 });
  assert.deepEqual(cur, { name: "Old", seats: 7 });
});

// ---------- ids and query ----------

test("parseId: safe positive integers only", () => {
  assert.equal(parseId("1"), 1);
  assert.equal(parseId("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const bad of [undefined, "", "0", "01", "-1", "1.5", "1e3", " 1", "9007199254740992", "99999999999999999999"]) {
    assert.equal(parseId(bad), null, String(bad));
  }
});

test("parsePage: default, bounds, and the coercions that must NOT be accepted", () => {
  assert.deepEqual(parsePage(undefined), { ok: true, value: 1 });
  assert.deepEqual(parsePage("2"), { ok: true, value: 2 });
  assert.deepEqual(parsePage("999999999"), { ok: true, value: 999_999_999 });
  // Number("")===0, Number(" 2")===2, Number("2e1")===20, parseInt("20abc")===20: all rejected here.
  for (const bad of ["", " 2", "2 ", "2e1", "0x2", "+2", "-2", "0", "02", "1.5", "20abc", "abc", "1000000000", "١٢"]) {
    assert.equal(parsePage(bad).ok, false, JSON.stringify(bad));
  }
});

test("parseListQuery: defaults, offset, repeated keys, aggregated errors", () => {
  const ok = parseListQuery({ page: ["3"], sort: ["-name"], city: ["Cairo"] });
  assert.deepEqual(ok, { ok: true, value: { city: "Cairo", q: null, minSeats: null, limit: 10, sort: { text: "-name", field: "name", direction: -1 }, page: 3, offset: 20 } });
  const def = parseListQuery({});
  assert.deepEqual(def.ok && def.value, { city: null, q: null, minSeats: null, limit: 10, sort: { text: "id", field: "id", direction: 1 }, page: 1, offset: 0 });
  assert.equal(parseListQuery({ unknown: ["x"] }).ok, true); // unknown keys ignored (legacy)

  const bad = parseListQuery({ page: ["1", "2"], sort: ["x"], city: ["a", "b"] });
  assert.deepEqual(codes(bad as never), ["city:REPEATED", "sort:INVALID_SORT", "page:REPEATED"]);
  const big = parseListQuery({ page: ["999999999"] });
  assert.ok(big.ok && Number.isSafeInteger(big.value.offset));
});

// ---------- booking / pricing exercise ----------

test("booking: unknown fields are rejected (strict), including forged price/total/role", () => {
  const r = validateBookingInput({ eventId: 1, quantity: 2, ticketPrice: 1, total: 1, role: "admin" });
  assert.deepEqual(codes(r as never), ["ticketPrice:UNKNOWN_FIELD", "total:UNKNOWN_FIELD", "role:UNKNOWN_FIELD"]);
});

test("booking: type and boundary checks", () => {
  assert.equal(validateBookingInput({ eventId: 1, quantity: 1 }).ok, true);
  assert.equal(validateBookingInput({ eventId: 1, quantity: 10 }).ok, true);
  for (const q of [0, 11, -1, 1.5, "2", null, NaN, Infinity]) {
    assert.deepEqual(codes(validateBookingInput({ eventId: 1, quantity: q }) as never), ["quantity:RANGE"], String(q));
  }
  for (const id of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(codes(validateBookingInput({ eventId: id, quantity: 1 }) as never), ["eventId:INVALID_ID"], String(id));
  }
  assert.deepEqual(codes(validateBookingInput({ eventId: 1, quantity: 1, expectedUnitPriceMinor: -1 }) as never), ["expectedUnitPriceMinor:INVALID_PRICE"]);
  assert.deepEqual(codes(validateBookingInput({ eventId: 1, quantity: 1, expectedUnitPriceMinor: null }) as never), ["expectedUnitPriceMinor:INVALID_PRICE"]);
  assert.deepEqual(codes(validateBookingInput([]) as never), [":BODY_NOT_OBJECT"]);
});

test("pricing: total is server price x quantity in integer minor units", () => {
  const r = priceBooking({ eventId: 1, quantity: 3 });
  assert.deepEqual(r, { ok: true, quote: { eventId: 1, quantity: 3, currency: "EGP", unitPriceMinor: 10_000, totalMinor: 30_000 } });
});

test("pricing: a forged total or price cannot lower the result", () => {
  for (const forged of [{ total: 1 }, { ticketPrice: 1 }, { totalMinor: 1 }, { unitPriceMinor: 1 }]) {
    const r = priceBooking({ eventId: 1, quantity: 3, ...forged });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, "invalid");
  }
});

test("pricing: stale expectation -> typed conflict; matching or absent -> proceeds", () => {
  assert.deepEqual(priceBooking({ eventId: 1, quantity: 1, expectedUnitPriceMinor: 5_000 }), {
    ok: false, kind: "conflict", code: "PRICE_CHANGED", currentUnitPriceMinor: 10_000,
  });
  const match = priceBooking({ eventId: 1, quantity: 2, expectedUnitPriceMinor: 10_000 });
  assert.ok(match.ok && match.quote.totalMinor === 20_000);
  // Absent expectation: current server price applies (documented, no price lock).
  const none = priceBooking({ eventId: 2, quantity: 2 });
  assert.ok(none.ok && none.quote.totalMinor === 10_000);
});

test("pricing: the price after a change is used, never the client's number", () => {
  const prices = new Map([[1, 15_000]]); // 100 -> 150 EGP
  const stale = priceBooking({ eventId: 1, quantity: 1, expectedUnitPriceMinor: 10_000 }, prices);
  assert.deepEqual(stale, { ok: false, kind: "conflict", code: "PRICE_CHANGED", currentUnitPriceMinor: 15_000 });
  const fresh = priceBooking({ eventId: 1, quantity: 1, expectedUnitPriceMinor: 15_000 }, prices);
  assert.ok(fresh.ok && fresh.quote.totalMinor === 15_000);
});

test("pricing: unknown event; non-safe total is refused instead of overflowing", () => {
  assert.deepEqual(priceBooking({ eventId: 99, quantity: 1 }), { ok: false, kind: "unknown-event" });
  const huge = priceBooking({ eventId: 1, quantity: 10 }, new Map([[1, Number.MAX_SAFE_INTEGER]]));
  assert.equal(!huge.ok && huge.kind, "invalid");
});
