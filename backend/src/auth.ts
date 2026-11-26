import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import type { UserRepository } from "./modules/auth/user-repository.ts";

// Lecture 08 lab: scrypt password hashing, opaque server-side sessions (Bearer
// transport) and a login rate limiter. Since lecture 12 users live in PostgreSQL
// (UserRepository); sessions and the limiter are still in memory, so a restart
// logs everyone out. Not production-ready: see ADR-007 and ADR-011.

export type Role = "attendee" | "organizer" | "admin";
export interface User {
  id: number;
  username: string;
  role: Role;
  passwordHash: string; // never leaves this module's callers: see publicUser()
}
export const publicUser = (u: Pick<User, "id" | "username" | "role">) => ({ id: u.id, username: u.username, role: u.role });

// ---------- password hashing (node:crypto scrypt, per-user random salt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) =>
      e ? reject(e) : resolve(k),
    ),
  );
}

// Self-describing encoding so parameters can be raised later: scrypt$N$r$p$salt$hash
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [alg, , , , saltB64, hashB64] = encoded.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------- rate limiter (fixed window) ----------
// Lecture 20: generalised from the lecture 08 login limiter. Counts events per key in a fixed
// window. State is in this process's memory: it resets on restart and is NOT shared between
// instances (a shared atomic store such as Redis is the later, deliberate step).
// Bounded: when full, expired entries go first; if every entry is still live the OLDEST entry is
// evicted. It never clears everything, so a flood of junk keys cannot wipe an existing lockout
// in one step (the lecture 08 version did exactly that). Residual risk, documented in ADR-019:
// a distributed attacker with enough addresses can still push old entries out.
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private now: () => number,
    private max = 5,
    private windowMs = 60_000,
    private maxKeys = 10_000,
  ) {}
  get size(): number {
    return this.hits.size;
  }
  // Returns seconds to wait, or 0 if the next event may proceed.
  retryAfter(key: string): number {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= this.now()) return 0;
    return e.count >= this.max ? Math.ceil((e.resetAt - this.now()) / 1000) : 0;
  }
  // Records one event for `key` (a failed login, an attempted registration...).
  fail(key: string): void {
    const t = this.now();
    const e = this.hits.get(key);
    if (e && e.resetAt > t) {
      e.count++;
      return;
    }
    this.hits.delete(key); // an expired entry is replaced and moves to the newest position
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      while (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next();
        if (oldest.done) break;
        this.hits.delete(oldest.value);
      }
    }
    this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

// ---------- the service ----------
export type Registration =
  | { ok: true; user: User }
  | { ok: false; reason: "duplicate" };

// ---------- session storage (lecture 22) ----------
// Sessions used to live in one process's memory, which breaks as soon as a second API instance exists
// (login on A, 401 on B). The store is now an interface: PostgreSQL in the server (shared by every replica),
// memory for unit tests. Only the sha256 of the token is ever stored, in either implementation.
export interface SessionRecord {
  userId: number;
  expiresAt: number; // epoch ms
}
export interface SessionStore {
  put(tokenHash: string, rec: SessionRecord): Promise<void>;
  get(tokenHash: string): Promise<SessionRecord | undefined>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(now: number): Promise<void>;
  readonly size?: number; // in-memory store only (tests)
}
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  get size(): number {
    return this.sessions.size;
  }
  async put(h: string, rec: SessionRecord): Promise<void> {
    this.sessions.set(h, rec);
  }
  async get(h: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(h);
  }
  async delete(h: string): Promise<void> {
    this.sessions.delete(h);
  }
  async deleteExpired(now: number): Promise<void> {
    for (const [k, v] of this.sessions) if (v.expiresAt <= now) this.sessions.delete(k);
  }
}

export class AuthService {
  now: () => number = Date.now; // injectable clock for expiry tests
  sessionTtlMs = 15 * 60_000;
  private dummyHash: Promise<string> = hashPassword("dummy-password-for-timing");
  // Lecture 20: three independent limits. The per-(address, username) one stops guessing ONE
  // account; the per-address one stops one address spraying many usernames (each try costs a scrypt
  // run); the registration one bounds account creation (scrypt + an INSERT per request).
  readonly limiter = new FixedWindowLimiter(() => this.now()); // failed logins per address|username
  readonly addressLimiter = new FixedWindowLimiter(() => this.now(), 20, 60_000); // failed logins per address
  readonly registerLimiter = new FixedWindowLimiter(() => this.now(), 20, 60_000); // registrations per address
  private lastSweep = 0;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionStore = new InMemorySessionStore(),
  ) {}

  // Trusted path (startup seed, tests). There is deliberately no HTTP route to set a role.
  // The database's unique index decides duplicates, so concurrent registrations are safe.
  async createUser(username: string, password: string, role: Role = "attendee"): Promise<Registration> {
    const user = await this.users.create(username, await hashPassword(password), role);
    return user ? { ok: true, user } : { ok: false, reason: "duplicate" };
  }

  userById(id: number): Promise<User | undefined> {
    return this.users.findById(id);
  }

  setRole(id: number, role: Role): Promise<void> {
    return this.users.setRole(id, role);
  }

  // Always does one scrypt run, so an unknown user costs the same as a wrong password.
  async verifyCredentials(username: string, password: string): Promise<User | null> {
    const user = await this.users.findByUsername(username);
    const ok = await verifyPassword(password, user ? user.passwordHash : await this.dummyHash);
    return user && ok ? user : null;
  }

  // New random id on every login (no session fixation: clients never choose it).
  // Only a hash of the token is stored, so a database or memory dump does not yield usable tokens.
  async createSession(userId: number): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sweepExpired();
    await this.sessions.put(sha(token), { userId, expiresAt });
    return { token, expiresAt };
  }

  // Expired sessions are otherwise only removed when their token is presented again, so a valid
  // account could grow the store without bound. At most once a minute, drop every expired entry
  // (best effort in the background: a failed sweep only delays cleanup, it never blocks a login).
  private sweepExpired(): void {
    const t = this.now();
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    void this.sessions.deleteExpired(t).catch(() => {});
  }
  get sessionCount(): number {
    return this.sessions.size ?? Number.NaN;
  }

  // Role is read from the user store on every request (trusted, never from the client).
  async authenticate(token: string): Promise<User | null> {
    const key = sha(token);
    const s = await this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      await this.sessions.delete(key);
      return null;
    }
    return (await this.users.findById(s.userId)) ?? null;
  }

  destroySession(token: string): Promise<void> {
    return this.sessions.delete(sha(token));
  }
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// synthetic private resource for the "own tickets only" demonstration
export const ticketsByUser = new Map<number, { ticketId: string; eventId: number }[]>();
