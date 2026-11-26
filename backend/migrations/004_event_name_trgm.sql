-- Lecture 21: trigram index so the list endpoint's substring filter (q) is index-assisted.
-- Measured on 300,000 synthetic rows (docs/lectures/21-...md evidence): a selective q went from a full
-- scan (~55 ms count, ~116 ms page via primary-key walk) to ~0.5 ms per query.
-- Costs: extra disk and slower writes to events.name. A needle shorter than 3 characters cannot use it
-- (the query still returns correct results through a scan). Requires the pg_trgm extension (PostgreSQL contrib).
-- The expression must match PgEventRepository's MATCH predicate (lower(name)).
-- Rollback: DROP INDEX events_name_lower_trgm_idx;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX events_name_lower_trgm_idx ON events USING GIN (lower(name) gin_trgm_ops);
