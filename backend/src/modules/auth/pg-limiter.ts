import type pg from "pg";
import type { Limiter } from "../../auth.ts";

// Lecture 22: the fixed-window limiter of lecture 20, with its counters in PostgreSQL so that every API
// replica shares them (3 replicas no longer allow 3x the failures). Same semantics as FixedWindowLimiter:
// `max` events per key per window, the window starts at the first event, retryAfter is whole seconds.
// fail() is ONE atomic upsert (no read-modify-write race between replicas). retryAfter() followed by
// fail() is still check-then-act, exactly as before: a burst of concurrent attempts can overshoot `max`
// by the number of in-flight requests (bounded by the pool), never unboundedly.
// Counters are NOT in the disposable cache Redis (an LRU eviction would silently reset a lockout).
// Expired rows are deleted in the background at most once a minute; live rows are bounded by the limits
// themselves (an address can create only `max` failures per window).
export class PgWindowLimiter implements Limiter {
  private lastSweep = 0;
  constructor(
    private readonly pool: pg.Pool,
    private readonly bucket: string, // namespaces the three limiters in one table
    private readonly now: () => number,
    private readonly max = 5,
    private readonly windowMs = 60_000,
  ) {}

  async retryAfter(key: string): Promise<number> {
    const t = this.now();
    const r = await this.pool.query<{ count: number; reset_at_ms: number }>(
      "SELECT count, reset_at_ms FROM rate_limits WHERE bucket = $1 AND key = $2",
      [this.bucket, key],
    );
    const e = r.rows[0];
    if (!e || e.reset_at_ms <= t) return 0;
    return e.count >= this.max ? Math.ceil((e.reset_at_ms - t) / 1000) : 0;
  }

  async fail(key: string): Promise<void> {
    const t = this.now();
    await this.pool.query(
      `INSERT INTO rate_limits (bucket, key, count, reset_at_ms) VALUES ($1, $2, 1, $3 + $4::bigint)
       ON CONFLICT (bucket, key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at_ms <= $3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at_ms = CASE WHEN rate_limits.reset_at_ms <= $3 THEN $3 + $4::bigint ELSE rate_limits.reset_at_ms END`,
      [this.bucket, key, t, this.windowMs],
    );
    if (t - this.lastSweep >= 60_000) {
      this.lastSweep = t;
      void this.pool.query("DELETE FROM rate_limits WHERE reset_at_ms <= $1", [t]).catch(() => {});
    }
  }

  async clear(key: string): Promise<void> {
    await this.pool.query("DELETE FROM rate_limits WHERE bucket = $1 AND key = $2", [this.bucket, key]);
  }
}
