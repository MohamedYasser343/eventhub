# ADR-019: Security hardening — layered rate limits and baseline response headers

Status: Accepted (owner confirmed 2026-11-25)
Date: 2026-11-25
Related lecture: [20 — Backend Security](../lectures/20-backend-security.md)

## Context
An audit of the existing backend against the lecture 20 assignment found most controls already in place and tested (parameterized SQL with an ORDER BY allowlist, scrypt with per-user salts, opaque hashed sessions, current-role lookup, ownership checks, generic errors, log redaction). Three real gaps remained:

1. **Login limiter bypass.** Key = `address|username`, 10,000 keys max, and on overflow the limiter did `hits.clear()`. One address could try unlimited *different* usernames (each costing a scrypt run), and filling the map also erased every existing lockout.
2. **Unbounded registration.** `POST /auth/register` ran scrypt and an INSERT per request with no limit.
3. **No baseline response headers**, and the in-memory session map only dropped expired entries when that token was presented again.

## Decision
- `FixedWindowLimiter` (exported from `src/auth.ts`, generalised from the lecture 08 `LoginLimiter`). When full it evicts expired entries first, then the *oldest* live entry; it never clears everything.
- Three independent limits, all fixed window 60 s, all keyed by the socket address (`req.socket.remoteAddress`; `X-Forwarded-For` is deliberately not read because no trusted proxy is configured):
  - failed logins per `address|username`: 5 (unchanged);
  - failed logins per address: 20 (new; blocks spraying; checked before scrypt);
  - registration attempts per address: 20 (new; only attempts that pass validation count, so malformed bodies stay cheap).
  Exceeded -> `429` with `Retry-After` and `Cache-Control: no-store`. A successful login clears only the per-user key, **not** the address counter, so an attacker's own valid account cannot reset a spray.
- Every response (including the 503 drain response, 204 and metrics text) gets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, set at the top of the `createServer` callback.
- `AuthService.createSession` sweeps expired sessions at most once a minute.
- **No HSTS**: the listener is plain HTTP on 127.0.0.1; HSTS belongs to the TLS-terminating layer of a real deployment.

## Trade-offs and consequences
- Limiter state is per process memory: it resets on restart and is not shared between instances. A shared atomic store (Redis) is a later, deliberate step; the fail-open/fail-closed choice must be made then.
- Residual risk: an attacker controlling many addresses can still push old entries out of a full map; the per-address limit makes that cost 500+ addresses per flood, not one.
- A shared NAT address can exhaust the per-address budgets for everyone behind it (20 failures or 20 registrations per minute). Acceptable for this learning backend; thresholds are constants in `AuthService`, not configuration.
- The per-address limit also refuses a *valid* login from a sprayed address for the rest of the window (consistent with the existing per-user behaviour).
- Thresholds were chosen by reasoning about this workload and test traffic, not measured.

## Not done / owner decisions
- `POST /bookings` is an unauthenticated `501` stub; wrapping it in `protect()` changes the contract, so it is left for the owner (it should be protected when real booking is implemented).
- Cookies, CSRF and XSS controls are not applicable: transport is an explicit Bearer header and every response is JSON.
- No separate migration/runtime database role (one `eventhub` role does both in local dev); documented, not refactored.
