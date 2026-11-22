import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { gzipSync } from "node:zlib";
import type { EventItem } from "../src/server.ts";
import { dbEvents, resetEvents, SEED } from "./db.ts";
import { useServer } from "./helpers.ts";

const api = useServer();
let seed: EventItem[] = [];
before(() => {
  seed = structuredClone(SEED);
});
beforeEach(async () => {
  await resetEvents(seed);
});

const JSON_HEADERS = { "Content-Type": "application/json" };
const bearer = () => ({ Authorization: `Bearer ${api.adminToken}` });
const post = (body: BodyInit, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${api.base}/api/v1/events`, { method: "POST", headers, body });

// Raw HTTP so the test controls chunks, headers and aborts exactly.
function raw(
  path: string,
  headers: Record<string, string>,
  chunks: Buffer[],
  opts: { abort?: boolean } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(api.base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path, method: "POST", headers: { ...bearer(), ...headers } },
      (res) => {
        const out: Buffer[] = [];
        res.on("data", (c: Buffer) => out.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(out) }),
        );
      },
    );
    req.on("error", reject);
    (async () => {
      for (const c of chunks) {
        req.write(c);
        await new Promise((r) => setTimeout(r, 20)); // force separate TCP chunks
      }
      if (!opts.abort) req.end();
    })();
  });
}

test("Content-Length is the byte length, not the string length (Café)", async () => {
  const res = await post(JSON.stringify({ name: "Café Meetup ☕", seats: 30 }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), bytes.length);
  const text = bytes.toString("utf8");
  assert.ok(bytes.length > text.length, "multi-byte characters: more bytes than UTF-16 units");
  assert.equal((JSON.parse(text) as EventItem).name, "Café Meetup ☕");
});

test("a multi-byte character split across two TCP chunks survives", async () => {
  const body = Buffer.from(JSON.stringify({ name: "Café", seats: 1 }), "utf8");
  const cut = body.indexOf(0xc3) + 1; // between the two bytes of "é"
  const res = await raw("/api/v1/events", JSON_HEADERS_LEN(body), [body.subarray(0, cut), body.subarray(cut)]);
  assert.equal(res.status, 201);
  assert.equal((JSON.parse(res.body.toString("utf8")) as EventItem).name, "Café");
});
function JSON_HEADERS_LEN(body: Buffer) {
  return { ...JSON_HEADERS, "Content-Length": String(body.length) };
}

test("invalid UTF-8 is rejected with 400, never repaired to U+FFFD", async () => {
  const bad = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","seats":1}')]);
  const res = await post(bad);
  assert.equal(res.status, 400);
  assert.equal((await dbEvents()).length, seed.length);
});

test("a UTF-8 BOM is rejected (400)", async () => {
  const res = await post(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"A","seats":1}')]));
  assert.equal(res.status, 400);
});

test("charset other than utf-8 is 415; utf-8 (any case) is accepted", async () => {
  const body = JSON.stringify({ name: "Charset", seats: 1 });
  assert.equal((await post(body, { "Content-Type": "application/json; charset=latin1" })).status, 415);
  assert.equal((await post(body, { "Content-Type": "application/json; charset=UTF-8" })).status, 201);
});

test("Content-Encoding gzip is 415; the compressed bytes are never parsed", async () => {
  const gz = gzipSync(JSON.stringify({ name: "Zipped", seats: 1 }));
  const res = await post(gz, { ...JSON_HEADERS, "Content-Encoding": "gzip" });
  assert.equal(res.status, 415);
  assert.equal((await dbEvents()).length, seed.length);
});

test("empty body is 400; null, array and primitives are valid JSON but 422", async () => {
  assert.equal((await post("")).status, 400);
  for (const body of ["null", "[]", "42", '"text"', "true"]) {
    const res = await post(body);
    assert.equal(res.status, 422, body);
  }
  assert.equal((await dbEvents()).length, seed.length);
});

test("wrong field types are 422 (numeric string seats), syntax errors 400, no mutation", async () => {
  assert.equal((await post('{"name":"M","seats":"30"}')).status, 422);
  assert.equal((await post('{"name":"M",}')).status, 400);
  assert.equal((await dbEvents()).length, seed.length);
});

test("body of exactly 16384 bytes is accepted, 16385 is 413", async () => {
  const pad = (n: number) => {
    const base = '{"name":"Edge","seats":1}';
    return base + " ".repeat(n - base.length);
  };
  assert.equal(Buffer.byteLength(pad(16384)), 16384);
  assert.equal((await post(pad(16384))).status, 201);
  assert.equal((await post(pad(16385))).status, 413);
});

test("chunked body without Content-Length over the limit is 413 (declared size unknown)", async () => {
  const chunks = Array.from({ length: 5 }, () => Buffer.alloc(4096, 0x20));
  const res = await raw("/api/v1/events", { ...JSON_HEADERS, "Transfer-Encoding": "chunked" }, chunks);
  assert.equal(res.status, 413);
});

test("a client that aborts mid-body does not hang or mutate; server keeps serving", async () => {
  const url = new URL(api.base);
  await new Promise<void>((resolve) => {
    const req = request(
      { host: url.hostname, port: url.port, path: "/api/v1/events", method: "POST",
        headers: { ...bearer(), ...JSON_HEADERS, "Content-Length": "100" } },
    );
    req.on("error", () => resolve());
    req.write('{"name":"Abor');
    setTimeout(() => req.destroy(), 50);
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await dbEvents()).length, seed.length);
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
});

test("extra and internal fields are neither persisted nor returned", async () => {
  const res = await post(JSON.stringify({ id: 999, name: "Safe", seats: 5, role: "admin", ownerId: 7, __proto__: { x: 1 } }));
  assert.equal(res.status, 201);
  const created = (await res.json()) as EventItem;
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "seats"]);
  assert.notEqual(created.id, 999);
  assert.deepEqual(Object.keys((await dbEvents()).at(-1) ?? {}).sort(), ["id", "name", "seats"]);
});

test("PUT keeps the same boundary: bad UTF-8 is 400 and does not change the event", async () => {
  const res = await fetch(`${api.base}/api/v1/events/1`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: Buffer.from([0x7b, 0xff, 0x7d]),
  });
  assert.equal(res.status, 400);
  assert.deepEqual((await dbEvents())[0], seed[0]);
});
