import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

// Lecture 08 lab: in-memory users, scrypt password hashing, opaque server-side
// sessions (Bearer transport) and a login rate limiter. Synthetic data only;
// nothing here is persisted, so a restart forgets every user and session.
// Not production-ready: see ADR-007 for what a real deployment still needs.

export type Role = "attendee" | "organizer" | "admin";
export interface User {
  id: number;
  username: string;
  role: Role;
  passwordHash: string; // never leaves this module's callers: see publicUser()
}
export const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role });

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

// ---------- login rate limiter (fixed window, per username + client address) ----------
class LoginLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private now: () => number,
    private max = 5,
    private windowMs = 60_000,
    private maxKeys = 10_000,
  ) {}
  // Returns seconds to wait, or 0 if the attempt may proceed.
  retryAfter(key: string): number {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= this.now()) return 0;
    return e.count >= this.max ? Math.ceil((e.resetAt - this.now()) / 1000) : 0;
  }
  fail(key: string): void {
    const t = this.now();
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys) this.hits.clear(); // bound memory; crude but safe
    }
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    else e.count++;
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

// ---------- the service ----------
export type Registration =
  | { ok: true; user: User }
  | { ok: false; reason: "duplicate" };

export class AuthService {
  now: () => number = Date.now; // injectable clock for expiry tests
  sessionTtlMs = 15 * 60_000;
  private users = new Map<string, User>(); // key: lower-case username
  private byId = new Map<number, User>();
  private sessions = new Map<string, { userId: number; expiresAt: number }>(); // key: sha256(token)
  private nextUserId = 1;
  private dummyHash: Promise<string> = hashPassword("dummy-password-for-timing");
  readonly limiter = new LoginLimiter(() => this.now());

  // Trusted path (startup seed, tests). There is deliberately no HTTP route to set a role.
  async createUser(username: string, password: string, role: Role = "attendee"): Promise<Registration> {
    const key = username.toLowerCase();
    if (this.users.has(key)) return { ok: false, reason: "duplicate" };
    const user: User = { id: this.nextUserId++, username, role, passwordHash: await hashPassword(password) };
    // Re-check: a concurrent registration may have won while hashing.
    if (this.users.has(key)) return { ok: false, reason: "duplicate" };
    this.users.set(key, user);
    this.byId.set(user.id, user);
    return { ok: true, user };
  }

  userById(id: number): User | undefined {
    return this.byId.get(id);
  }

  setRole(id: number, role: Role): void {
    const u = this.byId.get(id);
    if (u) u.role = role;
  }

  // Always does one scrypt run, so an unknown user costs the same as a wrong password.
  async verifyCredentials(username: string, password: string): Promise<User | null> {
    const user = this.users.get(username.toLowerCase());
    const ok = await verifyPassword(password, user ? user.passwordHash : await this.dummyHash);
    return user && ok ? user : null;
  }

  // New random id on every login (no session fixation: clients never choose it).
  // Only a hash of the token is stored, so a memory dump does not yield usable tokens.
  createSession(userId: number): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(sha(token), { userId, expiresAt });
    return { token, expiresAt };
  }

  // Role is read from the user store on every request (trusted, never from the client).
  authenticate(token: string): User | null {
    const key = sha(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return this.byId.get(s.userId) ?? null;
  }

  destroySession(token: string): void {
    this.sessions.delete(sha(token));
  }
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export const auth = new AuthService();

// ownership: event id -> owner user id (kept out of the event representation)
export const eventOwners = new Map<number, number>();
// synthetic private resource for the "own tickets only" demonstration
export const ticketsByUser = new Map<number, { ticketId: string; eventId: number }[]>();
