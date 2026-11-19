// Lecture 08 JWT experiment (lab only, NOT wired into the server). Uses the vetted
// `jose` library for signing and verification; the secret is random per process.
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const secret = randomBytes(32);
export const ISSUER = "eventhub-lab";
export const AUDIENCE = "eventhub-api";

export async function issue(sub: string, role: string, opts: { ttlSeconds?: number; now?: Date; key?: Uint8Array; alg?: string; iss?: string; aud?: string } = {}): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setSubject(sub)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt(opts.now)
    .setExpirationTime(Math.floor((opts.now ?? new Date()).getTime() / 1000) + (opts.ttlSeconds ?? 300))
    .sign(opts.key ?? secret);
}

// Real verification: signature, expiry, issuer, audience and algorithm are all pinned.
export async function verify(token: string, now?: Date) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, currentDate: now,
  });
  return payload;
}

// UNSAFE lab policy: trusts the role claim inside the token until it expires.
export async function claimsOnlyCanCreate(token: string, now?: Date): Promise<boolean> {
  const p = await verify(token, now);
  return p["role"] === "organizer" || p["role"] === "admin";
}

// Safe variant: the signature proves who the user is; the CURRENT role comes from the store.
export async function trustedCanCreate(token: string, roles: Map<string, string>, now?: Date): Promise<boolean> {
  const p = await verify(token, now);
  const role = roles.get(String(p.sub));
  return role === "organizer" || role === "admin";
}
