import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createShutdown, installSignalHandlers, sleep } from "../src/lifecycle/shutdown.ts";
import { httpShutdownSteps } from "../src/lifecycle/http.ts";
import { parseServerConfig, parseWorkerConfig } from "../src/config.ts";
import { createReadyHandler } from "../src/http/health.ts";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createJobQueue, enqueueNotification, startWorker } from "../src/jobs/queue.ts";
import { MockEmailProvider } from "../src/jobs/notification.ts";

// ---------- helpers ----------
type Rec = { level: string; event: string; [k: string]: unknown };
const collector = () => {
  const lines: Rec[] = [];
  return { lines, log: (level: string, event: string, fields: Record<string, unknown> = {}) => void lines.push({ level, event, ...fields }), events: () => lines.map((l) => l.event) };
};

interface Proc {
  child: ChildProcess;
  logs: Rec[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  waitFor: (pred: (r: Rec) => boolean, ms?: number) => Promise<Rec>;
}
function run(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const logs: Rec[] = [];
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        logs.push(JSON.parse(line) as Rec);
      } catch {
        logs.push({ level: "raw", event: "raw", line });
      }
    }
  });
  child.stderr!.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((res) => child.on("exit", (code, signal) => res({ code, signal, at: Date.now() })));
  const waitFor = async (pred: (r: Rec) => boolean, ms = 15_000): Promise<Rec> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = logs.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error("timed out waiting for a log line");
      await sleep(20);
    }
  };
  return { child, logs, exited, waitFor };
}
const port = () => 30_000 + Math.floor(Math.random() * 20_000);
const names = (p: Proc) => p.logs.map((l) => l.event ?? "");

// A single request on a fresh connection that never reuses a socket.
function get(p: number, path: string): Promise<{ status: number; body: string; at: number }> {
  return new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port: p, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, at: Date.now() }));
      res.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
}
// Polls until a NEW connection is refused. A probe sent in the instant between kill() and the
// process handling the signal can still be accepted (or reset when the listener closes); that is
// the window, not a failure, so only the settled answer is returned.
const refused = async (p: number) => {
  let last: string | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      await get(p, "/x");
      last = "answered";
    } catch (e) {
      last = (e as { code?: string }).code;
      if (last === "ECONNREFUSED") return last;
    }
    await sleep(20);
  }
  return last;
};
const lab = (extra: Record<string, string> = {}) => {
  const p = port();
  return { p, proc: run(["test/lab/shutdown-slow-server.ts"], { LAB_PORT: String(p), ...extra }) };
};

// ---------- the coordinator (no processes) ----------
test("steps run in order, then exit(0) is called once, after the cleanup", async () => {
  const c = collector();
  const order: string[] = [];
  const codes: number[] = [];
  const s = createShutdown({ deadlineMs: 1_000, log: c.log, exit: (x) => (order.push("exit"), codes.push(x)), steps: [
    { name: "a", run: async () => void (await sleep(20), order.push("a")) },
    { name: "b", run: async () => void order.push("b") },
  ] });
  assert.equal(s.draining, false);
  const code = await s.trigger("SIGTERM");
  assert.equal(code, 0);
  assert.deepEqual(order, ["a", "b", "exit"]);
  assert.deepEqual(codes, [0]);
  assert.equal(s.draining, true);
  assert.deepEqual(c.events(), ["shutdown.signal_received", "shutdown.draining_started", "shutdown.step_done", "shutdown.step_done", "shutdown.complete"]);
});

test("repeated and concurrent signals start ONE sequence; the extras are logged and ignored", async () => {
  const c = collector();
  let runs = 0;
  let exits = 0;
  const s = createShutdown({ deadlineMs: 1_000, log: c.log, exit: () => void exits++, steps: [{ name: "slow", run: async () => void (runs++, await sleep(60)) }] });
  const results = await Promise.all([s.trigger("SIGTERM"), s.trigger("SIGINT"), s.trigger("SIGTERM")]);
  assert.deepEqual(results, [0, 0, 0]);
  assert.equal(runs, 1, "cleanup ran once");
  assert.equal(exits, 1, "exited once");
  assert.equal(c.events().filter((e) => e === "shutdown.signal_received").length, 1);
  assert.equal(c.events().filter((e) => e === "shutdown.signal_ignored").length, 2);
  await s.trigger("SIGTERM"); // even after completion
  assert.equal(runs, 1);
});

test("a failing step is recorded, later steps still run, outcome is non-zero, no error text is logged", async () => {
  const c = collector();
  const ran: string[] = [];
  const codes: number[] = [];
  const s = createShutdown({ deadlineMs: 1_000, log: c.log, exit: (x) => void codes.push(x), steps: [
    { name: "first", run: async () => void ran.push("first") },
    { name: "optional-cache", run: () => Promise.reject(new Error("connect ECONNREFUSED redis://:s3cret@10.0.0.9")) },
    { name: "last", run: async () => void ran.push("last") },
  ] });
  assert.equal(await s.trigger("SIGTERM"), 1);
  assert.deepEqual(ran, ["first", "last"]);
  assert.deepEqual(codes, [1]);
  const failed = c.lines.find((l) => l.event === "shutdown.step_failed")!;
  assert.equal(failed["step"], "optional-cache");
  assert.equal(failed["error"], "Error");
  assert.ok(!JSON.stringify(c.lines).includes("s3cret"), "the message (which could hold a password) never reaches the log");
});

test("deadline: a hung step is abandoned, onDeadline runs, exit(1) comes in time, the pending step is named", async () => {
  const c = collector();
  const codes: number[] = [];
  let killed = false;
  let laterRan = false;
  const s = createShutdown({
    deadlineMs: 150, log: c.log, exit: (x) => void codes.push(x), onDeadline: () => void (killed = true),
    steps: [{ name: "stuck", run: () => new Promise<void>(() => {}) }, { name: "never", run: async () => void (laterRan = true) }],
  });
  const t0 = Date.now();
  assert.equal(await s.trigger("SIGTERM"), 1);
  assert.ok(Date.now() - t0 < 1_000, "bounded by the deadline");
  assert.deepEqual(codes, [1]);
  assert.equal(killed, true);
  assert.equal(laterRan, false);
  assert.equal(c.lines.find((l) => l.event === "shutdown.deadline_exceeded")!["pendingStep"], "stuck");
});

test("a step that finishes AFTER the deadline cannot trigger a second exit or more steps", async () => {
  const codes: number[] = [];
  let later = false;
  const s = createShutdown({ deadlineMs: 50, log: () => {}, exit: (x) => void codes.push(x), steps: [
    { name: "late", run: () => sleep(150) }, { name: "after", run: async () => void (later = true) },
  ] });
  await s.trigger("SIGTERM");
  await sleep(250);
  assert.deepEqual(codes, [1]);
  assert.equal(later, false);
});

test("installSignalHandlers registers exactly SIGINT and SIGTERM (SIGKILL cannot be handled)", async () => {
  const seen: string[] = [];
  const handlers = new Map<string, () => void>();
  const fake = { on: (sig: string, fn: () => void) => (handlers.set(sig, fn), fake) } as unknown as NodeJS.Process;
  const s = createShutdown({ deadlineMs: 500, log: () => {}, exit: () => {}, steps: [{ name: "x", run: async () => void seen.push("ran") }] });
  installSignalHandlers(s, fake);
  assert.deepEqual([...handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
  handlers.get("SIGINT")!();
  await sleep(30);
  assert.deepEqual(seen, ["ran"]);
});

// ---------- HTTP steps, in-process (isolated server) ----------
test("http steps: in-flight request finishes, new connections are refused, close completes", async () => {
  const server = createServer((_req, res) => void setTimeout(() => res.end("done"), 300));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = (server.address() as AddressInfo).port;
  const inflight = get(p, "/slow");
  await sleep(50);
  const s = createShutdown({ deadlineMs: 3_000, log: () => {}, exit: () => {}, steps: httpShutdownSteps(server, 0) });
  const done = s.trigger("SIGTERM");
  await sleep(50);
  assert.equal(await refused(p), "ECONNREFUSED", "a new connection is not admitted after draining started");
  const res = await inflight;
  assert.equal(res.body, "done", "the request accepted before the signal completed");
  assert.equal(await done, 0);
});

test("http steps: shutdown with the listener not started resolves (signal before listen)", async () => {
  const server = createServer(() => {});
  const s = createShutdown({ deadlineMs: 500, log: () => {}, exit: () => {}, steps: httpShutdownSteps(server, 0) });
  assert.equal(await s.trigger("SIGINT"), 0);
});

test("http steps: an idle keep-alive connection does not hold the close open", async () => {
  const { Agent } = await import("node:http");
  const server = createServer((_req, res) => void res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = (server.address() as AddressInfo).port;
  const agent = new Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => httpRequest({ host: "127.0.0.1", port: p, agent }, (res) => void res.resume().on("end", resolve)).on("error", reject).end());
  const s = createShutdown({ deadlineMs: 3_000, log: () => {}, exit: () => {}, steps: httpShutdownSteps(server, 0) });
  const t0 = Date.now();
  assert.equal(await s.trigger("SIGTERM"), 0);
  assert.ok(Date.now() - t0 < 1_000, "closed promptly, not after the 5 s keep-alive timeout");
  agent.destroy();
});

test("readiness says draining (503) without touching the database; /health is unchanged", async () => {
  let queried = 0;
  const handler = createReadyHandler({ query: async () => void queried++ }, 1_000, () => true);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const res = await get((server.address() as AddressInfo).port, "/");
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { status: "draining" });
  assert.equal(queried, 0);
  server.close();
});

// ---------- configuration ----------
test("config: shutdown settings have defaults, bounds, and the drain delay must fit inside the deadline", () => {
  const base = { DATABASE_URL: "postgres://u:p@127.0.0.1/db" };
  const d = parseServerConfig({ ...base });
  assert.equal(d.shutdownTimeoutMs, 10_000);
  assert.equal(d.shutdownDrainDelayMs, 0);
  assert.equal(parseServerConfig({ ...base, SHUTDOWN_TIMEOUT_MS: "5000", SHUTDOWN_DRAIN_DELAY_MS: "1000" }).shutdownDrainDelayMs, 1_000);
  assert.throws(() => parseServerConfig({ ...base, SHUTDOWN_TIMEOUT_MS: "0" }), /SHUTDOWN_TIMEOUT_MS/);
  assert.throws(() => parseServerConfig({ ...base, SHUTDOWN_TIMEOUT_MS: "abc" }), /SHUTDOWN_TIMEOUT_MS/);
  assert.throws(() => parseServerConfig({ ...base, SHUTDOWN_TIMEOUT_MS: "1000", SHUTDOWN_DRAIN_DELAY_MS: "1000" }), /DRAIN_DELAY/);
  assert.equal(parseWorkerConfig({ QUEUE_REDIS_URL: "redis://127.0.0.1:1" }).shutdownTimeoutMs, 10_000);
  assert.throws(() => parseWorkerConfig({ QUEUE_REDIS_URL: "redis://127.0.0.1:1", SHUTDOWN_TIMEOUT_MS: "-5" }), /SHUTDOWN_TIMEOUT_MS/);
});

// ---------- real processes: isolated slow server ----------
test("process: slow request during SIGTERM completes, new work is refused, process exits 0", async () => {
  const { p, proc } = lab();
  await proc.waitFor((l) => l["lab"] === "listening");
  const sentAt = Date.now();
  const inflight = get(p, "/slow?ms=1500");
  await sleep(300);
  proc.child.kill("SIGTERM");
  assert.equal(await refused(p), "ECONNREFUSED");
  const res = await inflight;
  assert.deepEqual([res.status, res.body], [200, "done"]);
  assert.ok(res.at - sentAt >= 1_400, "it really waited for the slow handler");
  const exit = await proc.exited;
  assert.equal(exit.code, 0);
  assert.ok(exit.at >= res.at, "the process exited after the request finished");
  assert.deepEqual(names(proc).filter((e) => e.startsWith("shutdown.")), ["shutdown.signal_received", "shutdown.draining_started", "shutdown.step_done", "shutdown.step_done", "shutdown.complete"]);
});

test("process: SIGINT is handled like SIGTERM", async () => {
  const { proc } = lab();
  await proc.waitFor((l) => l["lab"] === "listening");
  proc.child.kill("SIGINT");
  assert.equal((await proc.exited).code, 0);
  assert.equal((await proc.waitFor((l) => l.event === "shutdown.signal_received"))["signal"], "SIGINT");
});

test("process: during the drain delay readiness reports draining and other routes get 503", async () => {
  const { p, proc } = lab({ SHUTDOWN_DRAIN_DELAY_MS: "800", SHUTDOWN_TIMEOUT_MS: "5000" });
  await proc.waitFor((l) => l["lab"] === "listening");
  proc.child.kill("SIGTERM");
  await proc.waitFor((l) => l.event === "shutdown.draining_started");
  const ready = await get(p, "/ready");
  assert.deepEqual([ready.status, JSON.parse(ready.body)], [503, { status: "draining" }]);
  const other = await get(p, "/anything");
  assert.equal(other.status, 503);
  assert.equal((await proc.exited).code, 0);
});

test("process: SIGINT then SIGTERM with work in flight runs ONE cleanup", async () => {
  const { p, proc } = lab();
  await proc.waitFor((l) => l["lab"] === "listening");
  const inflight = get(p, "/slow?ms=800");
  await sleep(150);
  proc.child.kill("SIGINT");
  await sleep(100);
  proc.child.kill("SIGTERM");
  assert.equal((await inflight).body, "done", "the second signal did not cut the request off");
  assert.equal((await proc.exited).code, 0);
  assert.equal(names(proc).filter((e) => e === "shutdown.signal_received").length, 1);
  assert.equal(names(proc).filter((e) => e === "shutdown.signal_ignored").length, 1);
  assert.equal(names(proc).filter((e) => e === "shutdown.complete").length, 1);
});

test("process: deadline exceeded -> bounded exit 1, the stuck request is cut and the log names the step", async () => {
  const { p, proc } = lab({ SHUTDOWN_TIMEOUT_MS: "500" });
  await proc.waitFor((l) => l["lab"] === "listening");
  const inflight = get(p, "/slow?ms=10000").then(() => "completed", (e: { code?: string }) => e.code ?? "error");
  await sleep(150);
  const t0 = Date.now();
  proc.child.kill("SIGTERM");
  const exit = await proc.exited;
  assert.equal(exit.code, 1);
  assert.ok(exit.at - t0 < 2_500, `exited ${exit.at - t0} ms after the signal, well before the 10 s request`);
  assert.equal(await inflight, "ECONNRESET");
  const rec = await proc.waitFor((l) => l.event === "shutdown.deadline_exceeded");
  assert.equal(rec["pendingStep"], "http-close");
  assert.ok(names(proc).includes("shutdown.forced_exit"));
});

test("process: a failing cleanup step does not stop the next one; exit code 1; no error text in logs", async () => {
  const { proc } = lab({ FAIL_STEP: "1" });
  await proc.waitFor((l) => l["lab"] === "listening");
  proc.child.kill("SIGTERM");
  assert.equal((await proc.exited).code, 1);
  assert.ok(names(proc).includes("lab.later_step_ran"));
  assert.equal(proc.logs.find((l) => l.event === "shutdown.step_failed")!["step"], "failing-cleanup");
  assert.ok(!JSON.stringify(proc.logs).includes("secret-host"));
});

// ---------- real processes: the actual API (src/server.ts) ----------
const api = (extra: Record<string, string> = {}) => {
  const p = port();
  return { p, proc: run(["src/server.ts"], { PORT: String(p), LOG_REQUESTS: "0", ...extra }) };
};

test("API process: SIGTERM with no active requests closes the listener, cache and pool, exits 0", async () => {
  const { p, proc } = api();
  await proc.waitFor((l) => l["line"] !== undefined && String(l["line"]).includes("listening"));
  assert.equal((await get(p, "/health")).status, 200);
  proc.child.kill("SIGTERM");
  assert.equal((await proc.exited).code, 0);
  assert.deepEqual(proc.logs.filter((l) => l.event === "shutdown.step_done").map((l) => l["step"]), ["http-close", "cache-close", "postgres-pool-end", "telemetry-flush"]);
  assert.equal(await refused(p), "ECONNREFUSED");
  assert.ok(!JSON.stringify(proc.logs).includes("postgres://"), "no connection string in lifecycle logs");
});

test("API process: SIGINT is handled; request logging stays off while lifecycle lines still appear", async () => {
  const { proc } = api();
  await proc.waitFor((l) => String(l["line"] ?? "").includes("listening"));
  proc.child.kill("SIGINT");
  assert.equal((await proc.exited).code, 0);
  assert.ok(names(proc).includes("shutdown.complete"));
  assert.ok(!names(proc).some((e) => e.startsWith("http.")), "LOG_REQUESTS=0 still means no request logs");
});

test("API process: after the signal /health/ready answers draining; /health/live is not special-cased", async () => {
  const { p, proc } = api({ SHUTDOWN_DRAIN_DELAY_MS: "800", SHUTDOWN_TIMEOUT_MS: "5000" });
  await proc.waitFor((l) => String(l["line"] ?? "").includes("listening"));
  assert.equal((await get(p, "/health/ready")).status, 200);
  proc.child.kill("SIGTERM");
  await proc.waitFor((l) => l.event === "shutdown.draining_started");
  const ready = await get(p, "/health/ready");
  assert.deepEqual([ready.status, JSON.parse(ready.body)], [503, { status: "draining" }]);
  assert.equal((await get(p, "/api/v1/events")).status, 503, "new work is not admitted while draining");
  assert.equal((await proc.exited).code, 0);
});

// ---------- real processes: the worker ----------
const qurl = process.env["QUEUE_REDIS_URL"];
const qopts = qurl ? {} : { skip: "TEST_QUEUE_REDIS_URL not set" };
const FAST = { attempts: 3, baseDelayMs: 50 };
const payload = (id: string, scenario?: string) => ({ version: 1 as const, notificationId: id, recipientRef: "synthetic-user-1", correlationId: "req-1", ...(scenario ? { scenario } : {}) });
const sent = async (id: string) => (await pool.query("SELECT 1 FROM mock_provider_sent WHERE idempotency_key = $1", [id])).rowCount;
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}
// Delivery rows are durable (dedup by id), so every run uses fresh ids instead of reusing "gs-1".
const uid = () => randomUUID().slice(0, 8);
const worker = (prefix: string, extra: Record<string, string> = {}) => run(["src/jobs/worker-main.ts"], { QUEUE_PREFIX: prefix, ...extra });

test("worker process: SIGTERM mid-job lets the job finish, fetches no new job, closes the pool after the job", qopts, async () => {
  await migrate(pool);
  const prefix = `eventhub-test-${randomUUID().slice(0, 8)}`;
  const queue = createJobQueue({ url: qurl!, prefix });
  const [id1, id2] = [`gs-${uid()}`, `gs-${uid()}`];
  try {
    await enqueueNotification(queue, payload(id1, "slow:1500"), FAST);
    await enqueueNotification(queue, payload(id2), FAST);
    const w = worker(prefix, { SHUTDOWN_TIMEOUT_MS: "8000" });
    await w.waitFor((l) => l.event === "job.active" && l["jobId"] === `notif-${id1}`);
    w.child.kill("SIGTERM");
    const exit = await w.exited;
    assert.equal(exit.code, 0);
    assert.equal(await (await queue.getJob(`notif-${id1}`))?.getState(), "completed", "the active job finished (its DB work had a live pool)");
    assert.equal(await sent(id1), 1);
    assert.equal(await (await queue.getJob(`notif-${id2}`))?.getState(), "waiting", "no new job was fetched after the signal");
    assert.equal(await sent(id2), 0);
    const steps = w.logs.filter((l) => l.event === "shutdown.step_done").map((l) => l["step"]);
    assert.deepEqual(steps, ["worker-close", "postgres-pool-end"], "handlers stopped before the pool closed");
    assert.ok(w.logs.findIndex((l) => l.event === "job.completed") < w.logs.findIndex((l) => l["step"] === "postgres-pool-end"));
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
});

test("worker process: repeated signals do not overlap, and an idle worker exits cleanly", qopts, async () => {
  const prefix = `eventhub-test-${randomUUID().slice(0, 8)}`;
  const w = worker(prefix);
  await w.waitFor((l) => l["worker"] === "started");
  w.child.kill("SIGINT");
  w.child.kill("SIGTERM");
  assert.equal((await w.exited).code, 0);
  assert.equal(names(w).filter((e) => e === "shutdown.complete").length, 1);
  assert.equal(names(w).filter((e) => e === "shutdown.signal_ignored").length, 1);
});

test("worker process: deadline exceeded exits 1 within the budget; the job is recovered by stalled-job handling with ONE recorded effect", qopts, async () => {
  await migrate(pool);
  const prefix = `eventhub-test-${randomUUID().slice(0, 8)}`;
  const queue = createJobQueue({ url: qurl!, prefix });
  const idDl = `gs-dl-${uid()}`;
  const recovery = { current: undefined as ReturnType<typeof startWorker> | undefined };
  try {
    await enqueueNotification(queue, payload(idDl, "slow:4000"), FAST);
    const w = worker(prefix, { SHUTDOWN_TIMEOUT_MS: "500", WORKER_LOCK_MS: "1000", WORKER_STALLED_MS: "500" });
    await w.waitFor((l) => l.event === "job.active");
    const t0 = Date.now();
    w.child.kill("SIGTERM");
    const exit = await w.exited;
    assert.equal(exit.code, 1);
    assert.ok(exit.at - t0 < 2_500, "bounded by the deadline, not by the 4 s job");
    assert.equal((await w.waitFor((l) => l.event === "shutdown.deadline_exceeded"))["pendingStep"], "worker-close");
    assert.equal(await sent(idDl), 0, "the effect had not happened yet when the process was cut");
    recovery.current = startWorker({ url: qurl!, db: pool, prefix, provider: new MockEmailProvider(pool), log: () => {}, lockDurationMs: 1_000, stalledIntervalMs: 500 });
    await until(async () => (await (await queue.getJob(`notif-${idDl}`))?.getState()) === "completed");
    assert.equal(await sent(idDl), 1, "durable queue state + idempotency, not the shutdown handler, protect the effect");
  } finally {
    await recovery.current?.close(true).catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
});

