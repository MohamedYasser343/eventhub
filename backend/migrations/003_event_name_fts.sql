-- Lecture 15: full-text search over event names with PostgreSQL's built-in FTS.
-- 'simple' config: lowercase tokens only, no stemming and no English stop words, so the
-- index is not tied to one language (Arabic/mixed titles are tokenized, not stemmed).
-- The expression must match the one in PgEventRepository.search EXACTLY or the planner
-- cannot use the index. Events have no description column yet; only name is searchable.
-- Rollback: DROP INDEX events_name_fts_idx;
CREATE INDEX events_name_fts_idx ON events USING GIN (to_tsvector('simple', name));
