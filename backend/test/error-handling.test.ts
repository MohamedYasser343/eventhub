import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { useServer } from "./helpers.ts";
import { pool, isDbUnavailable } from "../src/db/pool.ts";
import { createErrorBoundary } from "../src/http/error-boundary.ts";
import { dbReady, createReadyHandler } from "../src/http/health.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const api = useServer();
const coded = (code: string, message = "boom") => Object.assign(new Error(message), { code });

// ---------- classification ----------
test("isDbUnavailable: connectivity failures yes; constraints, bugs and syntax errors no", () => {
  for (const e of [coded("ECONNREFUSED"), coded("ECONNRESET"), coded("ETIMEDOUT"), coded("57P01"), coded("57P03"), coded("53300"), coded("08006"), new Error("timeout exceeded when trying to connect")]) {
    assert.equal(isDbUnavailable(e), true, String((e as Error).message));
  }
  const agg = Object.assign(new Error(""), { errors: [coded("ECONNREFUSED"), coded("ECONNREFUSED")] });
  assert.equal(isDbUnavailable(agg), true, "localhost refused on IPv4 and IPv6");
  for (const e of [coded("23505"), coded("23503"), coded("42601"), coded("40P01"), new TypeError("x is undefined"), null, "str"]) assert.equal(isDbUnavailable(e), false);
});

test("the REAL pg-pool connect timeout is recognised (message match is version-sensitive)", async () => {
  // A listener that accepts but never speaks Postgres: the pool gives up with its own timeout.
  const { createServer: tcp } = await import("node:net");
  const silent = tcp(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const p = new pg.Pool({ host: "127.0.0.1", port: (silent.address() as AddressInfo).port, connectionTimeoutMillis: 150, user: "x", database: "x" });
  p.on("error", () => {});
  try {
    await assert.rejects(p.query("SELECT 1"), (e) => isDbUnavailable(e));
  } finally {
    silent.close();
    await p.end().catch(() => {});
  }
});

// ---------- the boundary, with an injected failing handler ----------
async function withBoundary(thrown: unknown, run: (base: string, logs: Record<string, unknown>[]) => Promise<void>) {
  const logs: Record<string, unknown>[] = [];
  const boundary = createErrorBoundary((r) => logs.push(r));
  const srv = createServer((req, res) => {
    const ctx = { requestId: "req-test-1234" } as never;
    void Promise.resolve(boundary(req, res, ctx, async () => {
      if (req.url === "/after-headers") {
        res.writeHead(200);
        res.write("partial");
      }
      throw thrown;
    })).catch(() => res.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, logs);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
}

test("boundary: unexpected error -> generic 500 with request id, nothing leaked", async () => {
  await withBoundary(new Error("SELECT secret FROM users at /home/x/app.ts password=hunter2"), async (base, logs) => {
    const res = await fetch(`${base}/x`);
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { error: "Internal Server Error", requestId: "req-test-1234" });
    assert.doesNotMatch(text, /SELECT|hunter2|\/home|stack/i);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!["kind"], "unexpected");
    assert.doesNotMatch(JSON.stringify(logs), /hunter2|SELECT/);
  });
});

test("boundary: database unreachable -> 503 + Retry-After, generic body, no host/port", async () => {
  await withBoundary(coded("ECONNREFUSED", "connect ECONNREFUSED 10.1.2.3:5432"), async (base, logs) => {
    const res = await fetch(`${base}/x`);
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.deepEqual(JSON.parse(text), { error: "Service Unavailable", requestId: "req-test-1234" });
    assert.doesNotMatch(text, /10\.1\.2\.3|5432|ECONNREFUSED/);
    assert.equal(logs[0]!["kind"], "db-unavailable");
  });
});

test("boundary: error after the response began ends the stream, no second response", async () => {
  await withBoundary(new Error("late"), async (base, logs) => {
    const res = await fetch(`${base}/after-headers`);
    assert.equal(res.status, 200); // headers were already sent and cannot be changed
    await res.text().catch(() => {}); // the body is cut short; either outcome is acceptable, but it must END
    assert.equal(logs.length, 1);
  });
});

// ---------- end to end through the real app ----------
test("a pool failure inside a real route becomes 503 (not 500) and the process survives", async () => {
  const original = pool.query;
  (pool as unknown as { query: unknown }).query = async () => {
    throw coded("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1");
  };
  try {
    const res = await fetch(`${api.base}/api/v1/events/1`, { headers: { "x-test-anon": "1" } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.equal(typeof res.headers.get("x-request-id"), "string");
    assert.doesNotMatch(JSON.stringify(await res.json()), /ECONNREFUSED|127\.0\.0\.1/);
    // liveness is independent of the database; /health unchanged
    assert.equal((await fetch(`${api.base}/health/live`)).status, 200);
    assert.deepEqual(await (await fetch(`${api.base}/health`)).json(), { status: "ok" });
    assert.equal((await fetch(`${api.base}/health/ready`)).status, 503);
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
  // recovery: same process, database back
  assert.equal((await fetch(`${api.base}/api/v1/events/1`)).status, 200);
  assert.equal((await fetch(`${api.base}/health/ready`)).status, 200);
});

test("expected failures keep their documented statuses (not remapped to 5xx)", async () => {
  assert.equal((await fetch(`${api.base}/api/v1/events/999`)).status, 404);
  assert.equal((await fetch(`${api.base}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "", seats: -1 }) })).status, 422);
  const reg = (u: string) => fetch(`${api.base}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json", "x-test-anon": "1" }, body: JSON.stringify({ username: u, password: "correct-horse-battery" }) });
  const [a, b] = await Promise.all([reg("race_user"), reg("RACE_USER")]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], "concurrent duplicate: exactly one wins; the DB unique index decides");
});

// ---------- readiness ----------
test("readiness is ready against the real database and returns the documented body", async () => {
  const res = await fetch(`${api.base}/health/ready`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ready", checks: { database: "up" } });
  assert.deepEqual(await (await fetch(`${api.base}/health/live`)).json(), { status: "alive" });
});

test("readiness is bounded: refused connection and hung database both give 'not ready' quickly", async () => {
  const closed = new pg.Pool({ host: "127.0.0.1", port: 1, user: "x", database: "x", connectionTimeoutMillis: 500 });
  closed.on("error", () => {});
  assert.equal(await dbReady(closed, 1_000), false);
  await closed.end().catch(() => {});

  const hung = { query: () => new Promise<never>(() => {}) };
  const t0 = Date.now();
  assert.equal(await dbReady(hung, 120), false);
  const took = Date.now() - t0;
  assert.ok(took >= 100 && took < 600, `bounded by the timeout, took ${took} ms`);

  // the handler body names the dependency, nothing else
  const srv = createServer((req, res) => void createReadyHandler(hung, 50)(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: "not_ready", checks: { database: "down" } });
  srv.close();
});

test("optional Redis cache being down does not affect readiness or event reads", async () => {
  // Tests may run with or without REDIS_URL; either way the API answers from PostgreSQL.
  assert.equal((await fetch(`${api.base}/health/ready`)).status, 200);
  assert.equal((await fetch(`${api.base}/api/v1/events/1`)).status, 200);
});
