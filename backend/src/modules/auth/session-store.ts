import type pg from "pg";
import type { Role, SessionRecord, SessionStore, User } from "../../auth.ts";

// Lecture 22: sessions in PostgreSQL so every API replica sees the same login state (migration 005).
// The key is sha256(token); the token itself is never stored. Revocation (logout) is a DELETE and is
// therefore immediately effective on every replica, which the old per-process Map could not offer.
export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async put(tokenHash: string, rec: SessionRecord): Promise<void> {
    await this.pool.query("INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES ($1, $2, $3)", [tokenHash, rec.userId, rec.expiresAt]);
  }
  async get(tokenHash: string): Promise<SessionRecord | undefined> {
    const r = await this.pool.query<{ user_id: number; expires_at_ms: number }>("SELECT user_id, expires_at_ms FROM sessions WHERE token_hash = $1", [tokenHash]);
    const row = r.rows[0];
    return row && { userId: row.user_id, expiresAt: row.expires_at_ms };
  }
  // One round trip for the authenticated-request hot path (was session lookup + user lookup).
  async getWithUser(tokenHash: string): Promise<{ expiresAt: number; user: User | undefined } | undefined> {
    const r = await this.pool.query<{ expires_at_ms: number; id: number; username: string; role: Role; password_hash: string }>(
      `SELECT s.expires_at_ms, u.id, u.username, u.role, u.password_hash
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const user = row.id === null ? undefined : { id: row.id, username: row.username, role: row.role, passwordHash: row.password_hash };
    return { expiresAt: row.expires_at_ms, user };
  }
  async delete(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }
  async deleteExpired(now: number): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE expires_at_ms <= $1", [now]);
  }
}
