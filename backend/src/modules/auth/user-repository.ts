import type pg from "pg";
import { isUniqueViolation } from "../../db/pool.ts";
import type { Role, User } from "../../auth.ts";

export interface UserRepository {
  // undefined: the username (case-insensitive) is already taken.
  create(username: string, passwordHash: string, role: Role): Promise<User | undefined>;
  findByUsername(username: string): Promise<User | undefined>;
  findById(id: number): Promise<User | undefined>;
  setRole(id: number, role: Role): Promise<void>;
}

interface Row {
  id: number;
  username: string;
  role: Role;
  password_hash: string;
}
const toUser = (r: Row): User => ({ id: r.id, username: r.username, role: r.role, passwordHash: r.password_hash });
const COLUMNS = "id, username, role, password_hash";

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Uniqueness is decided by the database (unique index on lower(username)), so two
  // concurrent registrations cannot both succeed, unlike check-then-insert in code.
  async create(username: string, passwordHash: string, role: Role) {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [username, role, passwordHash],
      );
      return toUser(r.rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) return undefined;
      throw err;
    }
  }
  async findByUsername(username: string) {
    const r = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM users WHERE lower(username) = lower($1)`, [username]);
    return r.rows[0] && toUser(r.rows[0]);
  }
  async findById(id: number) {
    const r = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return r.rows[0] && toUser(r.rows[0]);
  }
  async setRole(id: number, role: Role) {
    await this.pool.query("UPDATE users SET role = $2 WHERE id = $1", [id, role]);
  }
}
