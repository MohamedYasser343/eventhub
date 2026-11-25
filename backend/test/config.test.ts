import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseCacheConfig, parseDatabaseConfig, parseQueueConfig, parseServerConfig, parseWorkerConfig } from "../src/config.ts";

const DB = "postgres://u:pw@127.0.0.1:5432/x";
const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
  assert.fail("expected ConfigError");
};

test("PORT: default when absent; abc, 0, 99999, empty and 8e3 are rejected (no silent fallback)", () => {
  assert.equal(parseServerConfig({}).port, 8080);
  assert.equal(parseServerConfig({ PORT: "65535" }).port, 65535);
  for (const bad of ["abc", "0", "99999", "", "8e3", " 80", "-1", "80.5"]) {
    assert.deepEqual(problems(() => parseServerConfig({ PORT: bad })), ["PORT must be a whole number from 1 to 65535"], JSON.stringify(bad));
  }
});

test("booleans: only exact true/false; the string \"false\" is not truthy; typos rejected", () => {
  assert.equal(parseCacheConfig({}).enabled, true);
  assert.equal(parseCacheConfig({ CACHE_ENABLED: "true" }).enabled, true);
  assert.equal(parseCacheConfig({ CACHE_ENABLED: "false" }).enabled, false);
  for (const bad of ["TRUE", "yes", "1", "0", "", "flase"]) {
    assert.deepEqual(problems(() => parseCacheConfig({ CACHE_ENABLED: bad })), ["CACHE_ENABLED must be exactly true or false"], JSON.stringify(bad));
  }
  assert.equal(parseServerConfig({ LOG_REQUESTS: "0" }).logRequests, false);
  assert.equal(parseServerConfig({ LOG_REQUESTS: "1" }).logRequests, true);
  assert.deepEqual(problems(() => parseServerConfig({ LOG_REQUESTS: "true" })), ["LOG_REQUESTS must be 0 or 1"]);
});

test("DATABASE_URL: required, must be a postgres URL, absent differs from empty", () => {
  assert.equal(parseDatabaseConfig({ DATABASE_URL: DB }).databaseUrl, DB);
  assert.deepEqual(problems(() => parseDatabaseConfig({})), ["DATABASE_URL is required"]);
  assert.deepEqual(problems(() => parseDatabaseConfig({ DATABASE_URL: "" })), ["DATABASE_URL must be a postgres:// or postgresql:// URL"]);
  assert.deepEqual(problems(() => parseDatabaseConfig({ DATABASE_URL: "mysql://u:pw@h/db" })), ["DATABASE_URL must be a postgres:// or postgresql:// URL"]);
});

test("sentinel secrets never appear in a validation error", () => {
  const S = "SENTINEL-s3cr3t-value";
  for (const fn of [
    () => parseDatabaseConfig({ DATABASE_URL: `mysql://user:${S}@h/db` }),
    () => parseDatabaseConfig({ DATABASE_URL: S }),
    () => parseCacheConfig({ REDIS_URL: `http://:${S}@h` }),
    () => parseWorkerConfig({ QUEUE_REDIS_URL: `${S}` }),
    () => parseServerConfig({ PORT: S, CORS_ORIGIN: S }),
  ]) {
    try {
      fn();
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(S) && !String(e.stack).includes(S), "message leaks the value");
    }
  }
});

test("cache flag: disabled cache ignores a broken or missing REDIS_URL; enabled validates it", () => {
  assert.deepEqual(parseCacheConfig({ CACHE_ENABLED: "false", REDIS_URL: "garbage" }), { enabled: false, redisUrl: undefined, ttlSeconds: 60 });
  assert.equal(parseCacheConfig({}).redisUrl, undefined); // unset endpoint = run without cache (lecture 13 behavior kept)
  assert.equal(parseCacheConfig({ REDIS_URL: "redis://127.0.0.1:6379" }).redisUrl, "redis://127.0.0.1:6379");
  assert.deepEqual(problems(() => parseCacheConfig({ REDIS_URL: "garbage" })), ["REDIS_URL must be a redis:// or rediss:// URL"]);
  assert.deepEqual(problems(() => parseCacheConfig({ REDIS_URL: "" })), ["REDIS_URL must be a redis:// or rediss:// URL"]);
  assert.deepEqual(problems(() => parseCacheConfig({ CACHE_TTL_SECONDS: "0" })), ["CACHE_TTL_SECONDS must be a whole number from 1 to 86400"]);
});

test("worker/queue: required queue Redis, strict numbers, all problems reported together", () => {
  assert.deepEqual(problems(() => parseQueueConfig({})), ["QUEUE_REDIS_URL is required"]);
  const ok = parseWorkerConfig({ QUEUE_REDIS_URL: "redis://127.0.0.1:1", WORKER_CONCURRENCY: "4", MOCK_ALLOW_CRASH: "1" });
  assert.equal(ok.concurrency, 4);
  assert.equal(ok.mockAllowCrash, true);
  assert.equal(ok.lockDurationMs, undefined);
  assert.deepEqual(
    problems(() => parseWorkerConfig({ QUEUE_REDIS_URL: "nope", WORKER_CONCURRENCY: "0", WORKER_LOCK_MS: "abc", QUEUE_NAME: "bad name!" })),
    [
      "QUEUE_REDIS_URL must be a redis:// or rediss:// URL",
      "QUEUE_NAME must be 1-100 characters of A-Z a-z 0-9 . _ -",
      "WORKER_LOCK_MS must be a whole number from 1 to 3600000",
      "WORKER_CONCURRENCY must be a whole number from 1 to 1000",
    ],
  );
});

test("APP_ENV and cross-field rule: demo seeding is refused in production", () => {
  assert.equal(parseServerConfig({}).appEnv, "development");
  assert.deepEqual(problems(() => parseServerConfig({ APP_ENV: "prod" })), ["APP_ENV must be one of: development, test, production"]);
  assert.deepEqual(problems(() => parseServerConfig({ APP_ENV: "production", SEED_DEMO_USERS: "1" })), ["SEED_DEMO_USERS must be 0 when APP_ENV=production"]);
  assert.deepEqual(problems(() => parseServerConfig({ CORS_ORIGIN: "http://x.test/path" })), ["CORS_ORIGIN must be an http(s) origin such as http://localhost:3000 (no path)"]);
});

test("the parser reads only the object it is given (no hidden process.env access)", () => {
  const before = process.env["PORT"];
  process.env["PORT"] = "not-a-port";
  try {
    assert.equal(parseServerConfig({ PORT: "9000" }).port, 9000);
  } finally {
    if (before === undefined) delete process.env["PORT"];
    else process.env["PORT"] = before;
  }
});

// ---------- startup behavior in real subprocesses ----------
interface Run {
  code: number | null;
  out: string;
  stop: () => Promise<void>;
}
// Minimal clean environment: nothing inherited from the developer's shell or .env.
function run(args: string[], env: Record<string, string>, readyText?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() });
    let out = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      resolve({ code, out, stop: async () => {} });
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (readyText && !done && out.includes(readyText)) {
        done = true;
        resolve({ code: null, out, stop: () => new Promise((r) => { child.once("exit", () => r()); child.kill("SIGTERM"); }) });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => finish(code));
    setTimeout(() => { if (!done) { child.kill("SIGKILL"); finish(-1); } }, 15_000).unref();
  });
}
const portNum = () => 20_000 + Math.floor(Math.random() * 20_000);
const goodDb = process.env["DATABASE_URL"]!; // set by test/setup.ts: the _test database

test("API: missing DATABASE_URL exits non-zero, names the key, never listens", async () => {
  const r = await run(["src/server.ts"], { PORT: String(portNum()) }, "listening");
  assert.equal(r.code, 1);
  assert.match(r.out, /DATABASE_URL is required/);
  assert.doesNotMatch(r.out, /listening/);
});

test("API: PORT=abc and PORT= (empty) exit non-zero without listening", async () => {
  for (const bad of ["abc", "99999", ""]) {
    const r = await run(["src/server.ts"], { DATABASE_URL: goodDb, PORT: bad }, "listening");
    assert.equal(r.code, 1, `PORT=${bad}`);
    assert.match(r.out, /PORT must be a whole number from 1 to 65535/);
    assert.doesNotMatch(r.out, /listening/);
  }
});

test("API: a malformed DATABASE_URL error does not echo the value (sentinel)", async () => {
  const S = "SENTINEL-p4ssw0rd";
  const r = await run(["src/server.ts"], { DATABASE_URL: `mysql://u:${S}@h/db` }, "listening");
  assert.equal(r.code, 1);
  assert.match(r.out, /DATABASE_URL must be a postgres/);
  assert.ok(!r.out.includes(S), "output leaks the sentinel");
});

test("API: valid settings start; optional port absent would use the default (covered by parser test)", async () => {
  const port = portNum();
  const r = await run(["src/server.ts"], { DATABASE_URL: goodDb, PORT: String(port), CACHE_ENABLED: "false" }, "listening");
  try {
    assert.match(r.out, new RegExp(`listening on http://127.0.0.1:${port}`));
  } finally {
    await r.stop();
  }
});

test("precedence: real environment beats the .env file; the file is a fallback; restart picks up edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eventhub-cfg-"));
  const file = join(dir, "x.env");
  const [pFile, pEnv, pEdited] = [portNum(), portNum() + 1, portNum() + 2];
  const base = { DATABASE_URL: goodDb, CACHE_ENABLED: "false" };
  // 1. file only -> file value
  writeFileSync(file, `PORT=${pFile}\n`);
  let r = await runNodeFlag(file, { ...base });
  try { assert.match(r.out, new RegExp(`:${pFile}\\b`), "file value used when env has no PORT"); } finally { await r.stop(); }
  // 2. env + file -> env wins
  r = await runNodeFlag(file, { ...base, PORT: String(pEnv) });
  try { assert.match(r.out, new RegExp(`:${pEnv}\\b`), "process environment overrides the file"); } finally { await r.stop(); }
  // 3. edit the file while a process runs: that process is unchanged; a restart sees the edit
  r = await runNodeFlag(file, { ...base });
  writeFileSync(file, `PORT=${pEdited}\n`);
  try { assert.match(r.out, new RegExp(`:${pFile}\\b`), "running process keeps its snapshot"); } finally { await r.stop(); }
  r = await runNodeFlag(file, { ...base });
  try { assert.match(r.out, new RegExp(`:${pEdited}\\b`), "restart loads the edited file"); } finally { await r.stop(); }
});
function runNodeFlag(file: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--env-file=${file}`, "--import", "tsx", "src/server.ts"], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("listening")) resolve({ code: null, out, stop: () => new Promise((r) => { child.once("exit", () => r()); child.kill("SIGTERM"); }) });
    });
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out, stop: async () => {} }));
  });
}

test("worker: invalid queue settings exit before connecting or consuming", async () => {
  for (const [env, re] of [
    [{ DATABASE_URL: goodDb }, /QUEUE_REDIS_URL is required/],
    [{ DATABASE_URL: goodDb, QUEUE_REDIS_URL: "redis://127.0.0.1:1", WORKER_CONCURRENCY: "0" }, /WORKER_CONCURRENCY must be a whole number/],
    [{ DATABASE_URL: goodDb, QUEUE_REDIS_URL: "not-a-url" }, /QUEUE_REDIS_URL must be a redis/],
  ] as const) {
    const r = await run(["src/jobs/worker-main.ts"], { ...env }, "worker");
    assert.equal(r.code, 1);
    assert.match(r.out, re);
    assert.doesNotMatch(r.out, /"worker":"started"/);
  }
});

test("valid-looking but unreachable database is NOT a config error: it starts, readiness answers 503", async () => {
  const port = portNum();
  const r = await run(["src/server.ts"], { DATABASE_URL: "postgres://u:pw@127.0.0.1:1/x", PORT: String(port), CACHE_ENABLED: "false" }, "listening");
  try {
    assert.match(r.out, /listening/);
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(res.status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  } finally {
    await r.stop();
  }
});
