import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";
import pg from "pg";
import { pool } from "../src/db/pool.ts";
import { log, logSettings, logSink } from "../src/observability/logger.ts";
import {
  clearRecentSpans,
  flushSpans,
  m,
  MAX_PENDING_SPANS,
  MAX_SERIES,
  pendingSpanCount,
  recentSpans,
  renderMetrics,
  resetMetrics,
  resetSpanExporter,
  setSpanExporter,
  tracer,
  withSpan,
} from "../src/observability/otel.ts";
import { runInScope } from "../src/observability/scope.ts";
import { PgEventRepository } from "../src/modules/events/repository.ts";
import { ConfigError, parseServerConfig, parseWorkerConfig } from "../src/config.ts";
import { telemetryLogger } from "../src/jobs/queue.ts";
import { useServer, userToken } from "./helpers.ts";

// Lecture 18: telemetry is checked as OBSERVABLE BEHAVIOR (log lines, Prometheus text, finished
// OpenTelemetry spans), against the real server + PostgreSQL. Faults are injected only in the test
// process (a patched pool.query); nothing here is a production switch.
const api = useServer();

let lines: string[] = [];
const records = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
const realQuery = pool.query.bind(pool);
const prevWrite = logSink.write;

beforeEach(async () => {
  resetSpanExporter();
  await flushSpans(); // spans of earlier activity (server start, logins) must not leak into this test
  lines = [];
  logSink.write = (l) => lines.push(l);
  logSettings.level = "debug";
  resetMetrics();
  clearRecentSpans();
  resetSpanExporter();
});
afterEach(() => {
  (pool as { query: unknown }).query = realQuery;
  logSink.write = prevWrite;
  logSettings.level = "info";
});
after(() => {
  resetSpanExporter();
});

// ---------- helpers ----------
const settle = async () => {
  await flushSpans();
  await new Promise((r) => setTimeout(r, 20));
};
const failDb = () => {
  (pool as { query: unknown }).query = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432 password=hunter2"), { code: "ECONNREFUSED" });
  };
};
const slowDb = (ms: number) => {
  (pool as { query: unknown }).query = async (...a: unknown[]) => {
    await new Promise((r) => setTimeout(r, ms));
    return (realQuery as (...x: unknown[]) => unknown)(...a);
  };
};
const heal = () => void ((pool as { query: unknown }).query = realQuery);

// Reads one sample from the Prometheus text: name + a subset of labels -> value (0 if absent).
type Sample = { name: string; labels: Record<string, string>; value: number };
function parse(text: string): Sample[] {
  return text
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const m2 = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(l)!;
      const labels = Object.fromEntries([...(m2[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1]!, x[2]!]));
      return { name: m2[1]!, labels, value: Number(m2[3]) };
    });
}
const value = (text: string, name: string, labels: Record<string, string> = {}): number =>
  parse(text).filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v)).reduce((a, s) => a + s.value, 0);
const series = (text: string, name: string): number => parse(text).filter((s) => s.name === name).length;

const DUR = "http_server_request_duration";
const EVENT_ROUTE = { http_request_method: "GET", http_route: "/api/v1/events/:id" };

test("successful request: one structured record, response id == log id, metrics and trace update", async () => {
  const res = await fetch(`${api.base}/api/v1/events/1`, { headers: { "X-Request-Id": "req-obs-0001" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "req-obs-0001");
  await settle();

  const done = records().filter((r) => r["event"] === "request.completed");
  assert.equal(done.length, 1);
  const r = done[0]!;
  assert.equal(r["requestId"], "req-obs-0001");
  assert.equal(r["route"], "/api/v1/events/:id");
  assert.equal(r["status"], 200);
  assert.equal(r["level"], "info");
  assert.equal(r["service"], "api");
  assert.match(String(r["timestamp"]), /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(typeof r["durationMs"], "number");

  const text = await renderMetrics();
  assert.equal(value(text, `${DUR}_count`, { ...EVENT_ROUTE, http_response_status_class: "2xx" }), 1);
  assert.equal(value(text, "http_server_active_requests"), 0);

  const root = recentSpans().find((s) => s.server)!;
  const child = recentSpans().find((s) => s.name === "db.events.findById")!;
  assert.equal(root.traceId, r["traceId"]);
  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentId, root.spanId);
  assert.equal(root.status, "ok");
  assert.equal(root.name, "GET /api/v1/events/:id");
  assert.equal(root.attributes["http.route"], "/api/v1/events/:id");
  assert.equal(root.attributes["http.response.status_code"], 200);
});

test("4xx outcomes keep their contract, are INFO (expected), and leak nothing from the request", async () => {
  const anon = await fetch(`${api.base}/api/v1/auth/me`, { headers: { "x-test-anon": "1", Authorization: "Bearer not-a-real-token-abcdef" } });
  assert.equal(anon.status, 401);
  const bad = await fetch(`${api.base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-anon": "1", Cookie: "session=cookie-secret-9999" },
    body: JSON.stringify({ username: "nobody", password: "synthetic-password-12345" }),
  });
  assert.ok(bad.status === 401 || bad.status === 400 || bad.status === 422);
  const nf = await fetch(`${api.base}/api/v1/events/987654`);
  assert.equal(nf.status, 404);
  await settle();

  const all = lines.join("\n") + (await renderMetrics()) + JSON.stringify(recentSpans());
  assert.doesNotMatch(all, /not-a-real-token|synthetic-password|cookie-secret|Bearer/i);
  const levels = records().filter((r) => r["event"] === "request.completed").map((r) => r["level"]);
  assert.deepEqual([...new Set(levels)], ["info"]);
});

test("secret redaction: sensitive keys are masked at any depth; strings cannot forge extra log lines", () => {
  log("info", "test.redaction", {
    password: "pw-1",
    nested: { authorization: "Bearer abc", deep: { apiKey: "k-1", ok: "visible" } },
    cookie: "c-1",
    note: 'line one\n{"level":"error","event":"forged"}',
    err: new Error("SELECT * FROM users WHERE password='x'"),
  });
  assert.equal(lines.length, 1);
  const text = lines[0]!;
  assert.doesNotMatch(text, /pw-1|Bearer abc|k-1|c-1|SELECT/);
  const r = JSON.parse(text) as Record<string, any>;
  assert.equal(r["password"], "[REDACTED]");
  assert.equal(r["nested"].deep.ok, "visible");
  assert.equal(r["err"], "Error");
  assert.equal(r["event"], "test.redaction");
});

test("LOG_LEVEL threshold: warn drops debug and info, error is never dropped", () => {
  logSettings.level = "warn";
  log("debug", "d");
  log("info", "i");
  log("warn", "w");
  log("error", "e");
  assert.deepEqual(records().map((r) => r["event"]), ["w", "e"]);
});

test("LOG_LEVEL is validated by the configuration module (lecture 17)", () => {
  assert.equal(parseServerConfig({}).logLevel, "info");
  assert.equal(parseServerConfig({ LOG_LEVEL: "debug" }).logLevel, "debug");
  assert.throws(() => parseServerConfig({ LOG_LEVEL: "verbose" }), (e) => e instanceof ConfigError && e.problems[0] === "LOG_LEVEL must be one of: debug, info, warn, error");
  assert.throws(() => parseServerConfig({ LOG_LEVEL: "" }), ConfigError);
  assert.equal(parseWorkerConfig({ QUEUE_REDIS_URL: "redis://127.0.0.1:1" }).logLevel, "info");
});

test("database failure: safe 503, ONE classified error log, failed db span under a failed root span", async () => {
  failDb();
  const res = await fetch(`${api.base}/api/v1/events/987001`);
  heal();
  const body = await res.text();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  assert.doesNotMatch(body, /ECONNREFUSED|hunter2|10\.0\.0\.9/);
  await settle();

  const boundary = records().filter((r) => r["event"] === "request.dependency_unavailable");
  assert.equal(boundary.length, 1, "logged once at the boundary, not once per layer");
  assert.equal(boundary[0]!["kind"], "db-unavailable");
  assert.equal(boundary[0]!["requestId"], res.headers.get("x-request-id"));
  assert.doesNotMatch(lines.join("\n") + JSON.stringify(recentSpans()), /ECONNREFUSED|hunter2|10\.0\.0\.9/);

  const root = recentSpans().find((s) => s.server)!;
  const db = recentSpans().find((s) => s.name === "db.events.findById")!;
  assert.equal(db.status, "error");
  assert.equal(db.attributes["error.type"], "Error");
  assert.equal(db.parentId, root.spanId);
  assert.equal(db.traceId, boundary[0]!["traceId"]);
  assert.equal(root.status, "error");
  assert.equal(root.attributes["http.response.status_code"], 503);
  const text = await renderMetrics();
  assert.equal(value(text, `${DUR}_count`, { ...EVENT_ROUTE, http_response_status_class: "5xx" }), 1);
  assert.equal(value(text, "http_server_active_requests"), 0);
});

test("slow dependency: shows up in the latency distribution and in the db span, not only an average", async () => {
  slowDb(150);
  await fetch(`${api.base}/api/v1/events/987002`);
  heal();
  for (let i = 0; i < 4; i++) await fetch(`${api.base}/api/v1/events/987002`);
  await settle();

  const text = await renderMetrics();
  const labels = { ...EVENT_ROUTE, http_response_status_class: "4xx" };
  assert.equal(value(text, `${DUR}_count`, labels), 5);
  // cumulative buckets: how many requests finished within 0.1 s vs in total
  const within100ms = value(text, `${DUR}_bucket`, { ...labels, le: "0.1" });
  assert.ok(within100ms >= 4 && within100ms < 5, `finished within 0.1 s: ${within100ms} of 5`);
  assert.equal(value(text, `${DUR}_bucket`, { ...labels, le: "+Inf" }), 5);

  const dbs = recentSpans().filter((s) => s.name === "db.events.findById");
  const slowest = dbs.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));
  const root = recentSpans().find((s) => s.spanId === slowest.parentId)!;
  assert.ok(slowest.durationMs >= 140, `db span ${slowest.durationMs}`);
  assert.ok(root.durationMs >= slowest.durationMs, "root contains its child");
  assert.ok(slowest.durationMs / root.durationMs > 0.8, "the db span is where the time went");
});

test("concurrent requests: distinct ids, no mixing of log lines or spans between them", async () => {
  slowDb(20);
  const ids = Array.from({ length: 25 }, () => `req-${randomUUID()}`);
  const results = await Promise.all(ids.map((id, i) => fetch(`${api.base}/api/v1/events/${987100 + (i % 5)}`, { headers: { "X-Request-Id": id } })));
  heal();
  assert.ok(results.every((r, i) => r.headers.get("x-request-id") === ids[i]));
  await settle();

  const done = records().filter((r) => r["event"] === "request.completed");
  assert.equal(done.length, 25);
  assert.equal(new Set(done.map((r) => r["traceId"])).size, 25, "every request has its own trace");
  const roots = recentSpans().filter((s) => s.server);
  const dbs = recentSpans().filter((s) => s.name === "db.events.findById");
  assert.equal(roots.length, 25);
  assert.equal(dbs.length, 25);
  for (const d of dbs) assert.equal(roots.find((r) => r.spanId === d.parentId)!.traceId, d.traceId, "a db span is parented to ITS request's root");
  assert.equal(value(await renderMetrics(), "http_server_active_requests"), 0);
});

test("cardinality: 40 different event ids and random 404 paths stay within a few bounded series", async () => {
  for (let i = 0; i < 40; i++) await fetch(`${api.base}/api/v1/events/${987200 + i}`);
  for (let i = 0; i < 20; i++) await fetch(`${api.base}/no/such/path/${randomUUID()}?token=secret-${i}`);
  const text = await renderMetrics();
  assert.doesNotMatch(text, /98720\d|no\/such|secret-/);
  assert.equal(value(text, `${DUR}_count`, { ...EVENT_ROUTE, http_response_status_class: "4xx" }), 40);
  assert.equal(value(text, `${DUR}_count`, { http_route: "unmatched", http_response_status_class: "4xx" }), 20);
  assert.equal(series(text, `${DUR}_count`), 2);
  assert.doesNotMatch(lines.join("\n"), /secret-\d/, "query string never logged");
});

test("a runaway attribute is capped by the SDK: series stop growing and fold into one overflow series", async () => {
  for (let i = 0; i < 1_000; i++) m.jobAttempts.add(1, { type: `leak-${i}`, outcome: "completed" });
  const text = await renderMetrics();
  assert.ok(series(text, "eventhub_job_attempts_total") <= MAX_SERIES + 1, `series: ${series(text, "eventhub_job_attempts_total")}`);
  assert.ok(value(text, "eventhub_job_attempts_total", { otel_metric_overflow: "true" }) >= 800);
});

test("unusual methods collapse to OTHER", async () => {
  await fetch(`${api.base}/health`, { method: "PURGE" }).catch(() => {});
  assert.doesNotMatch(await renderMetrics(), /PURGE/);
});

test("client abort: counted once as aborted, active requests return to 0, no 5xx recorded", async () => {
  slowDb(400);
  const ac = new AbortController();
  const p = fetch(`${api.base}/api/v1/events/987300`, { signal: ac.signal }).catch(() => "aborted");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(value(await renderMetrics(), "http_server_active_requests"), 1);
  ac.abort();
  assert.equal(await p, "aborted");
  await new Promise((r) => setTimeout(r, 500));
  heal();
  const text = await renderMetrics();
  assert.equal(value(text, "http_server_active_requests"), 0);
  assert.equal(value(text, `${DUR}_count`, { ...EVENT_ROUTE, http_response_status_class: "aborted" }), 1);
  assert.equal(value(text, `${DUR}_count`), 1, "duration measured once");
  assert.ok(records().some((r) => r["event"] === "request.aborted"));
});

test("traceparent: a well-formed one continues the trace; malformed or all-zero is ignored; not echoed", async () => {
  const tid = randomBytes(16).toString("hex");
  const pid = randomBytes(8).toString("hex");
  const ok = await fetch(`${api.base}/health`, { headers: { traceparent: `00-${tid}-${pid}-01`, tracestate: "vendor=secret" } });
  assert.equal(ok.headers.get("traceparent"), null);
  assert.equal(ok.headers.get("tracestate"), null);
  const zero = await fetch(`${api.base}/health`, { headers: { traceparent: `00-${"0".repeat(32)}-${pid}-01` } });
  const junk = await fetch(`${api.base}/health`, { headers: { traceparent: "x".repeat(500) } });
  assert.equal(zero.status, 200);
  assert.equal(junk.status, 200);
  await settle();
  const roots = recentSpans().filter((s) => s.server);
  assert.equal(roots.length, 3);
  assert.equal(roots[0]!.traceId, tid);
  assert.equal(roots[0]!.parentId, pid);
  assert.notEqual(roots[1]!.traceId, "0".repeat(32));
  assert.equal(roots[1]!.parentId, undefined);
  assert.equal(roots[2]!.parentId, undefined);
  assert.equal(records().find((r) => r["traceId"] === tid)?.["event"], "request.completed", "the log line carries the continued trace id");
});

test("/internal/metrics: 401 without a session, 403 for a non-admin, text exposition for an admin", async () => {
  assert.equal((await fetch(`${api.base}/internal/metrics`, { headers: { "x-test-anon": "1" } })).status, 401);
  const attendee = await userToken(api.base, "attendee");
  assert.equal((await fetch(`${api.base}/internal/metrics`, { headers: { Authorization: `Bearer ${attendee.token}` } })).status, 403);
  await fetch(`${api.base}/api/v1/events/1`);
  const res = await fetch(`${api.base}/internal/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const text = await res.text();
  assert.match(text, /# TYPE http_server_request_duration histogram/);
  assert.equal(value(text, `${DUR}_count`, { ...EVENT_ROUTE, http_response_status_class: "2xx" }), 1);
  assert.doesNotMatch(text, new RegExp(attendee.token));
});

test("exporter unavailable: stalled and failing sinks never block requests; pending spans stay bounded; drops are counted", async () => {
  setSpanExporter(() => new Promise(() => {})); // never resolves
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${api.base}/health`)).status, 200);
  assert.ok(Date.now() - t0 < 2_000, "requests were not slowed by the dead sink");

  for (let i = 0; i < MAX_PENDING_SPANS * 3; i++) tracer.startSpan("flood", {}, context.active()).end();
  assert.ok(pendingSpanCount() <= MAX_PENDING_SPANS, `pending ${pendingSpanCount()}`);
  assert.ok(value(await renderMetrics(), "eventhub_telemetry_dropped_total", { signal: "span" }) > 0);
  assert.equal((await fetch(`${api.base}/health`)).status, 200);

  // let the stuck batches time out (bounded: 1 s each), then a throwing sink
  resetSpanExporter();
  await flushSpans();
  setSpanExporter(() => {
    throw new Error("sink down");
  });
  resetMetrics();
  await fetch(`${api.base}/health`);
  await flushSpans();
  assert.ok(value(await renderMetrics(), "eventhub_telemetry_dropped_total", { signal: "span" }) >= 1, "a failed batch is dropped and counted");
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
  resetSpanExporter();
  await flushSpans();
  for (let i = 0; i < 40 && pendingSpanCount() > 0; i++) await new Promise((r) => setTimeout(r, 100)); // a stuck batch is abandoned by its 1 s timeout
  assert.equal(pendingSpanCount(), 0);
});

test("a throwing log sink cannot fail the operation it logs", async () => {
  logSink.write = () => {
    throw new Error("disk full");
  };
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
});

test("repository span outside a request is a plain call (no active span, no new span, no error)", async () => {
  const repo = new PgEventRepository(pool);
  await settle();
  clearRecentSpans();
  assert.equal((await repo.findById(1))?.id, 1);
  await settle();
  assert.equal(recentSpans().length, 0);
});

test("repository span under a parent with an unreachable database: error span, original error unchanged", async () => {
  const dead = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:1/x", connectionTimeoutMillis: 300 });
  dead.on("error", () => {});
  const repo = new PgEventRepository(dead);
  const parent = tracer.startSpan("parent");
  await assert.rejects(context.with(trace.setSpan(context.active(), parent), () => runInScope({ requestId: "req-x" }, () => repo.findById(1))));
  parent.end();
  await dead.end().catch(() => {});
  await settle();
  const s = recentSpans().find((x) => x.name === "db.events.findById")!;
  assert.equal(s.status, "error");
  assert.equal(s.parentId, parent.spanContext().spanId);
  assert.equal(s.traceId, parent.spanContext().traceId);
});

test("withSpan re-throws the original error object unchanged", async () => {
  const parent = tracer.startSpan("p");
  const boom = new TypeError("original");
  await assert.rejects(context.with(trace.setSpan(context.active(), parent), () => withSpan("x", {}, async () => Promise.reject(boom))), (e) => e === boom);
  parent.end();
});

// ---------- worker telemetry (pure: the job events are synthetic) ----------
test("worker telemetry: attempts, outcome and duration are logged and counted with bounded labels", async () => {
  telemetryLogger({ jobId: "notif-a1", type: "ticket_confirmation", state: "active", attempt: 1, durationMs: 0, correlationId: "req-77" });
  telemetryLogger({ jobId: "notif-a1", type: "ticket_confirmation", state: "retry_scheduled", attempt: 1, durationMs: 12, correlationId: "req-77", reason: "TransientProviderError: provider unavailable (503)" });
  telemetryLogger({ jobId: "notif-a1", type: "ticket_confirmation", state: "completed", attempt: 2, durationMs: 8, correlationId: "req-77" });
  telemetryLogger({ jobId: "notif-b2", type: "ticket_confirmation", state: "failed", attempt: 1, durationMs: 3, reason: "PermanentProviderError: recipient rejected by provider" });

  const recs = records();
  assert.deepEqual(recs.map((r) => r["event"]), ["job.active", "job.retry_scheduled", "job.completed", "job.failed"]);
  assert.deepEqual(recs.map((r) => r["level"]), ["info", "warn", "info", "error"]);
  assert.equal(recs[1]!["correlationId"], "req-77");
  assert.equal(recs[1]!["attempt"], 1);

  const text = await renderMetrics();
  const t = { type: "ticket_confirmation" };
  assert.equal(value(text, "eventhub_job_attempts_total", { ...t, outcome: "retry_scheduled" }), 1);
  assert.equal(value(text, "eventhub_job_attempts_total", { ...t, outcome: "completed" }), 1);
  assert.equal(value(text, "eventhub_job_attempts_total", { ...t, outcome: "failed" }), 1);
  assert.equal(value(text, "eventhub_job_attempts_total", { ...t, outcome: "active" }), 0, "'active' is a start, not an outcome");
  assert.equal(value(text, "eventhub_job_attempt_duration_count", t), 3);
  assert.doesNotMatch(text, /notif-a1|notif-b2|req-77/, "job and correlation ids are log fields, never metric labels");
});
