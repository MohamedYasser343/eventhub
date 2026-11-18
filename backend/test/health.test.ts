import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { server } from "../src/server.ts";

let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test("GET /health returns 200 JSON", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /health returns 405 with Allow", async () => {
  const res = await fetch(`${base}/health`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("unknown path returns 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
