import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { events } from "../src/server.ts";
import type { EventItem } from "../src/server.ts";
import { eventOwners } from "../src/auth.ts";
import { useServer } from "./helpers.ts";

const api = useServer();
const V1 = () => `${api.base}/api/v1`;
const JSON_H = { "Content-Type": "application/json" };

let seed: EventItem[] = [];
before(() => { seed = structuredClone(events); });
beforeEach(() => { events.splice(0, events.length, ...structuredClone(seed)); });

type Body = { error: string; details: string[]; errors: { path: string; code: string; message: string }[] };

test("POST invalid: 422 keeps legacy details and adds errors[path,code]", async () => {
  const res = await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "  ", seats: "5" }) });
  assert.equal(res.status, 422);
  const j = (await res.json()) as Body;
  assert.equal(j.error, "Unprocessable Content");
  assert.deepEqual(j.errors.map((e) => `${e.path}:${e.code}`), ["name:LENGTH", "seats:RANGE"]);
  assert.deepEqual(j.details, j.errors.map((e) => e.message));
});

test("invalid POST/PUT/PATCH never mutate state, ownership or the id counter", async () => {
  const before = structuredClone(events);
  const ownersBefore = new Map(eventOwners);
  const bad = [
    fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "x", seats: -1 }) }),
    fetch(`${V1()}/events/1`, { method: "PUT", headers: JSON_H, body: JSON.stringify({ name: "", seats: 1 }) }),
    fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ seats: 1.5 }) }),
    fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ name: null }) }),
    fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: "{}" }),
  ];
  for (const r of await Promise.all(bad)) assert.equal(r.status, 422);
  assert.deepEqual(events, before);
  assert.deepEqual(new Map(eventOwners), ownersBefore);

  // Early rejection: five rejected requests consumed no id (counter only moves on success).
  const a = (await (await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "A", seats: 1 }) })).json()) as EventItem;
  const b = (await (await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "B", seats: 1 }) })).json()) as EventItem;
  assert.equal(b.id, a.id + 1);
});

test("PATCH: valid partial updates normalise; 0 is a real value; merged state validated", async () => {
  const r1 = await fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ seats: 0 }) });
  assert.deepEqual(await r1.json(), { id: 1, name: "Synthetic Jazz Night", seats: 0 });
  const r2 = await fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ name: "  Trim  " }) });
  assert.deepEqual(await r2.json(), { id: 1, name: "Trim", seats: 0 });
  const r3 = await fetch(`${V1()}/events/1`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({}) });
  const j = (await r3.json()) as Body;
  assert.equal(r3.status, 422);
  assert.equal(j.errors[0]?.code, "PATCH_EMPTY");
});

test("write-field injection: id is ignored (legacy policy), only name and seats are stored", async () => {
  const res = await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ id: 1, name: "Inj", seats: 1, ownerId: 1, role: "admin" }) });
  const created = (await res.json()) as EventItem;
  assert.notEqual(created.id, 1);
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "seats"]);
  assert.equal(events.find((e) => e.id === 1)?.name, "Synthetic Jazz Night");
});

test("query: 400 with errors[] for repeated, malformed and oversized values", async () => {
  const cases: [string, string[]][] = [
    ["page=1&page=2", ["page:REPEATED"]],
    ["sort=a&sort=b", ["sort:REPEATED"]],
    ["city=a&city=b", ["city:REPEATED"]],
    ["page=abc&sort=zzz", ["sort:INVALID_SORT", "page:INVALID_PAGE"]],
    ["page=", ["page:INVALID_PAGE"]],
    ["page=2e1", ["page:INVALID_PAGE"]],
    ["page=0", ["page:INVALID_PAGE"]],
    ["page=1000000000", ["page:INVALID_PAGE"]],
    ["page=99999999999999999999", ["page:INVALID_PAGE"]],
  ];
  for (const [qs, expected] of cases) {
    const res = await fetch(`${V1()}/events?${qs}`);
    assert.equal(res.status, 400, qs);
    const j = (await res.json()) as Body;
    assert.deepEqual(j.errors.map((e) => `${e.path}:${e.code}`), expected, qs);
    assert.deepEqual(j.details, j.errors.map((e) => e.message));
  }
  const rep = await fetch(`${V1()}/events/search?q=a&q=b`);
  assert.equal(rep.status, 400);
});

test("query: defaults, conversion, sort and unknown keys keep working", async () => {
  const res = await fetch(`${V1()}/events?page=1&sort=-name&city=Cairo&zzz=1`);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { data: EventItem[]; meta: Record<string, unknown> };
  assert.deepEqual(j.data.map((e) => e.name), ["Synthetic Tech Meetup", "Synthetic Jazz Night"]);
  assert.deepEqual(j.meta, { page: 1, pageSize: 10, total: 2, totalPages: 1, sort: "-name", city: "Cairo", q: null, minSeats: null });
  const far = (await (await fetch(`${V1()}/events?page=999999999`)).json()) as { data: unknown[] };
  assert.deepEqual(far.data, []);
});

test("path ids beyond MAX_SAFE_INTEGER are a clean 404 and never hit a rounded id", async () => {
  for (const id of ["9007199254740993", "99999999999999999999"]) {
    for (const [method, init] of [["GET", {}], ["DELETE", {}], ["PUT", { headers: JSON_H, body: JSON.stringify({ name: "x", seats: 1 }) }]] as const) {
      const res = await fetch(`${V1()}/events/${id}`, { method, ...init });
      assert.equal(res.status, 404, `${method} ${id}`);
    }
    assert.equal((await fetch(`${V1()}/events/${id}/tickets`)).status, 404);
  }
  assert.equal(events.length, seed.length);
});

test("regression: body-level errors keep their statuses; booking stays a 501 stub", async () => {
  assert.equal((await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: "{bad" })).status, 400);
  assert.equal((await fetch(`${V1()}/events`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await fetch(`${V1()}/events`, { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "x".repeat(20_000), seats: 1 }) })).status, 413);
  const stub = await fetch(`${V1()}/bookings`, { method: "POST", headers: JSON_H, body: JSON.stringify({ eventId: 1, quantity: 1, total: 0 }) });
  assert.equal(stub.status, 501);
});
