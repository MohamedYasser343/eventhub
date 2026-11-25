// Lecture 17: ONE place that turns raw environment strings into a typed, validated snapshot.
//
// Precedence (highest first): real process environment > local .env file > defaults below.
// The .env file is loaded by Node itself (`--env-file-if-exists`, see package.json), which never
// overrides a variable that is already set, so this module only ever sees the merged result.
//
// Rules: absent => documented default (or "required" error); PRESENT BUT EMPTY or malformed =>
// error (never a silent fallback). Error messages name the KEY and the rule, never the value:
// values may carry passwords (connection URLs).

import { LOG_LEVELS } from "./observability/logger.ts";
import type { LogLevel } from "./observability/logger.ts";

type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

// Collects every problem instead of stopping at the first one, so one restart fixes them all.
class Reader {
  readonly problems: string[] = [];
  constructor(private readonly env: Env) {}

  private raw(key: string): string | undefined {
    return this.env[key]; // undefined = absent; "" = supplied but empty (rejected by each parser)
  }
  private fail<T>(key: string, rule: string, fallback: T): T {
    this.problems.push(`${key} ${rule}`);
    return fallback;
  }

  string(key: string, fallback: string, ok: (v: string) => boolean, rule: string): string {
    const v = this.raw(key);
    if (v === undefined) return fallback;
    return v !== "" && ok(v) ? v : this.fail(key, rule, fallback);
  }
  optionalString(key: string, ok: (v: string) => boolean, rule: string): string | undefined {
    const v = this.raw(key);
    if (v === undefined) return undefined;
    return v !== "" && ok(v) ? v : this.fail(key, rule, undefined);
  }
  requiredString(key: string, ok: (v: string) => boolean, rule: string): string {
    const v = this.raw(key);
    if (v === undefined) return this.fail(key, "is required", "");
    return v !== "" && ok(v) ? v : this.fail(key, rule, "");
  }
  int(key: string, fallback: number, min: number, max: number): number {
    return this.optInt(key, min, max) ?? fallback;
  }
  optInt(key: string, min: number, max: number): number | undefined {
    const v = this.raw(key);
    if (v === undefined) return undefined;
    const n = /^\d+$/.test(v) ? Number(v) : NaN; // digits only: no "", " 5", "1e3", "-1", "0x10"
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : this.fail(key, `must be a whole number from ${min} to ${max}`, undefined);
  }
  // "true"/"false" only: the string "false" is truthy in JS, and typos must not silently enable things.
  bool(key: string, fallback: boolean): boolean {
    const v = this.raw(key);
    if (v === undefined) return fallback;
    if (v === "true") return true;
    if (v === "false") return false;
    return this.fail(key, "must be exactly true or false", fallback);
  }
  // Legacy switches kept from earlier lectures (LOG_REQUESTS=1, SEED_DEMO_USERS=1, ...).
  flag01(key: string): boolean {
    const v = this.raw(key);
    if (v === undefined || v === "0") return false;
    if (v === "1") return true;
    return this.fail(key, "must be 0 or 1", false);
  }
  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const v = this.raw(key);
    if (v === undefined) return fallback;
    return (allowed as readonly string[]).includes(v) ? (v as T) : this.fail(key, `must be one of: ${allowed.join(", ")}`, fallback);
  }

  done<T>(value: T): T {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
    return value;
  }
}

const urlWithScheme = (schemes: readonly string[]) => (v: string) => {
  try {
    return schemes.includes(new URL(v).protocol);
  } catch {
    return false;
  }
};
const isPostgresUrl = urlWithScheme(["postgres:", "postgresql:"]);
const isRedisUrl = urlWithScheme(["redis:", "rediss:"]);
const isHttpOrigin = (v: string) => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === v; // origin only: no path
  } catch {
    return false;
  }
};

export const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

// ---------- database (API, worker, migrate, seed) ----------
export interface DatabaseConfig {
  databaseUrl: string;
}
export function parseDatabaseConfig(env: Env): DatabaseConfig {
  const r = new Reader(env);
  const databaseUrl = r.requiredString("DATABASE_URL", isPostgresUrl, "must be a postgres:// or postgresql:// URL");
  return r.done({ databaseUrl });
}

// ---------- cache (lecture 13) + its feature flag ----------
export interface CacheConfig {
  /** CACHE_ENABLED flag. false: no cache object, no Redis connection, REDIS_URL not even read. */
  enabled: boolean;
  /** undefined => no cache (same as before this lecture: unset REDIS_URL means "run without cache"). */
  redisUrl: string | undefined;
  ttlSeconds: number;
}
export function parseCacheConfig(env: Env): CacheConfig {
  const r = new Reader(env);
  const enabled = r.bool("CACHE_ENABLED", true);
  const ttlSeconds = r.int("CACHE_TTL_SECONDS", 60, 1, 86_400);
  // A disabled cache must not be blocked by a broken or missing endpoint.
  const redisUrl = enabled ? r.optionalString("REDIS_URL", isRedisUrl, "must be a redis:// or rediss:// URL") : undefined;
  return r.done({ enabled, redisUrl, ttlSeconds });
}

// ---------- HTTP server ----------
export interface ServerConfig {
  appEnv: AppEnv;
  port: number;
  corsOrigin: string;
  logRequests: boolean;
  logLevel: LogLevel;
  seedDemoUsers: boolean;
}
export function parseServerConfig(env: Env): ServerConfig {
  const r = new Reader(env);
  const appEnv = r.oneOf("APP_ENV", APP_ENVS, "development");
  const port = r.int("PORT", 8080, 1, 65_535);
  const corsOrigin = r.string("CORS_ORIGIN", "http://localhost:3000", isHttpOrigin, "must be an http(s) origin such as http://localhost:3000 (no path)");
  const logRequests = r.flag01("LOG_REQUESTS");
  const logLevel = r.oneOf("LOG_LEVEL", LOG_LEVELS, "info");
  const seedDemoUsers = r.flag01("SEED_DEMO_USERS");
  // Cross-field rule: demo users have generated passwords printed to stdout; never in production.
  if (appEnv === "production" && seedDemoUsers) r.problems.push("SEED_DEMO_USERS must be 0 when APP_ENV=production");
  return r.done({ appEnv, port, corsOrigin, logRequests, logLevel, seedDemoUsers });
}

// ---------- queue producer / worker (lecture 14; its OWN Redis, never the cache's) ----------
export interface QueueConfig {
  queueRedisUrl: string;
  queueName: string | undefined; // undefined => queue.ts default
  queuePrefix: string | undefined;
}
export interface WorkerConfig extends QueueConfig {
  mockAllowCrash: boolean;
  lockDurationMs: number | undefined;
  stalledIntervalMs: number | undefined;
  concurrency: number | undefined;
  logLevel: LogLevel;
}
const readQueue = (r: Reader): QueueConfig => ({
  queueRedisUrl: r.requiredString("QUEUE_REDIS_URL", isRedisUrl, "must be a redis:// or rediss:// URL"),
  queueName: r.optionalString("QUEUE_NAME", (v) => /^[A-Za-z0-9._-]{1,100}$/.test(v), "must be 1-100 characters of A-Z a-z 0-9 . _ -"),
  queuePrefix: r.optionalString("QUEUE_PREFIX", (v) => /^[A-Za-z0-9._-]{1,100}$/.test(v), "must be 1-100 characters of A-Z a-z 0-9 . _ -"),
});
export function parseQueueConfig(env: Env): QueueConfig {
  const r = new Reader(env);
  return r.done(readQueue(r));
}
export function parseWorkerConfig(env: Env): WorkerConfig {
  const r = new Reader(env);
  const queue = readQueue(r);
  const cfg: WorkerConfig = {
    ...queue,
    mockAllowCrash: r.flag01("MOCK_ALLOW_CRASH"),
    lockDurationMs: r.optInt("WORKER_LOCK_MS", 1, 3_600_000),
    stalledIntervalMs: r.optInt("WORKER_STALLED_MS", 1, 3_600_000),
    concurrency: r.optInt("WORKER_CONCURRENCY", 1, 1_000),
    logLevel: r.oneOf("LOG_LEVEL", LOG_LEVELS, "info"),
  };
  return r.done(cfg);
}

// Entry-point helper: on invalid configuration print the key-level problems (no values) and exit 1
// BEFORE anything listens or consumes jobs. Library code uses the parse* functions and gets a throw.
export function loadConfig<T>(parse: (env: Env) => T, env: Env = process.env): T {
  try {
    return parse(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${err.message}\nSee backend/.env.example. Exiting.`);
      process.exit(1);
    }
    throw err;
  }
}
