# ADR-014: PostgreSQL full-text search for event names

Status: Accepted (owner confirmed 2026-11-23)
Date: 2026-11-23
Related lecture: [15 - Full Text Search using Elasticsearch](../lectures/15-full-text-search-elasticsearch.md)

## Context
`GET /api/v1/events/search` was a lecture-06 stub (substring on `name`, unpaginated, unranked). Lecture 15 asks for bounded, ranked, paginated search and a fair comparison before any dedicated engine. Events have only `name` and `seats`: no description, status or visibility, so every event is public and only the name is searchable.

## Decision
- **PostgreSQL FTS, not Elasticsearch.** Migration `003_event_name_fts.sql`: GIN index on `to_tsvector('simple', name)`. The query uses the identical expression, otherwise the planner cannot use the index. Rollback: `DROP INDEX events_name_fts_idx`.
- **`simple` configuration:** lowercase tokens, no stemming, no English stop words, so Arabic/mixed titles are tokenized rather than mangled. Cost: "workshops" does not match "workshop".
- **`plainto_tsquery`:** input is plain words joined by AND. `| & !` and quotes are not operators; punctuation-only input yields zero lexemes and an empty result. `%`/`_` are not wildcards either.
- **Ranking:** `ts_rank` descending, then `id` ascending (deterministic pages). With one field there is no title-vs-description boost to configure yet.
- **Contract:** `q` required, trimmed, 1..100 chars (blank/missing/repeated/too long = 400); `page`/`limit` as in the list (limit 1..100, default 10, invalid = 400, page past the end = 200 empty). Response `{data, meta:{q,page,pageSize,total,totalPages}}`. Unauthenticated, like the public list. The unranked substring filter of `GET /v1/events?q=` is unchanged.
- **Elasticsearch lab not done:** it needs explicit owner approval (lecture note, step 5). No new dependency or container.

## Trade-offs and consequences
- Token search: no partial words (`jaz`), no typo correction (`labtop` returns nothing). Prefix matching (`:*`) or `pg_trgm` would add that; deferred until required.
- Measured (docs/evidence/lecture-15-search-*.txt): the index makes rare-word and no-match queries fast, but a very common word is slower than a plain `LIMIT 10` substring scan, because ranking must score every match before the top 10. Write cost rises slightly (GIN maintenance).
- No derived copy exists, so search results are always as fresh as the table (tested: rename/delete). A second engine would add lag and reconciliation.
- When a draft/cancelled state exists, the visibility filter belongs in `EventService.search` and in the SQL predicate.
