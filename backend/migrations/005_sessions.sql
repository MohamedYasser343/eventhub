-- Lecture 22: shared session store so several API replicas accept the same login.
-- token_hash = sha256(token) (hex); the bearer token itself is never stored.
-- expires_at_ms is epoch milliseconds, the same unit and clock as AuthService (injectable in tests).
-- ON DELETE CASCADE: deleting a user ends their sessions. Rollback: DROP TABLE sessions;
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at_ms BIGINT NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at_ms);
CREATE INDEX sessions_user_idx ON sessions (user_id);
