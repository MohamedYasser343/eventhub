import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { events, server } from "../src/server.ts";

let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test("GET /events returns 200 with the JSON list", async () => {
  const res = await fetch(`${base}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), events);
});

test("GET /events does not mutate the collection", async () => {
  const before = JSON.stringify(events);
  await fetch(`${base}/events`);
  await fetch(`${base}/events`);
  assert.equal(JSON.stringify(events), before);
});

test("GET /events on an empty collection returns []", async () => {
  const saved = events.splice(0, events.length);
  try {
    const res = await fetch(`${base}/events`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    events.push(...saved);
  }
});

test("DELETE /events returns 405 with Allow", async () => {
  const res = await fetch(`${base}/events`, { method: "DELETE" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, POST");
});
