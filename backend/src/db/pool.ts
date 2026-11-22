import pg from "pg";

// BIGINT (OID 20) arrives as a string by default. Ids and counts here stay far
// below 2^53, so parse them to numbers; a value beyond that would be a design change.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint outside the safe integer range");
  return n;
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (see backend/.env.example)");

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
