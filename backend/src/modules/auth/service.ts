import type { AuthService, Role } from "../../auth.ts";

// Account use cases (register, login, logout). No HTTP: input is `unknown` (the
// already-parsed body), results are typed outcomes. Storage and password/session
// mechanics stay in AuthService (lecture 08); this layer adds the rules around them.
export const USERNAME = /^[A-Za-z0-9_]{3,32}$/;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128; // bounds scrypt work per request

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
}
export type RegisterOutcome =
  | { ok: true; user: PublicUser }
  | { ok: false; kind: "invalid"; details: string[] }
  | { ok: false; kind: "duplicate" }
  | { ok: false; kind: "rate-limited"; retryAfter: number };
export type LoginOutcome =
  | { ok: true; token: string; expiresAt: number; user: PublicUser }
  | { ok: false; kind: "invalid-credentials" }
  | { ok: false; kind: "rate-limited"; retryAfter: number };

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pub = (u: PublicUser): PublicUser => ({ id: u.id, username: u.username, role: u.role });

export class AccountService {
  constructor(private readonly auth: AuthService) {}

  // `clientKey` is the caller's address for rate limiting; trusted in-process callers omit it.
  async register(input: unknown, clientKey?: string): Promise<RegisterOutcome> {
    const { username, password } = asRecord(input);
    const details: string[] = [];
    if (typeof username !== "string" || !USERNAME.test(username)) details.push("username must be 3-32 letters, digits or _");
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
      details.push(`password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
    if (details.length > 0) return { ok: false, kind: "invalid", details };
    // Only attempts that would reach scrypt and the database count; malformed bodies are cheap.
    if (clientKey !== undefined) {
      const wait = await this.auth.registerLimiter.retryAfter(clientKey);
      if (wait > 0) return { ok: false, kind: "rate-limited", retryAfter: wait };
      await this.auth.registerLimiter.fail(clientKey);
    }
    // Any "role" in the input is ignored: public registration always creates an attendee.
    const result = await this.auth.createUser(username as string, password as string, "attendee");
    return result.ok ? { ok: true, user: pub(result.user) } : { ok: false, kind: "duplicate" };
  }

  // `clientKey` identifies the caller for rate limiting (the controller supplies the address).
  async login(input: unknown, clientKey: string): Promise<LoginOutcome> {
    const { username, password } = asRecord(input);
    if (typeof username !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD || username.length > 64) {
      return { ok: false, kind: "invalid-credentials" };
    }
    const key = `${clientKey}|${username.toLowerCase()}`;
    const wait = Math.max(await this.auth.limiter.retryAfter(key), await this.auth.addressLimiter.retryAfter(clientKey));
    if (wait > 0) return { ok: false, kind: "rate-limited", retryAfter: wait };
    const user = await this.auth.verifyCredentials(username, password);
    if (!user) {
      await this.auth.limiter.fail(key);
      await this.auth.addressLimiter.fail(clientKey);
      return { ok: false, kind: "invalid-credentials" }; // same outcome for unknown user and wrong password
    }
    await this.auth.limiter.clear(key); // NOT the address counter: a valid login must not reset a spray in progress
    const session = await this.auth.createSession(user.id);
    return { ok: true, token: session.token, expiresAt: session.expiresAt, user: pub(user) };
  }

  async logout(token: string): Promise<void> {
    await this.auth.destroySession(token); // server-side revocation: the old token is dead immediately
  }
}
