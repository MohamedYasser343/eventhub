import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { events } from "../src/server.ts";
import { useServer } from "./helpers.ts";

const api = useServer();

test("GET /events/1 returns that event", async () => {
  const res = await fetch(`${api.base}/events/1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), events.find((e) => e.id === 1));
});

test("GET /events/999 returns 404 JSON", async () => {
  const res = await fetch(`${api.base}/events/999`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
});

for (const bad of ["abc", "0", "-1", "01", "1.0", "1e0", "1/", "1%20"]) {
  test(`GET /events/${bad} returns 404`, async () => {
    const res = await fetch(`${api.base}/events/${bad}`);
    assert.equal(res.status, 404);
  });
}

test("GET /events/1 does not mutate the collection", async () => {
  const snapshot = JSON.stringify(events);
  await fetch(`${api.base}/events/1`);
  await fetch(`${api.base}/events/999`);
  assert.equal(JSON.stringify(events), snapshot);
});

test("PATCH /events/1 returns 405 with Allow and does not change anything", async () => {
  const snapshot = JSON.stringify(events);
  const res = await fetch(`${api.base}/events/1`, { method: "PATCH" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, PUT, DELETE, OPTIONS");
  assert.equal(JSON.stringify(events), snapshot);
});

// A leading "//" must not be read as a host: each resource has exactly one URL.
test("targets starting with // are 404, not an alias of /events", async () => {
  for (const path of ["//x/events", "//evil.example/events/1", "//events"]) {
    const res = await fetch(`${api.base}${path}`);
    assert.equal(res.status, 404, path);
  }
});

// RFC 9112: a server must accept the absolute-form request target.
test("absolute-form request target is still routed", async () => {
  const { port } = new URL(api.base);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: Number(port), path: "http://evil.example/events/1" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 200);
});
