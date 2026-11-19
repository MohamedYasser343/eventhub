import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { events, server } from "../src/server.ts";
import type { EventItem } from "../src/server.ts";
import { useServer } from "./helpers.ts";

const api = useServer();

let seed: EventItem[] = [];

before(() => {
  seed = structuredClone(events);
});

beforeEach(() => {
  events.splice(0, events.length, ...structuredClone(seed));
});

function put(path: string, body: string, contentType: string | null = "application/json") {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["Content-Type"] = contentType;
  return fetch(`${api.base}${path}`, { method: "PUT", headers, body });
}

const snapshot = () => JSON.stringify(events);

// ---------- PUT ----------

test("PUT replaces an existing event and returns 200 with it", async () => {
  const res = await put("/events/1", JSON.stringify({ name: "Renamed", seats: 7 }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { id: 1, name: "Renamed", seats: 7 });

  const fetched = await fetch(`${api.base}/events/1`);
  assert.deepEqual(await fetched.json(), { id: 1, name: "Renamed", seats: 7 });
  assert.deepEqual(events.find((e) => e.id === 2), seed.find((e) => e.id === 2));
  assert.equal(events.length, seed.length);
});

test("repeating an identical PUT leaves the same state (idempotent)", async () => {
  const body = JSON.stringify({ name: "Same", seats: 5 });
  const first = await put("/events/1", body);
  const afterFirst = snapshot();
  const second = await put("/events/1", body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(snapshot(), afterFirst);
  assert.deepEqual(await first.json(), await second.json());
});

test("PUT ignores an id in the body and trims the name", async () => {
  const res = await put("/events/1", JSON.stringify({ id: 5, name: "  Pad  ", seats: 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 1, name: "Pad", seats: 1 });
  assert.ok(!events.some((e) => e.id === 5));
});

test("PUT on a missing event returns 404 and creates nothing", async () => {
  const res = await put("/events/999", JSON.stringify({ name: "Ghost", seats: 1 }));
  assert.equal(res.status, 404);
  assert.equal(snapshot(), JSON.stringify(seed));
});

test("PUT checks existence before the body (404 even for invalid body)", async () => {
  assert.equal((await put("/events/999", JSON.stringify({ name: "", seats: -1 }))).status, 404);
  assert.equal((await put("/events/999", "{")).status, 404);
  assert.equal((await put("/events/999", "x", "text/plain")).status, 404);
});

test("PUT with invalid data returns 422 without mutation", async () => {
  for (const body of [{}, { name: "A" }, { seats: 1 }, { name: "", seats: 1 }, { name: "A", seats: -1 }, { name: "A", seats: 1.5 }, null, []]) {
    const res = await put("/events/1", JSON.stringify(body));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  assert.equal(snapshot(), JSON.stringify(seed));
});

test("PUT with malformed JSON, wrong Content-Type or huge body is rejected without mutation", async () => {
  assert.equal((await put("/events/1", "{")).status, 400);
  assert.equal((await put("/events/1", JSON.stringify({ name: "A", seats: 1 }), "text/plain")).status, 415);
  assert.equal((await put("/events/1", JSON.stringify({ name: "A", seats: 1, pad: "x".repeat(20000) }))).status, 413);
  assert.equal(snapshot(), JSON.stringify(seed));
});

// The handler checks the event exists, waits for the body, then looks it up
// again. This deletes the event in between and expects 404, not a ghost update.
test("PUT returns 404 if the event is deleted while its body is still arriving", async () => {
  const { port } = new URL(api.base);
  const body = JSON.stringify({ name: "Raced", seats: 5 });
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: "PUT",
        path: "/events/1",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${api.adminToken}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    // Registered after the server's own handler, so when this runs the PUT
    // handler has already passed its existence check and is waiting for the body.
    server.once("request", () => {
      void fetch(`${api.base}/events/1`, { method: "DELETE" }).then(() => req.end(body.slice(10)));
    });
    req.write(body.slice(0, 10));
  });
  assert.equal(status, 404);
  assert.ok(!events.some((e) => e.id === 1));
  assert.equal(events.length, seed.length - 1);
});

// ---------- DELETE ----------

test("DELETE removes the event and returns 204 with no body", async () => {
  const res = await fetch(`${api.base}/events/1`, { method: "DELETE" });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("content-type"), null);
  assert.ok(!events.some((e) => e.id === 1));
  assert.equal((await fetch(`${api.base}/events/1`)).status, 404);
  assert.equal(events.length, seed.length - 1);
});

test("repeated DELETE: 204 then 404, resource stays absent", async () => {
  assert.equal((await fetch(`${api.base}/events/1`, { method: "DELETE" })).status, 204);
  const afterFirst = snapshot();
  assert.equal((await fetch(`${api.base}/events/1`, { method: "DELETE" })).status, 404);
  assert.equal(snapshot(), afterFirst);
});

test("DELETE on a missing event returns 404 and changes nothing", async () => {
  const res = await fetch(`${api.base}/events/999`, { method: "DELETE" });
  assert.equal(res.status, 404);
  assert.equal(snapshot(), JSON.stringify(seed));
});

test("DELETE ignores any request body", async () => {
  const res = await fetch(`${api.base}/events/1`, {
    method: "DELETE",
    headers: { "Content-Type": "text/plain" },
    body: "ignored",
  });
  assert.equal(res.status, 204);
  assert.ok(!events.some((e) => e.id === 1));
});

test("DELETE with non-canonical ids returns 404 and deletes nothing", async () => {
  for (const bad of ["abc", "01", "1/", "0"]) {
    const res = await fetch(`${api.base}/events/${bad}`, { method: "DELETE" });
    assert.equal(res.status, 404, bad);
  }
  assert.equal(snapshot(), JSON.stringify(seed));
});

test("a deleted id is not reused by a later POST", async () => {
  const created = (await (
    await fetch(`${api.base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Temp", seats: 1 }),
    })
  ).json()) as EventItem;
  assert.equal((await fetch(`${api.base}/events/${created.id}`, { method: "DELETE" })).status, 204);
  const next = (await (
    await fetch(`${api.base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Next", seats: 1 }),
    })
  ).json()) as EventItem;
  assert.ok(next.id > created.id);
});
