# ADR-016: Central typed configuration boundary

Status: Accepted (owner confirmed 2026-11-25)
Date: 2026-11-25
Related lecture: [17 — Production-grade configuration management](../lectures/17-configuration-management.md)

## Context
Settings were read with `process.env.X ?? default` in six files (pool, cache, server, worker, enqueue, tests). Numbers used `Number(v)` (so `PORT=abc` became `NaN` and the worker accepted `WORKER_CONCURRENCY=abc`), and an empty value silently meant "unset".

## Decision
- New `backend/src/config.ts`: pure parsers `parseDatabaseConfig`, `parseCacheConfig`, `parseServerConfig`, `parseQueueConfig`, `parseWorkerConfig` taking an env object (no hidden `process.env`), no new dependency (no Zod). `loadConfig(parse)` is the entry-point wrapper: prints key-level problems and `exit(1)` before listening or consuming jobs.
- Rules: absent -> documented default or "is required"; set-but-empty or malformed -> error, never a fallback. Booleans are exactly `true`/`false`; legacy switches (`LOG_REQUESTS`, `SEED_DEMO_USERS`, `MOCK_ALLOW_CRASH`) stay `0`/`1`. Messages name the key and rule, never the value (connection URLs carry passwords). Problems of one parse call are reported together.
- Precedence: real environment > `.env` > default. This is Node's own `--env-file-if-exists` behavior (it does not override existing variables), verified by a subprocess test; no custom dotenv loader.
- Per-entrypoint requirements: the API needs `DATABASE_URL`; the worker additionally needs `QUEUE_REDIS_URL`; neither needs the other's settings. `REDIS_URL` stays optional (unset = no cache, as in lecture 13).
- Feature flag: `CACHE_ENABLED` (default `true`). `false` -> `noCache`, no Redis client is created, and `REDIS_URL` is not read (a broken value is ignored). It is a startup flag, so changing it needs a restart.
- New: `APP_ENV` (development|test|production, default development) with one cross-field rule (`SEED_DEMO_USERS=1` is refused when `production`); `CORS_ORIGIN` must be an http(s) origin; `QUEUE_NAME`/`QUEUE_PREFIX` charset-restricted.
- `parseTtlSeconds` in `cache.ts` stays as a thin wrapper so the existing test is unchanged.

## Consequences / limitations
- Behavior change: `REDIS_URL=` (empty) and `CACHE_TTL_SECONDS=` used to mean "unset"; they are now errors.
- Validation runs per module at import (pool, cache, then server), so a process with problems in several modules shows them one module at a time.
- `npm start` still passes `--env-file-if-exists=.env`; in production the launcher should supply real environment variables and ship no `.env`. This is documented, not enforced (the process cannot know if a file was loaded).
- No JWT settings exist (sessions are in-memory, lecture 08), so the lecture's signing-key criteria are not applicable yet.
- Not done (deferred by the note): live reload, remote config/secret stores, schema library.
