import { createClient } from "redis";
import { loadConfig, parseCacheConfig } from "./config.ts";

// Generic string cache (lecture 13). It is an OPTIMIZATION, never a source of truth:
// every caller must be able to carry on without it. Implementations may throw (cache
// down, timeout); callers decide the fallback.
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  // Test/maintenance helper: SCAN + DEL of one key prefix only (never FLUSHALL).
  deletePrefix(prefix: string): Promise<void>;
}

// Used when REDIS_URL is not set: every read is a miss, writes are dropped.
export const noCache: Cache = {
  get: async () => null,
  set: async () => {},
  del: async () => {},
  deletePrefix: async () => {},
};

// A command that has not finished in this many ms is abandoned (the caller falls back
// to the database). Redis on localhost answers in well under a millisecond.
export const DEFAULT_CACHE_TIMEOUT_MS = 100;

export class RedisCache implements Cache {
  private readonly client;

  constructor(url: string, private readonly timeoutMs = DEFAULT_CACHE_TIMEOUT_MS) {
    this.client = createClient({
      url,
      // While disconnected, commands fail at once instead of queueing without bound.
      disableOfflineQueue: true,
      // Bounded exponential backoff (50 ms .. 2 s), reconnecting in the background:
      // recovery needs no restart and there is no tight retry loop.
      socket: { connectTimeout: 500, reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 2_000) },
    });
    // An unhandled 'error' event would crash the process. Never log the URL: it may hold a password.
    this.client.on("error", () => {});
    // Idle sockets must not keep a finished process (e.g. a test file) alive.
    this.client.unref();
    // Lazy and non-blocking: the server starts even if Redis is down.
    void this.client.connect().catch(() => {});
  }

  private async bounded<T>(op: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("cache timeout")), this.timeoutMs);
    });
    try {
      return await Promise.race([op, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  get(key: string): Promise<string | null> {
    return this.bounded(this.client.get(key));
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.bounded(this.client.set(key, value, { EX: ttlSeconds }));
  }
  async del(key: string): Promise<void> {
    await this.bounded(this.client.del(key));
  }
  async deletePrefix(prefix: string): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      if (keys.length > 0) await this.client.del(keys);
    }
  }
  async close(): Promise<void> {
    this.client.destroy();
  }
}

// Kept for the existing unit test; the rules live in config.ts (CACHE_TTL_SECONDS: whole seconds
// 1..86400, because `EX 0` is a Redis error and an unbounded TTL means unbounded staleness).
export function parseTtlSeconds(raw: string | undefined): number {
  return parseCacheConfig({ CACHE_TTL_SECONDS: raw, CACHE_ENABLED: "false" }).ttlSeconds;
}

// Process-wide backend, like the database pool. Lecture 17: CACHE_ENABLED=false (or no REDIS_URL)
// means noCache: reads go to PostgreSQL and no Redis connection is ever opened.
const cacheConfig = loadConfig(parseCacheConfig);
export const cache: Cache = cacheConfig.redisUrl ? new RedisCache(cacheConfig.redisUrl) : noCache;
export const cacheTtlSeconds = cacheConfig.ttlSeconds;
