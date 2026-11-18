import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers.ts";

const api = useServer();

test("GET /health returns 200 JSON", async () => {
  const res = await fetch(`${api.base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /health returns 405 with Allow", async () => {
  const res = await fetch(`${api.base}/health`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("unknown path returns 404", async () => {
  const res = await fetch(`${api.base}/nope`);
  assert.equal(res.status, 404);
});
