-- Lecture 22: rate-limit counters shared by all API replicas (login, per-address login, registration).
-- bucket = which limiter; key = "address|username" or "address"; reset_at_ms = end of the fixed window (epoch ms).
-- Rollback: DROP TABLE rate_limits;
CREATE TABLE rate_limits (
  bucket      TEXT   NOT NULL,
  key         TEXT   NOT NULL,
  count       INTEGER NOT NULL,
  reset_at_ms BIGINT NOT NULL,
  PRIMARY KEY (bucket, key)
);
CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at_ms);
