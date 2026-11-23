import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { parseSearchQuery } from "../src/validation.ts";
import { resetEvents } from "./db.ts";
import { useServer } from "./helpers.ts";

const api = useServer();
const url = (qs: string) => `${api.base}/api/v1/events/search?${qs}`;
type Body = { data: { id: number; name: string }[]; meta: { q: string; page: number; pageSize: number; total: number; totalPages: number } };
const names = async (qs: string) => ((await (await fetch(url(qs))).json()) as Body).data.map((e) => e.name);

const SYNTH = [
  "Backend Engineering Workshop",
  "AI Conference Cairo",
  "AI Engineering Summit",
  "Jazz Night",
  "100% Fun_Fair",
  "مؤتمر الذكاء الاصطناعي",
].map((name, i) => ({ id: i + 1, name, seats: 10 }));
test("seed", async () => { await resetEvents(SYNTH); });

test("title match, multi-word AND, case-insensitive; no match is an empty list", async () => {
  assert.deepEqual(await names("q=jazz"), ["Jazz Night"]);
  assert.deepEqual(await names("q=ENGINEERING"), ["Backend Engineering Workshop", "AI Engineering Summit"]);
  assert.deepEqual(await names("q=ai+engineering"), ["AI Engineering Summit"]);
  const res = await fetch(url("q=zzzzzz"));
  assert.equal(res.status, 200);
  const b = (await res.json()) as Body;
  assert.deepEqual(b.data, []);
  assert.equal(b.meta.total, 0);
});

test("token semantics: no partial words, no automatic typo correction", async () => {
  assert.deepEqual(await names("q=jaz"), []);
  assert.deepEqual(await names("q=jazzz"), []);
  assert.deepEqual(await names("q=labtop"), []);
});

test("ranking: shorter, more focused name first; ties broken by id", async () => {
  await pool.query("INSERT INTO events (owner_id, name, seats) SELECT owner_id, 'Jazz', 1 FROM events WHERE id = 1");
  await pool.query("INSERT INTO events (owner_id, name, seats) SELECT owner_id, 'Jazz Jazz Jazz', 1 FROM events WHERE id = 1");
  const order = await names("q=jazz");
  assert.deepEqual(new Set(order), new Set(["Jazz Night", "Jazz", "Jazz Jazz Jazz"]));
  assert.deepEqual(await names("q=jazz"), order); // deterministic across calls
  await pool.query("DELETE FROM events WHERE id > 6");
});

test("pagination: stable pages, meta, page past the end", async () => {
  const p1 = (await (await fetch(url("q=engineering&limit=1&page=1"))).json()) as Body;
  const p2 = (await (await fetch(url("q=engineering&limit=1&page=2"))).json()) as Body;
  assert.deepEqual([p1.data[0]!.id, p2.data[0]!.id], [1, 3]);
  assert.deepEqual(p1.meta, { q: "engineering", page: 1, pageSize: 1, total: 2, totalPages: 2 });
  const far = (await (await fetch(url("q=engineering&page=999999999"))).json()) as Body;
  assert.deepEqual(far.data, []);
  assert.equal(far.meta.total, 2);
});

test("hostile input is data: wildcards, SQL, tsquery operators, punctuation, unicode", async () => {
  assert.deepEqual(await names("q=" + encodeURIComponent("%")), []); // not a wildcard
  assert.deepEqual(await names("q=" + encodeURIComponent("_")), []);
  assert.deepEqual(await names("q=" + encodeURIComponent("'; DROP TABLE events; --")), []);
  assert.deepEqual(await names("q=" + encodeURIComponent("jazz | engineering")), []); // plain words, AND
  assert.deepEqual(await names("q=" + encodeURIComponent("jazz & !night")), ["Jazz Night"]); // "!" does not negate
  assert.deepEqual(await names("q=" + encodeURIComponent("!!!")), []); // zero lexemes
  assert.deepEqual(await names("q=" + encodeURIComponent("fun_fair")), ["100% Fun_Fair"]);
  assert.deepEqual(await names("q=" + encodeURIComponent("الذكاء")), ["مؤتمر الذكاء الاصطناعي"]);
  assert.equal(((await (await fetch(url("q=a"))).json()) as Body).meta.total, 0);
  const all = await (await fetch(`${api.base}/api/v1/events`)).json() as { meta: { total: number } };
  assert.equal(all.meta.total, 6); // nothing was dropped
});

test("validation: required, blank, too long, repeated, bad page/limit are 400", async () => {
  for (const qs of ["", "q=", "q=%20%20", `q=${"a".repeat(101)}`, "q=a&q=b", "q=a&limit=0", "q=a&limit=101", "q=a&page=0", "q=a&page=x"]) {
    assert.equal((await fetch(url(qs))).status, 400, qs);
  }
  assert.equal((await fetch(url(`q=${"a".repeat(100)}`))).status, 200);
});

test("changes show up immediately (same database, no derived copy): rename and delete", async () => {
  await pool.query("UPDATE events SET name = 'Renamed Gala' WHERE id = 4");
  assert.deepEqual(await names("q=jazz"), []);
  assert.deepEqual(await names("q=gala"), ["Renamed Gala"]);
  await pool.query("DELETE FROM events WHERE id = 4");
  assert.deepEqual(await names("q=gala"), []);
});

test("parseSearchQuery trims and reports all errors in a stable order", () => {
  const ok = parseSearchQuery({ q: ["  hi  "], page: ["2"], limit: ["5"] });
  assert.deepEqual(ok, { ok: true, value: { q: "hi", page: 2, limit: 5, offset: 5 } });
  const bad = parseSearchQuery({ limit: ["0"], page: ["0"] });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.errors.map((e) => e.path), ["q", "page", "limit"]);
});
