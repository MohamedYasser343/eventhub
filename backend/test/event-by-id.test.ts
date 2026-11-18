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

test("GET /events/1 returns that event", async () => {
  const res = await fetch(`${base}/events/1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), events.find((e) => e.id === 1));
});

test("GET /events/999 returns 404 JSON", async () => {
  const res = await fetch(`${base}/events/999`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
});

for (const bad of ["abc", "0", "-1", "01", "1.0", "1e0", "1/", "1%20"]) {
  test(`GET /events/${bad} returns 404`, async () => {
    const res = await fetch(`${base}/events/${bad}`);
    assert.equal(res.status, 404);
  });
}

test("GET /events/1 does not mutate the collection", async () => {
  const snapshot = JSON.stringify(events);
  await fetch(`${base}/events/1`);
  await fetch(`${base}/events/999`);
  assert.equal(JSON.stringify(events), snapshot);
});

test("PATCH /events/1 returns 405 with Allow and does not change anything", async () => {
  const snapshot = JSON.stringify(events);
  const res = await fetch(`${base}/events/1`, { method: "PATCH" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, PUT, DELETE, OPTIONS");
  assert.equal(JSON.stringify(events), snapshot);
});
