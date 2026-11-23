import type pg from "pg";
import type { EventFields, ListQuery, SearchQuery } from "../../validation.ts";

export interface EventItem {
  id: number;
  name: string;
  seats: number;
}

// Storage contract the service depends on. Async because PostgreSQL I/O is
// (ADR-011, superseding the synchronous contract of ADR-009).
export interface EventRepository {
  findById(id: number): Promise<EventItem | undefined>;
  findAll(): Promise<EventItem[]>;
  // Filter, deterministic sort and page slice happen in SQL; total counts every match.
  query(q: ListQuery): Promise<{ data: EventItem[]; total: number }>;
  // Full-text search (lecture 15): ranked, deterministic page + total of all matches.
  search(q: SearchQuery): Promise<{ data: EventItem[]; total: number }>;
  insert(fields: EventFields, ownerId: number): Promise<EventItem>;
  replace(id: number, fields: EventFields): Promise<EventItem | undefined>; // undefined: no such event
  remove(id: number): Promise<boolean>;
  ownerOf(id: number): Promise<number | undefined>;
}

// Sort columns are an allowlist: identifiers cannot be bound as parameters, so the
// ORDER BY text comes from this table and never from the request. name uses the
// "C" collation so the order is byte-wise and independent of the server locale.
const SORT_SQL = { id: "id", name: 'name COLLATE "C"', seats: "seats" } as const;

const COLUMNS = "id, name, seats";
// Case-insensitive substring, with no LIKE wildcards to escape (% and _ are literal).
const MATCH = "position(lower($1) in lower(name)) > 0";

export class PgEventRepository implements EventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(id: number) {
    return (await this.pool.query<EventItem>(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id])).rows[0];
  }
  async findAll() {
    return (await this.pool.query<EventItem>(`SELECT ${COLUMNS} FROM events ORDER BY id`)).rows;
  }
  async query(q: ListQuery) {
    const where = ["($1::text IS NULL OR " + MATCH + ")", "($2::int IS NULL OR seats >= $2)"].join(" AND ");
    const dir = q.sort.direction === 1 ? "ASC" : "DESC";
    // One snapshot for both statements so total and data describe the same rows.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const total = (await client.query<{ n: number }>(`SELECT count(*) AS n FROM events WHERE ${where}`, [q.q, q.minSeats])).rows[0]!.n;
      const data = (
        await client.query<EventItem>(
          `SELECT ${COLUMNS} FROM events WHERE ${where} ORDER BY ${SORT_SQL[q.sort.field]} ${dir}, id ASC LIMIT $3 OFFSET $4`,
          [q.q, q.minSeats, q.limit, q.offset],
        )
      ).rows;
      await client.query("COMMIT");
      return { data, total };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async search(q: SearchQuery) {
    // The tsvector expression is the one indexed by events_name_fts_idx (migration 003).
    // plainto_tsquery treats the input as plain words (AND), never as operator syntax, and
    // a query with no usable words (e.g. "!!!") simply matches nothing.
    const vec = "to_tsvector('simple', name)";
    const tsq = "plainto_tsquery('simple', $1)";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const total = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM events WHERE ${vec} @@ ${tsq}`, [q.q])).rows[0]!.n);
      const data = (
        await client.query<EventItem>(
          `SELECT ${COLUMNS} FROM events WHERE ${vec} @@ ${tsq} ORDER BY ts_rank(${vec}, ${tsq}) DESC, id ASC LIMIT $2 OFFSET $3`,
          [q.q, q.limit, q.offset],
        )
      ).rows;
      await client.query("COMMIT");
      return { data, total };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async insert(f: EventFields, ownerId: number) {
    return (
      await this.pool.query<EventItem>(`INSERT INTO events (owner_id, name, seats) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`, [ownerId, f.name, f.seats])
    ).rows[0]!;
  }
  async replace(id: number, f: EventFields) {
    return (await this.pool.query<EventItem>(`UPDATE events SET name = $2, seats = $3 WHERE id = $1 RETURNING ${COLUMNS}`, [id, f.name, f.seats])).rows[0];
  }
  async remove(id: number) {
    return (await this.pool.query("DELETE FROM events WHERE id = $1", [id])).rowCount === 1;
  }
  async ownerOf(id: number) {
    return (await this.pool.query<{ owner_id: number }>("SELECT owner_id FROM events WHERE id = $1", [id])).rows[0]?.owner_id;
  }
}
