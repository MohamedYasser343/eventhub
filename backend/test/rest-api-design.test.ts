import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer, userToken } from "./helpers.ts";

// Lecture 11: predictable, bounded collection queries and CRUD semantics.
const api = useServer();
const v1 = (p: string) => `${api.base}/api/v1${p}`;
type Ev = { id: number; name: string; seats: number };
type Page = { data: Ev[]; meta: { page: number; pageSize: number; total: number; totalPages: number; sort: string; q: string | null; minSeats: number | null } };
const getPage = async (qs: string) => (await (await fetch(v1(`/events?${qs}`))).json()) as Page;
const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  headers: { "Content-Type": "application/json", ...extra },
  body: JSON.stringify(body),
});
const post = async (name: string, seats: number) => {
  const res = await fetch(v1("/events"), { method: "POST", ...json({ name, seats }) });
  assert.equal(res.status, 201);
  return (await res.json()) as Ev;
};

test("empty list is 200 with empty data; missing resource is 404", async () => {
  const res = await fetch(v1("/events?q=no-such-event-xyz"));
  assert.equal(res.status, 200);
  const j = (await res.json()) as Page;
  assert.deepEqual(j.data, []);
  assert.equal(j.meta.total, 0);
  assert.equal(j.meta.totalPages, 0);
  assert.equal((await fetch(v1("/events/987654"))).status, 404);
});

test("23 matching events with limit=10: pages of 10/10/3, no duplicates, stable order", async () => {
  for (let i = 0; i < 23; i++) await post(`Bulk23 ${String(i).padStart(2, "0")}`, 10 + i);
  const seen: number[] = [];
  const sizes: number[] = [];
  for (const page of [1, 2, 3]) {
    const j = await getPage(`q=bulk23&limit=10&page=${page}`);
    assert.equal(j.meta.total, 23);
    assert.equal(j.meta.totalPages, 3);
    assert.equal(j.meta.pageSize, 10);
    sizes.push(j.data.length);
    seen.push(...j.data.map((e) => e.id));
  }
  assert.deepEqual(sizes, [10, 10, 3]);
  assert.equal(new Set(seen).size, 23);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b)); // default sort=id
  const again = await getPage("q=bulk23&limit=10&page=2");
  assert.deepEqual(again.data.map((e) => e.id), seen.slice(10, 20)); // repeatable on a static dataset
  // page past the end: valid query, empty data, same total
  const far = await getPage("q=bulk23&limit=10&page=4");
  assert.deepEqual(far.data, []);
  assert.equal(far.meta.total, 23);
});

test("defaults: no params -> page 1, limit 10, sort id; limit changes slice size and totalPages", async () => {
  const d = await getPage("");
  assert.equal(d.meta.page, 1);
  assert.equal(d.meta.pageSize, 10);
  assert.ok(d.data.length <= 10);
  const j = await getPage("q=bulk23&limit=100");
  assert.equal(j.data.length, 23);
  assert.equal(j.meta.totalPages, 1);
  assert.equal((await getPage("q=bulk23&limit=1")).meta.totalPages, 23);
});

test("invalid limit / minSeats / q are rejected with 400 (not capped)", async () => {
  const bad = ["limit=0", "limit=-1", "limit=1.5", "limit=abc", "limit=", "limit=101", "limit=1000", "limit=010", "limit=1&limit=2",
    "minSeats=-1", "minSeats=1.5", "minSeats=abc", "minSeats=", "minSeats=1&minSeats=2", "q=a&q=b", `q=${"x".repeat(101)}`];
  for (const qs of bad) assert.equal((await fetch(v1(`/events?${qs}`))).status, 400, qs);
  const res = await fetch(v1("/events?limit=500&minSeats=x"));
  const j = (await res.json()) as { errors: { path: string; code: string }[] };
  assert.deepEqual(j.errors.map((e) => `${e.path}:${e.code}`), ["minSeats:INVALID_MIN_SEATS", "limit:INVALID_LIMIT"]);
});

test("filter and sort run BEFORE pagination; ties break by id; non-matching records excluded", async () => {
  // 6 matching events with only two distinct seat values (ties) + 3 that must not match.
  const tied: Ev[] = [];
  for (let i = 0; i < 6; i++) tied.push(await post(`TieSet ${i}`, i % 2 === 0 ? 500 : 600));
  for (let i = 0; i < 3; i++) await post(`Other ${i}`, 700);
  const all = (await getPage("q=tieset&sort=-seats&limit=100")).data;
  const expected = [...tied].sort((a, b) => b.seats - a.seats || a.id - b.id).map((e) => e.id);
  assert.deepEqual(all.map((e) => e.id), expected);
  // paging the same query: pages concatenate to the full ordered list, total ignores non-matching
  const p1 = await getPage("q=tieset&sort=-seats&limit=4&page=1");
  const p2 = await getPage("q=tieset&sort=-seats&limit=4&page=2");
  assert.equal(p1.meta.total, 6);
  assert.equal(p1.meta.totalPages, 2);
  assert.deepEqual([...p1.data, ...p2.data].map((e) => e.id), expected);
  // filter first: minSeats=600 keeps only 600-seat tieset events (total counts after filtering)
  const m = await getPage("q=tieset&minSeats=600");
  assert.deepEqual(m.data.map((e) => e.seats), [600, 600, 600]);
  assert.equal(m.meta.total, 3);
  assert.equal(m.meta.minSeats, 600);
  // ascending by seats: ties still ordered by id ascending
  const asc = (await getPage("q=tieset&sort=seats&limit=100")).data;
  assert.deepEqual(asc.map((e) => e.id), [...tied].sort((a, b) => a.seats - b.seats || a.id - b.id).map((e) => e.id));
});

test("PATCH keeps unrelated fields and is repeatable for a fixed value; PUT replaces; DELETE is idempotent in effect", async () => {
  const e = await post("Mutation Target", 50);
  const patch = () => fetch(v1(`/events/${e.id}`), { method: "PATCH", ...json({ seats: 60 }) });
  const r1 = await patch();
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { id: e.id, name: "Mutation Target", seats: 60 });
  const r2 = await patch(); // same fixed-value patch twice -> same state
  assert.deepEqual(await r2.json(), { id: e.id, name: "Mutation Target", seats: 60 });

  const put = await fetch(v1(`/events/${e.id}`), { method: "PUT", ...json({ name: "Replaced", seats: 5 }) });
  assert.deepEqual(await put.json(), { id: e.id, name: "Replaced", seats: 5 });
  // incomplete replacement is rejected and does not mutate
  const bad = await fetch(v1(`/events/${e.id}`), { method: "PUT", ...json({ name: "Only name" }) });
  assert.equal(bad.status, 422);
  const after = (await (await fetch(v1(`/events/${e.id}`))).json()) as Ev;
  assert.deepEqual(after, { id: e.id, name: "Replaced", seats: 5 });

  const d1 = await fetch(v1(`/events/${e.id}`), { method: "DELETE" });
  assert.equal(d1.status, 204);
  assert.equal(await d1.text(), "");
  assert.equal((await fetch(v1(`/events/${e.id}`), { method: "DELETE" })).status, 404); // status differs, effect is the same
  assert.equal((await fetch(v1(`/events/${e.id}`))).status, 404);
});

test("unauthenticated and wrong-owner mutations are rejected; no leak through counts", async () => {
  const owner = await userToken(api.base, "organizer");
  const other = await userToken(api.base, "organizer");
  const created = await fetch(v1("/events"), { method: "POST", ...json({ name: "Owned By A", seats: 10 }, { Authorization: `Bearer ${owner.token}` }) });
  assert.equal(created.status, 201);
  const ev = (await created.json()) as Ev;
  const anon = { "X-Test-Anon": "1" };
  assert.equal((await fetch(v1("/events"), { method: "POST", ...json({ name: "x", seats: 1 }, anon) })).status, 401);
  assert.equal((await fetch(v1(`/events/${ev.id}`), { method: "PATCH", ...json({ seats: 1 }, anon) })).status, 401);
  assert.equal((await fetch(v1(`/events/${ev.id}`), { method: "DELETE", headers: anon })).status, 401);
  const b = { Authorization: `Bearer ${other.token}` };
  assert.equal((await fetch(v1(`/events/${ev.id}`), { method: "PATCH", ...json({ seats: 1 }, b) })).status, 403);
  assert.equal((await fetch(v1(`/events/${ev.id}`), { method: "PUT", ...json({ name: "x", seats: 1 }, b) })).status, 403);
  assert.equal((await fetch(v1(`/events/${ev.id}`), { method: "DELETE", headers: b })).status, 403);
  // server-owned fields are not client-writable: id in the body is ignored
  const withId = await fetch(v1(`/events/${ev.id}`), { method: "PATCH", ...json({ id: 9999, seats: 11 }, { Authorization: `Bearer ${owner.token}` }) });
  assert.equal(((await withId.json()) as Ev).id, ev.id);
  // events are public, so the anonymous list (authorized scope == all) shows the event and counts it
  const listed = (await (await fetch(v1("/events?q=owned%20by%20a&limit=100"), { headers: anon })).json()) as Page;
  assert.equal(listed.meta.total, 1);
});

test("query regressions: unsupported method is 405 with Allow; HEAD works; legacy list unchanged", async () => {
  const del = await fetch(v1("/events"), { method: "DELETE" });
  assert.equal(del.status, 405);
  assert.ok(del.headers.get("allow")?.includes("GET"));
  const head = await fetch(v1("/events?limit=5"), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.ok(Array.isArray(await (await fetch(`${api.base}/events`)).json()));
});
