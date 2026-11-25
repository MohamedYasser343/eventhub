import pg from "pg";
import { loadConfig, parseDatabaseConfig } from "../config.ts";

// BIGINT (OID 20) arrives as a string by default. Ids and counts here stay far
// below 2^53, so parse them to numbers; a value beyond that would be a design change.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint outside the safe integer range");
  return n;
});

// Lecture 17: validated by the central config module (exits with a key-level message if invalid).
const { databaseUrl: url } = loadConfig(parseDatabaseConfig);

// One bounded pool for the process. When all connections are busy a caller waits
// (backpressure) and fails after connectionTimeoutMillis instead of piling up.
export const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 2_000 });
// An idle client dying must not crash the process; never log the connection string.
pool.on("error", () => {});

// Runs fn on ONE checked-out connection inside BEGIN/COMMIT. Any throw rolls back,
// and the connection is always released (also when ROLLBACK itself fails).
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, p: pg.Pool = pool): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// SQLSTATE codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
export const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";
export const isForeignKeyViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23503";
export const isCheckViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23514";

// Lecture 16: "the database is unreachable or refusing work" (retrying later may help), as
// opposed to a bug or a constraint violation. Used by the HTTP error boundary to answer 503.
// pg-pool's connect timeout has NO code, only a message, so that one case is matched by
// text (brittle by nature; covered by a test against the installed pg version).
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE"]);
const UNAVAILABLE_SQLSTATE = new Set(["57P01", "57P02", "57P03", "53300"]); // admin shutdown, crash, starting up, too many connections
export function isDbUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; errors?: unknown };
  if (typeof e.code === "string") {
    if (NETWORK_CODES.has(e.code) || UNAVAILABLE_SQLSTATE.has(e.code) || e.code.startsWith("08")) return true;
  }
  // Node reports a refused connect to "localhost" (IPv4 + IPv6) as an AggregateError.
  if (Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every(isDbUnavailable)) return true;
  return typeof e.message === "string" && /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/.test(e.message);
}
