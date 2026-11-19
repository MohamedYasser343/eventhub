# ADR-007: Sessions with Bearer tokens, scrypt, role policy

Status: Proposed (owner must confirm the adopted method; lecture 08 asks for this after the JWT comparison, which is not done yet)
Date: 2026-11-19
Related lecture: [08 — Authentication and authorization](../lectures/08-authentication-authorization.md)

## Decision
- Users, sessions and ownership are in memory (`backend/src/auth.ts`); a restart forgets them. Synthetic data only.
- Passwords: `node:crypto` scrypt (N=16384, r=8, p=1), 16-byte random salt per user, encoded as `scrypt$N$r$p$salt$hash`, compared with `timingSafeEqual`. Password length 12-128 (upper bound limits work per request). An unknown user still triggers one scrypt run so timing does not reveal which usernames exist.
- Sessions: opaque 32-byte random id, new on every login (no fixation), only its SHA-256 is stored, 15-minute absolute lifetime, deleted on logout. The role is read from the user store on every request, so a role change applies immediately.
- Transport: `Authorization: Bearer <token>`, not cookies, so no CSRF defence is needed; the token is held by client code (XSS exposure is a frontend-milestone concern). CORS preflight now allows the `Authorization` header and OPTIONS stays unauthenticated.
- Policy: POST /events organizer or admin (owner recorded server-side in `eventOwners`, never from the body); PUT/PATCH owning organizer or admin; DELETE admin only; seeded events have no owner, so only admin edits them. 401 (with `WWW-Authenticate`) is checked before 404, then 404 before 403. Someone else's ticket answers 404 (concealment).
- Registration always creates an attendee; roles are assigned only by trusted code (`createUser`, tests, or `SEED_DEMO_USERS=1` at startup, which prints random passwords). No HTTP endpoint changes roles.
- Login failures: generic 401; 5 failures per username+address per 60 s window give 429 + Retry-After; in-memory, capped at 10 000 keys.
- **Legacy unversioned `/events` mutations are protected too** (they share handlers and the same array; protecting only `/api/v1` would be a bypass). This changes the lecture 05/06 contract: unauthenticated writes now give 401. Older tests authenticate through a test helper.

## Not production-ready
No persistence, no shared session store, no per-IP global limiter, no HTTPS, no password reset or MFA, no session rotation on privilege change, no audit log. Duplicate registration reveals that a username exists (409), a conscious trade-off.

## Open
JWT experiment (jose) not implemented: installing the dependency was not permitted in this session. Stale-claim, tamper, issuer/audience/algorithm and revocation experiments remain.
