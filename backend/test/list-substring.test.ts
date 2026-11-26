// Lecture 21: the list filter `q` moved from position() to an escaped LIKE served by a trigram index.
// Behaviour must be IDENTICAL: case-insensitive substring, and % _ \ are literal characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { resetEvents } from "./db.ts";
import { useServer } from "./helpers.ts";

const api = useServer();
type Body = { data: { name: string }[]; meta: { total: number } };
const list = async (q: string, extra = "") =>
  (await (await fetch(`${api.base}/api/v1/events?q=${encodeURIComponent(q)}&sort=id${extra}`)).json()) as Body;

test("seed", async () => {
  await resetEvents(
    ["Jazz Night", "100% Fun_Fair", "Back\\slash Expo", "Funxfair", "مؤتمر الذكاء الاصطناعي", "ab"].map((name, i) => ({ id: i + 1, name, seats: 10 * (i + 1) })),
  );
});

test("case-insensitive substring, 3+ characters and shorter needles", async () => {
  assert.deepEqual((await list("JAZZ")).data.map((e) => e.name), ["Jazz Night"]);
  assert.deepEqual((await list("azz n")).data.map((e) => e.name), ["Jazz Night"]);
  assert.deepEqual((await list("ab")).data.map((e) => e.name), ["ab"]); // below the trigram size: still correct
  assert.deepEqual((await list("الذكاء")).data.map((e) => e.name), ["مؤتمر الذكاء الاصطناعي"]);
});

test("% _ and backslash are literal, never wildcards", async () => {
  assert.equal((await list("%")).meta.total, 1); // only "100% Fun_Fair" contains a percent sign
  assert.deepEqual((await list("fun_fair")).data.map((e) => e.name), ["100% Fun_Fair"]); // "Funxfair" must not match "_"
  assert.deepEqual((await list("0% f")).data.map((e) => e.name), ["100% Fun_Fair"]);
  assert.deepEqual((await list("\\")).data.map((e) => e.name), ["Back\\slash Expo"]);
  assert.deepEqual((await list("k\\s")).data.map((e) => e.name), ["Back\\slash Expo"]);
  assert.equal((await list("j%t")).meta.total, 0); // would match "Jazz Night" if % were a wildcard
});

test("combines with minSeats", async () => {
  assert.deepEqual((await list("fun", "&minSeats=30")).data.map((e) => e.name), ["Funxfair"]);
  assert.deepEqual((await list("fun", "&minSeats=20")).data.map((e) => e.name), ["100% Fun_Fair", "Funxfair"]);
});
