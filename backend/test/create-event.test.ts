import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { events, server } from "../src/server.ts";
import type { EventItem } from "../src/server.ts";

let base = "";
let seed: EventItem[] = [];

before(async () => {
  seed = structuredClone(events);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  events.splice(0, events.length, ...structuredClone(seed));
});

after(() => {
  server.close();
});

function post(body: string, contentType: string | null = "application/json") {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["Content-Type"] = contentType;
  return fetch(`${base}/events`, { method: "POST", headers, body });
}

test("valid POST returns 201, Location, JSON body and stores the event", async () => {
  const res = await post(JSON.stringify({ name: "Synthetic Concert", seats: 50 }));
  assert.equal(res.status, 201);
  const created = (await res.json()) as EventItem;
  assert.equal(res.headers.get("location"), `/events/${created.id}`);
  assert.deepEqual(created, { id: created.id, name: "Synthetic Concert", seats: 50 });
  assert.equal(events.length, seed.length + 1);

  const fetched = await fetch(`${base}/events/${created.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), created);
});

test("repeating the same POST creates distinct events (not idempotent)", async () => {
  const payload = JSON.stringify({ name: "Synthetic Repeat", seats: 10 });
  const a = (await (await post(payload)).json()) as EventItem;
  const b = (await (await post(payload)).json()) as EventItem;
  assert.notEqual(a.id, b.id);
  assert.equal(events.length, seed.length + 2);
});

test("name is trimmed, extra fields (including id) are ignored", async () => {
  const res = await post(JSON.stringify({ id: 999, name: "  Padded  ", seats: 0, x: 1 }));
  assert.equal(res.status, 201);
  const created = (await res.json()) as EventItem;
  assert.notEqual(created.id, 999);
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "seats"]);
  assert.equal(created.name, "Padded");
});

test("ids are not reused after the last event is removed", async () => {
  const a = (await (await post(JSON.stringify({ name: "A", seats: 1 }))).json()) as EventItem;
  events.pop();
  const b = (await (await post(JSON.stringify({ name: "B", seats: 1 }))).json()) as EventItem;
  assert.ok(b.id > a.id);
});

test("boundary values are accepted", async () => {
  assert.equal((await post(JSON.stringify({ name: "x".repeat(100), seats: 100000 }))).status, 201);
  assert.equal((await post(JSON.stringify({ name: "x", seats: 0 }))).status, 201);
});

test("unsupported or missing Content-Type returns 415 without mutation", async () => {
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", null]) {
    const res = await post(JSON.stringify({ name: "N", seats: 1 }), ct);
    // fetch sets text/plain for string bodies when no header is given
    assert.equal(res.status, 415, String(ct));
  }
  assert.equal(events.length, seed.length);
});

test("Content-Type parameters and casing are accepted", async () => {
  const res = await post(JSON.stringify({ name: "N", seats: 1 }), "Application/JSON; charset=utf-8");
  assert.equal(res.status, 201);
});

test("malformed JSON returns 400 without mutation", async () => {
  for (const body of ["{", "", "not json", '{"name": "A", "seats": }']) {
    const res = await post(body);
    assert.equal(res.status, 400, body);
  }
  assert.equal(events.length, seed.length);
});

test("valid JSON with invalid data returns 422 without mutation", async () => {
  const bad: unknown[] = [
    null,
    [],
    "str",
    42,
    {},
    { name: "A" },
    { seats: 1 },
    { name: "", seats: 1 },
    { name: "   ", seats: 1 },
    { name: "x".repeat(101), seats: 1 },
    { name: 5, seats: 1 },
    { name: "A", seats: -1 },
    { name: "A", seats: 1.5 },
    { name: "A", seats: "5" },
    { name: "A", seats: null },
    { name: "A", seats: 100001 },
  ];
  for (const body of bad) {
    const res = await post(JSON.stringify(body));
    assert.equal(res.status, 422, JSON.stringify(body));
    const json = (await res.json()) as { details: string[] };
    assert.ok(json.details.length > 0);
  }
  assert.equal(events.length, seed.length);
});

test("body over 16 KB returns 413 (declared length) without mutation", async () => {
  const res = await post(JSON.stringify({ name: "A", seats: 1, pad: "x".repeat(20000) }));
  assert.equal(res.status, 413);
  assert.equal(events.length, seed.length);
});

test("body over 16 KB returns 413 when streamed without Content-Length", async () => {
  const chunk = new TextEncoder().encode("x".repeat(4096));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 8; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const res = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    // @ts-expect-error duplex is required by Node for streaming bodies
    duplex: "half",
  });
  assert.equal(res.status, 413);
  assert.equal(events.length, seed.length);
});

test("PUT /events still returns 405 with Allow: GET, POST", async () => {
  const res = await fetch(`${base}/events`, { method: "PUT" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
});
