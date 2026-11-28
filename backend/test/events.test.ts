import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { dbEvents, resetEvents, SEED } from "./db.ts";
import { useServer } from "./helpers.ts";

const api = useServer();

test("GET /events returns 200 with the JSON list", async () => {
  const res = await fetch(`${api.base}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), await dbEvents());
});

test("GET /events does not mutate the collection", async () => {
  const before = JSON.stringify(await dbEvents());
  await fetch(`${api.base}/events`);
  await fetch(`${api.base}/events`);
  assert.equal(JSON.stringify(await dbEvents()), before);
});

test("GET /events on an empty collection returns []", async () => {
  await pool.query("TRUNCATE events CASCADE");
  try {
    const res = await fetch(`${api.base}/events`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    await resetEvents(SEED);
  }
});

test("DELETE /events returns 405 with Allow", async () => {
  const res = await fetch(`${api.base}/events`, { method: "DELETE" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
});
