import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { events, server } from "../src/server.ts";
import { useServer } from "./helpers.ts";

const api = useServer();

const ORIGIN = "http://localhost:3000"; // default CORS_ORIGIN
const OTHER = "http://127.0.0.1:3000";

// ---------- HEAD ----------

test("HEAD /events has GET's status and headers but no body", async () => {
  const get = await fetch(`${api.base}/events`);
  const head = await fetch(`${api.base}/events`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), get.headers.get("content-type"));
  assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
  assert.ok(Number(head.headers.get("content-length")) > 0);
});

test("HEAD /events/1, /health and a missing event mirror GET without a body", async () => {
  const one = await fetch(`${api.base}/events/1`, { method: "HEAD" });
  assert.equal(one.status, 200);
  assert.equal(await one.text(), "");
  assert.ok(one.headers.get("etag"));
  assert.equal((await fetch(`${api.base}/health`, { method: "HEAD" })).status, 200);
  const missing = await fetch(`${api.base}/events/999`, { method: "HEAD" });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "");
});

// ---------- OPTIONS ----------

test("OPTIONS /events returns 204, Allow and no body", async () => {
  const res = await fetch(`${api.base}/events`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("OPTIONS /events/1 returns the item Allow list", async () => {
  const res = await fetch(`${api.base}/events/1`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), "GET, HEAD, PUT, DELETE, OPTIONS");
});

// ---------- 405 vs 404 ----------

test("unknown method on a known resource is 405 with Allow; unknown path is 404", async () => {
  const known = await fetch(`${api.base}/events`, { method: "PATCH" });
  assert.equal(known.status, 405);
  assert.equal(known.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  assert.equal((await fetch(`${api.base}/nope`, { method: "PATCH" })).status, 404);
  assert.equal((await fetch(`${api.base}/nope`)).status, 404);
  assert.equal((await fetch(`${api.base}/health`, { method: "POST" })).status, 405);
});

// ---------- CORS ----------

test("preflight from the allowed origin gets the Allow-* headers", async () => {
  const res = await fetch(`${api.base}/events`, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("access-control-allow-methods"), "GET, HEAD, POST, OPTIONS");
  assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, If-None-Match");
  assert.equal(res.headers.get("access-control-max-age"), "600");
  assert.match(res.headers.get("vary") ?? "", /Origin/);
});

test("preflight approves PUT and DELETE on an item for the allowed origin", async () => {
  for (const method of ["PUT", "DELETE"]) {
    const res = await fetch(`${api.base}/events/1`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": method },
    });
    assert.equal(res.status, 204, method);
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN, method);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", new RegExp("\\b" + method + "\\b"), method);
  }
});

test("preflight for a method the resource does not support is not approved", async () => {
  const res = await fetch(`${api.base}/events`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "DELETE" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-methods"), null);
});

test("preflight from another origin gets no CORS approval", async () => {
  const res = await fetch(`${api.base}/events`, {
    method: "OPTIONS",
    headers: { Origin: OTHER, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-methods"), null);
  assert.match(res.headers.get("vary") ?? "", /Origin/);
});

test("actual responses carry ACAO and exposed headers only for the allowed origin", async () => {
  const ok = await fetch(`${api.base}/events`, { headers: { Origin: ORIGIN } });
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(ok.headers.get("access-control-expose-headers"), "Location, ETag");
  assert.equal(ok.headers.get("vary"), "Origin");

  const err = await fetch(`${api.base}/events/999`, { headers: { Origin: ORIGIN } });
  assert.equal(err.status, 404);
  assert.equal(err.headers.get("access-control-allow-origin"), ORIGIN);

  const denied = await fetch(`${api.base}/events`, { headers: { Origin: OTHER } });
  assert.equal(denied.status, 200); // the server still answers; the browser blocks reading it
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(denied.headers.get("vary"), "Origin");

  const noOrigin = await fetch(`${api.base}/events`);
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
});

test("origin matching is exact (no wildcard, no prefix, no 'null')", async () => {
  for (const origin of ["http://localhost:3000/", "http://localhost:30001", "null", "*", "HTTP://LOCALHOST:3000"]) {
    const res = await fetch(`${api.base}/events`, { headers: { Origin: origin } });
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
  }
});

// ---------- ETag ----------

test("GET /events/1 returns a quoted strong ETag; matching If-None-Match gets 304 without a body", async () => {
  const first = await fetch(`${api.base}/events/1`);
  const etag = first.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);
  assert.equal(first.status, 200);
  await first.text();

  const again = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": etag! } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);
});

test("If-None-Match: lists, weak form and * are matched; other values are not", async () => {
  const etag = (await fetch(`${api.base}/events/1`)).headers.get("etag")!;
  for (const header of [`"nope", ${etag}`, `W/${etag}`, "*"]) {
    const res = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": header } });
    assert.equal(res.status, 304, header);
  }
  const miss = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": '"nope"' } });
  assert.equal(miss.status, 200);
});

test("after the event changes the old validator no longer matches", async () => {
  const original = structuredClone(events.find((e) => e.id === 1)!);
  try {
    const etag = (await fetch(`${api.base}/events/1`)).headers.get("etag")!;
    const put = await fetch(`${api.base}/events/1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Changed For ETag", seats: 1 }),
    });
    assert.equal(put.status, 200);

    const res = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 200);
    const newEtag = res.headers.get("etag");
    assert.notEqual(newEtag, etag);
    assert.equal((await res.json() as { name: string }).name, "Changed For ETag");

    const cond = await fetch(`${api.base}/events/1`, { headers: { "If-None-Match": newEtag! } });
    assert.equal(cond.status, 304);
  } finally {
    const index = events.findIndex((e) => e.id === 1);
    events[index] = original;
  }
});

test("a missing event has no ETag and never returns 304", async () => {
  const res = await fetch(`${api.base}/events/999`, { headers: { "If-None-Match": "*" } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("etag"), null);
});

// ---------- Connection reuse ----------

function requestOnce(agent: http.Agent, path: string, headers: http.OutgoingHttpHeaders = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = http.request({ host: "127.0.0.1", port, path, agent, headers }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
}

async function connectionsFor(fn: (agent: http.Agent) => Promise<void>, keepAlive: boolean): Promise<number> {
  let count = 0;
  const onConnection = () => count++;
  server.on("connection", onConnection);
  const agent = new http.Agent({ keepAlive });
  try {
    await fn(agent);
  } finally {
    agent.destroy();
    server.off("connection", onConnection);
  }
  return count;
}

test("sequential requests on a keep-alive agent reuse one connection", async () => {
  const count = await connectionsFor(async (agent) => {
    await requestOnce(agent, "/health");
    await requestOnce(agent, "/events");
    await requestOnce(agent, "/events/1");
  }, true);
  assert.equal(count, 1);
});

test("Connection: close forces a new connection per request", async () => {
  const count = await connectionsFor(async (agent) => {
    await requestOnce(agent, "/health", { Connection: "close" });
    await requestOnce(agent, "/events", { Connection: "close" });
    await requestOnce(agent, "/events/1", { Connection: "close" });
  }, false);
  assert.equal(count, 3);
});
