# Video 15 — Full Text Search using Elasticsearch for Blazingly Fast Search

- Video URL: https://www.youtube.com/watch?v=7_sovzAhRSM
- Course: [Backend from First Principles — Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1)
- Playlist position: **15**, corroborated by independent timestamped lesson notes (not rechecked against the live playlist ordering during this documentation pass).
- Date documented: **2026-11-23**.
- Learning status: **Complete — owner explicitly requested the lecture notes be uploaded after our teaching discussion.**
- Implementation status: **Not started**. This is a documentation-only change; no search code, tests, benchmarks or deployments were performed.
- Source availability / verification limitations: The explanation and examples follow the [independent, timestamped, transcript-derived notes and ASR transcript](https://github.com/shubhamscifi/backend_from_first_principles_notes/tree/main/15_full_text_search_elasticsearch) and our discussion of the lecture. The original YouTube recording was **not independently watched** in this documentation pass. Numerical results below are the presenter's demo, not EventHub measurements. Sections explicitly marked **Supplementary engineering guidance** are reasoning/extensions, not claims about what the presenter demonstrated.

## Learning objectives

After this lecture, be able to explain independently:

1. Why substring search with `ILIKE '%term%'` can become expensive at scale, and why it cannot rank relevance by itself.
2. How an **inverted index** differs from scanning document text and what index-time preprocessing costs.
3. Why Elasticsearch uses Apache Lucene, how tokenization and analysis affect matching, and the distinction between `text` and `keyword`.
4. What relevance scoring (BM25) considers, and how field boosting changes search priorities.
5. How typo tolerance, fuzzy matching and type-ahead can be built, and why they are not automatic guarantees.
6. What the lecture's PostgreSQL-vs-Elasticsearch demo did and **what its benchmark does not prove**.
7. When to prefer PostgreSQL full-text search, trigram indexes or Elasticsearch; how to evaluate them with evidence.
8. How adding a separate search index affects write flow, freshness, access control and operational complexity.

## 1. Start with the problem: a growing product catalog (lecture ~0:00–3:58)

The presenter imagines an e-commerce catalog beginning with about **5,000 products**, searched via:

~~~sql
SELECT *
FROM products
WHERE name ILIKE '%laptop%'
   OR description ILIKE '%laptop%';
~~~

`ILIKE` performs case-insensitive pattern matching in PostgreSQL. The leading and trailing `%` mean the substring may be preceded/followed by arbitrary characters. This solves the simplest "find rows containing text" problem.

As the illustrative catalog grows to millions of rows, the talk contrasts a roughly **50 ms** initial search with a **30 second** scenario. These are part of the lecturer's motivating illustration, **not** a general PostgreSQL scaling formula or reproducible EventHub benchmark.

Three product requirements emerge:

- **Speed:** searching a catalog should feel interactive.
- **Relevance:** a real laptop should generally appear ahead of a bag merely containing the word "laptop."
- **Typo tolerance:** a user typing "labtop" may still mean "laptop."

The important conceptual distinction is **matching** versus **ranking**. A conventional `ILIKE` predicate says whether a row matches; without an explicit ranking expression, an SQL result has no meaningful relevance order.

### Why this query can scan many rows

With `ILIKE '%laptop%'` there is no anchored prefix that a conventional B-tree index can efficiently seek to. The planner may choose a sequential scan: examine candidate rows and test the string predicate. Work generally rises with the data examined, while returning matches and sorting them may add further cost.

The lecturer uses a librarian reading every book to find one phrase. That analogy is useful for understanding a **scan**, but not a claim that relational databases have "no indexes." PostgreSQL offers B-tree, GIN, GiST, trigram-based search and built-in full-text search; suitability depends on the *query* and *index design*.

~~~mermaid
flowchart TD
    Q[User searches laptop] --> DB[PostgreSQL query]
    DB --> SCAN[Scan candidate rows for ILIKE pattern]
    SCAN --> MATCH[Return matching rows]
    MATCH --> MISSING[No built-in semantic relevance ranking]
~~~

**Without a suitable index:** latency may increase as data grows. **With an appropriate index and query design:** PostgreSQL can remain a strong choice, including for moderately sophisticated search. Do not infer that moving engines is the first optimization.

## 2. Inverted index: reverse the question (lecture ~3:58–14:16)

Instead of asking "Which documents contain this word?" by reading every document, build a lookup from **term → matching documents** ahead of time.

Illustrative EventHub documents:

| Document ID | Event title |
| --- | --- |
| 1 | AI Conference Cairo |
| 2 | Backend Engineering Workshop |
| 3 | AI Engineering Summit |

Simplified **inverted index**:

| Token | Posting list (document IDs) |
| --- | --- |
| `ai` | 1, 3 |
| `engineering` | 2, 3 |
| `conference` | 1 |
| `backend` | 2 |

A conjunctive query `AI AND Engineering` can intersect posting lists: `{1,3} ∩ {2,3} = {3}`. An OR search instead can combine the sets. This is an illustrative mechanism; actual search engines apply analyzers, query semantics and ranking beyond set operations.

~~~mermaid
flowchart TD
    DOC[Event document: AI Engineering Summit] --> ANALYZE[Analyzer: tokenize and normalize]
    ANALYZE --> A[Token ai]
    ANALYZE --> B[Token engineering]
    ANALYZE --> C[Token summit]
    A --> IDX[(Inverted index: term to document postings)]
    B --> IDX
    C --> IDX
    QUERY[Search ai engineering] --> IDX
    IDX --> CAND[Candidate documents]
    CAND --> RANK[Calculate relevance and order results]
~~~

### What happens internally (supplementary engineering guidance)

At index time, a search system processes field text through configured analysis stages:

1. **Tokenization:** split text into terms according to tokenizer rules.
2. **Normalization:** e.g., lowercase or language-specific normalization.
3. **Optional filters:** stemming, stop words, synonyms or other transformations if configured.
4. **Posting creation:** associate terms with document IDs; implementations may include term frequency, positions and field data needed for scoring/phrase queries.

At query time the engine analyzes the input as appropriate, identifies candidate postings, scores matches and returns a ranked page. This trades **index storage and write/update work** for more efficient querying. An inverted index is not a magic constant-time lookup for all search patterns, and leading wildcards or broad fuzzy queries can still be expensive.

### Apache Lucene and Elasticsearch (lecture ~8:48–19:08)

**Apache Lucene** supplies much of the indexing/search machinery under **Elasticsearch**. Elasticsearch provides document-oriented HTTP APIs, search DSL, mappings and distributed cluster operation around that engine.

~~~mermaid
flowchart TD
    API[EventHub search endpoint] --> ES[Elasticsearch query API]
    ES --> L[Apache Lucene indexing and search]
    L --> POSTS[(Term postings and indexed fields)]
    L --> SCORES[Match and score hits]
    SCORES --> ES
    ES --> API
~~~

The lecture deliberately focuses on intuition rather than implementing Lucene internals. Knowing what the engine does, how to ask it the right question, and where it can fail matters more than memorizing its implementation classes.

## 3. Relevance scoring: not just whether the term appears (lecture ~14:16–19:08)

If 100 documents mention "machine learning" or "AI", they are not all equally useful. **BM25** is a relevance-scoring model used in Elasticsearch for many full-text queries.

Its core intuitions:

- **Term frequency (TF):** a term found repeatedly in a document may be more relevant, with diminishing returns rather than a simple unlimited reward.
- **Inverse document frequency (IDF):** rare discriminative terms typically carry more information than terms present in nearly everything.
- **Document length normalization:** finding a term in a short focused text can be more informative than finding it once in a very long text.
- **Field boosting:** the *query* can assign a higher weight to a title match than a description match. This is a configurable query/field weighting choice affecting the final score, **not a fourth term in the basic BM25 formula**.

For EventHub, a title `AI Conference` likely deserves more weight for query `AI` than `Technology Conference` whose description only mentions AI once.

Illustrative Elasticsearch multi-field query:

~~~json
{
  "query": {
    "multi_match": {
      "query": "AI",
      "fields": ["title^3", "description"]
    }
  }
}
~~~

`title^3` specifies a field boost relative to other fields. It is **not** a guarantee that the whole document's final score is exactly three times another score. Results and ranking depend on term statistics, analyzers, field length, the query and Elasticsearch version/configuration.

### `text` versus `keyword` mapping (lecture ~22:04–27:04)

In the demo, `review` was mapped as `text`, and `sentiment` as `keyword`.

~~~json
{
  "mappings": {
    "properties": {
      "review": { "type": "text" },
      "sentiment": { "type": "keyword" }
    }
  }
}
~~~

- `text`: intended for analyzed full-text matching across tokens, e.g., event titles/descriptions.
- `keyword`: normally used as a single term for exact filters, sorting or aggregations, e.g., `status`, `category_id`, `sentiment`.

Do not equate `text` with arbitrary substring search or `keyword` with an SQL primary key; they describe indexing/search behavior. Field analyzers and language configuration materially affect results.

## 4. Typos, type-ahead and the ELK example (lecture ~19:08–22:04)

The presenter demonstrates a mistyped Google search phrase and the type-ahead suggestions for the intended phrase. The point is **the user experience enabled by search-oriented techniques**, not a claim that Google necessarily runs Elasticsearch.

Potential techniques (supplementary detail):

| Feature | Example | Typical mechanism / caution |
| --- | --- | --- |
| Fuzzy matching | `labtop` → `laptop` | Edit-distance-aware query, tuned to bound cost and false positives |
| Prefix/type-ahead | `backe` → `backend` | Prefix-oriented index/query, e.g. search-as-you-type / edge n-grams |
| Synonyms | `talk` ↔ `session` | Configured synonym analysis; domain-specific relevance rules |
| Relevance | Title match above description-only | Field weighting and scoring |

**None of these is automatically solved by merely storing documents in Elasticsearch.** Analyzers, mappings, queries and ranking rules must be selected and tested.

The lecture also notes the **ELK stack** for log search and analysis: Elasticsearch + Logstash + Kibana. That is an additional use case and may influence technology reuse if an organization already operates Elasticsearch.

## 5. The actual demonstration: 50,000 reviews (lecture ~22:04–32:07)

The presenter used:

- A **Next.js** demonstration UI (the framework is incidental to search).
- **Neon-hosted PostgreSQL** and **Elastic Cloud**, placed in the **US-West** region to reduce geographic latency skew.
- A CSV with approximately **50,000 reviews**, each with a text `review` and `sentiment` (`positive`/`negative`).
- A Node.js populate script inserting PostgreSQL rows in batches of **1,000**, and bulk-indexing Elasticsearch documents.
- A search API that started both requests and **streamed their independent results** to the UI as they finished. Streaming kept the slower search from delaying display of the faster one's response; it did **not** make the underlying searches faster.

**Search approaches shown:** PostgreSQL `ILIKE '%term%'` versus Elasticsearch `query_string` with wildcard-style input in the demo. The objective was to illustrate latency differences for those implementations.

| Search term | PostgreSQL ILIKE | Elasticsearch demo | Reported matched count |
| --- | ---: | ---: | ---: |
| `laptop` | ~3795 ms | ~1162 ms | 33 |
| `something` | ~7668 ms | ~531 ms | 8,229 |

**Critical interpretation:**

1. These measurements are **from the lecture**, not this repo; no experiments were reproduced in this documentation pass.
2. This is **not** a fair proof that Elasticsearch outperforms an **indexed PostgreSQL full-text search** query. The baseline was unoptimized substring `ILIKE`, not `tsvector`/`tsquery` + GIN or `pg_trgm`.
3. Two queries, finite data, provider hardware/configuration, warm/cold effects and network conditions cannot establish a general throughput, p95 latency or scaling guarantee.
4. Equal *reported total matches* does not prove identical scoring, pagination or returned payload sizes. Elasticsearch and SQL may report hit totals and deliver actual document pages differently.
5. Wildcard `query_string` has different semantics and resource costs from analyzed `match`/`multi_match`; do not adopt unsafe, unbounded wildcard user queries as a production default.

The main lesson is to choose a **search-specific algorithm/index** for search workloads, not "replace PostgreSQL whenever a search box exists."

## 6. PostgreSQL full-text search, trigrams and choosing a tool (supplementary engineering guidance)

Before adding another service, evaluate PostgreSQL's existing facilities. They serve different needs:

| Approach | Good starting use | Limitations / costs |
| --- | --- | --- |
| `ILIKE` | Simple substring queries on small data | May scan many rows; no semantic ranking; `%` and `_` are pattern metacharacters |
| PostgreSQL FTS (`tsvector`, `tsquery`, GIN) | Token-based search, ranking, filtering within existing PostgreSQL | Language configuration and lexeme matching matter; not automatically typo/substr matching |
| `pg_trgm` | Substring / similarity-oriented searches, including some `LIKE`/`ILIKE` queries | Extra extension/index storage and update overhead; behavior depends on query pattern |
| Elasticsearch | Rich search-specific features, high search requirements, dedicated indexing/ranking and distributed search | Extra deployment, resource consumption, access control and eventual index synchronization |

Illustrative PostgreSQL full-text search (not a statement of the **actual** EventHub schema):

~~~sql
-- Optional experiment only after checking the real events schema.
CREATE INDEX events_fts_idx
  ON events USING GIN (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  );

SELECT id, title, description,
       ts_rank(
         to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')),
         plainto_tsquery('english', $1)
       ) AS rank
FROM events
WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
      @@ plainto_tsquery('english', $1)
ORDER BY rank DESC, id ASC
LIMIT $2 OFFSET $3;
~~~

In a real codebase, ensure the exact indexed expression, text-search configuration, locale/language mix and relevant visibility filters agree with the query. `'english'` is **not** an appropriate universal default for Arabic or multilingual event content. A production-specific generated/stored search vector is an option but should be evaluated, not added by reflex.

A safe `ILIKE` comparison can bind a query parameter rather than concatenate untrusted SQL:

~~~sql
SELECT id, title
FROM events
WHERE title ILIKE '%' || $1 || '%'
ORDER BY id
LIMIT $2;
~~~

Parameterization protects the SQL value boundary, but does **not** make literal `%`/`_` wildcards inert; escaping/intent handling is a separate design decision. Empty queries and unbounded result sizes require input rules and pagination.

### A decision rule for EventHub

Start by measuring a simple **PostgreSQL-only** solution on the real schema and a documented dataset. Compare plain substring search against appropriately indexed PostgreSQL FTS (and `pg_trgm` only if the feature requires substring/typo-like matching). Add Elasticsearch as an **optional, isolated experiment**, not a mandatory production dependency unless measured relevance, scale or feature needs justify it. Master database query planning and index costs before accepting claims based on a demo.

## 7. What changes in production with a second search engine? (supplementary)

PostgreSQL remains the authoritative source for event state, ownership, publishing permissions and booking availability. A search index is a **derived view/copy**, not a second source of truth.

~~~mermaid
sequenceDiagram
    participant O as Organizer
    participant API as EventHub API
    participant PG as PostgreSQL source of truth
    participant IDX as Indexing process
    participant ES as Search index
    participant U as Attendee
    O->>API: Publish / update / cancel event
    API->>PG: Validate and commit authoritative state
    PG-->>API: Committed
    API-->>O: Saved
    Note over PG,ES: An asynchronous indexing strategy introduces possible lag
    PG-->>IDX: Changed event (selected sync mechanism)
    IDX->>ES: Upsert / remove searchable document
    U->>API: Search public events
    API->>ES: Query candidate event IDs
    ES-->>API: Matches + scores
    API->>PG: Re-check authoritative visibility if needed
    API-->>U: Allowed, current results
~~~

This is a **design illustration**, not a workflow already running in EventHub. The actual indexing handoff could be synchronous, worker-based, an outbox, a polling indexer or another explicit strategy; each has failure windows and trade-offs.

Things that can go wrong:

- **Stale reads:** a recently published event is missing; an updated title still shows the old text; an unpublished/cancelled event still appears.
- **Lost or reordered updates:** delayed jobs can overwrite a newer version; replay must be safe and version-aware.
- **Partial failures:** PostgreSQL commit succeeds while indexing fails; reconciliation/reindexing must be possible.
- **Permissions:** an indexed private/unpublished event must not leak via public search or preview fields. A separate index is not an authorization boundary.
- **Relevance drift:** mappings/analyzers change, causing surprise ranking changes and reindex requirements.
- **Cost and latency:** an extra network hop, separate backups/retention considerations, operational dashboards, CPU/RAM/storage, and query abuse from wildcards/fuzzy expansion.

If search goes down, choose explicitly whether to degrade to a limited PostgreSQL search or return a controlled failure. Do not silently confirm a booking from stale search data.

### How to benchmark responsibly

Measure under **comparable** conditions with the same documented dataset and filters:

- Publish seed-data generation rules, row counts, title/description lengths, language distribution and indexes.
- Keep query semantics comparable; record analyzer/matching differences separately.
- Measure representative queries: frequent/rare terms, no matches, short/common terms, multi-term AND/OR, typo, filter plus sort, and pagination.
- Report warm and cold behavior where feasible; collect repeated **p50, p95, error rate**, query-plan evidence (`EXPLAIN (ANALYZE, BUFFERS)` for PostgreSQL) and response payload size.
- Record hardware/container limits, engine versions, timeouts, load, connection counts and whether latency includes network + serialization.
- Inspect **write/indexing overhead** and **freshness lag** after event updates; do not focus exclusively on read timing.
- Label missing experiments and avoid extrapolating 50,000 rows to millions without measurements.

## 8. Discussion, corrections and unresolved questions

Our teaching session walked through the catalog problem, the librarian/scan analogy, a visual inverted index for EventHub, BM25 and field boosts, `text` vs `keyword`, typo/type-ahead behavior, the lecture's benchmark and the production synchronization trade-off.

| Possible misconception | Correction |
| --- | --- |
| PostgreSQL has no indexes or relevance-oriented search | PostgreSQL supports multiple index families and native full-text search. |
| `ILIKE` gives the best results first | It matches a pattern; relevance ordering needs separate ranking. |
| Inverted indexes always make every query fast | Indexing and broad/wildcard/fuzzy queries still have real costs. |
| `title^3` mathematically triples every result's whole score | It is query field boosting; final scoring remains multi-factor. |
| Typo correction comes for free with Elasticsearch | Fuzzy matching / suggesters / prefix behavior must be configured and verified. |
| `text` matches any substring | Analyzed text matching uses tokens/analysis, not arbitrary substring semantics by default. |
| Elasticsearch always beats PostgreSQL | The demonstration compared a particular Elasticsearch query against unoptimized PostgreSQL `ILIKE`, not indexed PostgreSQL FTS. |
| Matching result counts prove equivalent search quality | Scores, ranking, page sizes and semantics may differ. |
| Indexed results are authoritative for cancellations or inventory | The relational database remains authoritative for permissions and booking state. |
| One region makes a benchmark universally fair | Hardware, indexing, payload, query semantics, warmup and repeatability also matter. |

**Unresolved learning check (not answered by the learner):** For an EventHub corpus of 20,000 events and straightforward title/description search, which initial approach should we choose: Elasticsearch, PostgreSQL full-text search, or unmeasured `ILIKE`? Preferred engineering direction: begin with PostgreSQL FTS and benchmark it against a simple baseline, then revisit Elasticsearch only if requirements/measurements justify it. Do **not** record that the learner selected an answer.

**Earlier questions:** No additional learner-specific questions beyond the above discussion/check were recorded for this lesson.

## 9. EventHub practical assignment — coding-agent handoff

### Problem, current repo state and learning goal

Enable attendee-facing search over **publicly searchable events** while learning the difference between SQL substring matching, PostgreSQL full-text indexing, and a dedicated search engine. The goal is a fair **correctness + relevance + performance lab**, not infrastructure adoption by default.

**At documentation time:** `docs/PROGRESS.md` reports lecture 12 PostgreSQL persistence for users/events implemented and lecture 13 Redis public event detail caching implemented (owner confirmed 2026-11-22). Lecture 14 queues/background jobs is learning-complete but **not implementation-complete**. The coding agent must inspect current `main`, schema/migrations, existing `/v1` route conventions, service/repository layers, existing authorization and tests **before** proposing any code. Do not assume optional location/category fields or a full bookings lifecycle already exist.

### Intended user-visible behavior

For a bounded non-empty query, return a paginated list of current public events matching supported title/description terms, with a deterministic documented ranking and stable tie-breaker. Never disclose private/draft/cancelled events to an unauthorized public caller. If the current state model does not have these statuses, use only the actually implemented visibility rules and note the gap; do not invent a complete publication workflow just for this lesson.

Use the existing endpoint convention when possible; **example only**: `GET /v1/events?q=backend&limit=20`. Route shape, response contract and search language are decisions to confirm against the implementation, not instructions to overwrite an existing REST design.

### Minimal incremental scope, with owner approval before coding

1. **Inspect and baseline.** Read current files, tests, schema/indexes and prior lecture notes. Establish existing visibility filters and a small representative synthetic event dataset. No real customer data.
2. **Plain SQL baseline.** Add or reuse a bounded `ILIKE` query on actual supported searchable fields. Parameterize SQL and document `%`/`_` literal-versus-wildcard behavior. Do not allow unrestricted `SELECT *` or unbounded response sizes.
3. **PostgreSQL FTS version.** Create a narrow, reversible migration for an appropriate GIN/FTS expression or stored vector, matched to the query. Define reasonable language configuration and stable order. Verify a real `EXPLAIN (ANALYZE, BUFFERS)` plan and compare against the baseline.
4. **Search relevance and validation.** Define title-vs-description priority, minimum/maximum `q` length, query normalization, escaping rules, limit bounds, empty-query behavior, no-match response and filter/visibility semantics. Preserve existing auth and controller/service/repository separation.
5. **Optional dedicated-engine lab only after baseline.** On explicit owner approval and within local resource limits, index the *same synthetic published events* into an isolated local Elasticsearch instance; document mapping and `multi_match`/boost rules, compare equivalent query intent and deliberately test update/deletion lag. Keep the backend operational when Elasticsearch is not running; do not turn it into a required production dependency.
6. **Record evidence.** Document implementation ADR if needed; keep code changes minimal, run actual tests/typecheck and record exact environment, query plans, commands, before/after results and limitations. This lecture does **not** authorize coding by itself.

### Acceptance criteria (observable and testable)

- [ ] Querying by event title and description returns sensible matches using existing public event data; no match returns an empty list, not an exception.
- [ ] Query handling is bounded, validated and parameterized; empty, whitespace-only, extremely long and wildcard-like inputs do not cause unintended full-table disclosure or uncontrolled work.
- [ ] Pagination is deterministic with an explicit tie-breaker; supported limits, empty results and malformed pagination are tested.
- [ ] Only authorized/publicly visible events appear, including after an event changes visibility; existing ownership and authentication behavior does not regress.
- [ ] PostgreSQL indexed FTS results and plan are demonstrated against an `ILIKE` baseline with documented index definition and comparable query scope.
- [ ] At least three relevant query cases are checked (title match, description match, no match); investigate typo behavior without promising automatic correction.
- [ ] A reproducible local comparison records dataset size, query semantics, repetitions, plan/latency and limitations; no fabricated speedup claims.
- [ ] If the optional Elasticsearch lab is approved, compare mappings, rankings and lag after create/update/unpublish, and demonstrate controlled behavior on search-engine outage.
- [ ] Existing HTTP, routing, auth, PostgreSQL and Redis cache regressions are tested as applicable; actual executed commands/results are appended to this document by the coding agent.
- [ ] No new frontend, production hosted Elasticsearch, paid cloud account or real customer data introduced. Implementation remains "Not started" until code, evidence and owner confirmation are complete.

### Experiments and negative cases

1. Compare `ILIKE` and PostgreSQL FTS for title-only match, description-only match, mixed terms, a common word, rare word and zero-match word.
2. Compare relevant ordering and explain when FTS token semantics differ from substring matching.
3. Generate synthetic datasets at **sizes feasible on the user's machine** (e.g., small/medium/larger), measure warmed repeated reads, and inspect query plans before drawing conclusions.
4. Try literal `%`/`_`, punctuation, Unicode, a typo (`labtop`) and Arabic/mixed-language event titles; document unsupported analyzer behavior instead of silently claiming good multilingual search.
5. Verify draft/unpublished/cancelled behavior using the **actual** existing status model; update an event title or publish state and repeat the search.
6. For optional Elasticsearch, deliberately stop the index service, delay an update/reindex operation and test stale copies, wrong ordering of updates and recovery/rebuild. Separate what is observed from what is only theoretical.
7. Ensure prior event detail caching does not cause a stale search result to authorize booking or expose private data; cache invalidation and search-index freshness are distinct concerns.

### Edge cases and production risks

- Unsupported language/diacritics, case variations, stemming, short tokens, stop words, punctuation and zero-token queries.
- Multiple ranking ties, deep pagination, offset bounds, unstable results when events are edited concurrently.
- Synonyms/typo expansions too broad or expensive; query DSL injection/reserved syntax if raw `query_string` is exposed without constraints.
- Filters for status, organizer, date and category must use existing schema/invariants, never inferred unpublished fields.
- Duplicate indexes, expensive backfills, migration rollback, changed analyzers and reindexing cost.
- Search-index lag and out-of-order update delivery if a separate search engine is used.
- Service outages: truthful degraded behavior without violating authorization or source-of-truth boundaries.
- Leakage of secret or private fields into a public indexed document, errors or logs.

### Deferred / out of scope

- Production Elasticsearch adoption or managed/paid Elastic Cloud.
- Real booking/ticket issuance, inventory synchronization, recommendation models or semantic/vector/AI search.
- A production-quality multilingual analyzer and autocomplete UI; those require separate requirements and measurement.
- Distributed search clusters, large-scale performance guarantees, real traffic SLOs, complicated indexing/outbox architecture or a new observability stack.
- Full frontend; remains deferred by EventHub roadmap and owner instructions.

### Open implementation decisions

- Which searchable fields and publication states **actually exist** in the current schema?
- Is search mainly token-based, substring-based, typo-tolerant, multilingual, or a combination? What is the minimum correct product behavior?
- Is a simple title-heavy PostgreSQL FTS score adequate for the first release?
- What synthetic data and environment allow an honest comparison?
- Does optional Elasticsearch bring enough relevance/feature value to justify another service and eventual consistency?

## 10. Key takeaways and references

**Memory aid:** naive text scan → **term-to-document inverted index** → candidate matching → **relevance scoring** → bounded ranked result page. Search architecture adds **indexing costs and consistency questions**, not only speed.

- [Original lecture: Full text search using Elasticsearch](https://www.youtube.com/watch?v=7_sovzAhRSM).
- [Independent timestamped notes, video-frame references and ASR transcript](https://github.com/shubhamscifi/backend_from_first_principles_notes/tree/main/15_full_text_search_elasticsearch) — **secondary** source reviewed for the teaching discussion.
- [PostgreSQL: Full Text Search](https://www.postgresql.org/docs/current/textsearch.html) — supplementary technical reference.
- [PostgreSQL: pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) — supplementary technical reference.
- [Elasticsearch: Text field type](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/text) — supplementary reference.
- [Elasticsearch: Keyword field type](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/keyword) — supplementary reference.
- [Elasticsearch: BM25 similarity](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity) — supplementary reference.
- [Elasticsearch near-real-time search](https://www.elastic.co/guide/en/elasticsearch/reference/current/near-real-time.html) — supplementary reference; verify current URLs/version when implementing.
- [EventHub lecture 12: PostgreSQL](12-mastering-databases-postgres.md), [lecture 13: Redis caching](13-caching.md), [lecture 14: Queues](14-task-queues-background-jobs.md), [product spec](../PROJECT_SPEC.md).

## Learning completion (ChatGPT)

- [x] Owner explicitly requested uploading the lecture discussion to GitHub (2026-11-23).
- [x] Concepts, diagrams, demo-specific caveats, supplementary corrections and EventHub assignment recorded.
- [x] Learning completion to be recorded independently in `docs/PROGRESS.md` in this upload workflow.

## Implementation evidence (coding agent)

**Status: implemented, awaiting owner review.** Scope: PostgreSQL substring baseline vs. PostgreSQL FTS (steps 1-4, 6). The optional Elasticsearch lab was **not** done (needs owner approval). See [ADR-014](../decisions/014-fts-event-search.md). Not committed yet.

**Repo reality found first:** events have only `name` and `seats` (no description, no draft/cancelled state, no category), so only the name is searchable, every event is public, and "title vs description priority" does not apply yet. `GET /api/v1/events/search` already existed as a mock; it now runs the real search. `GET /api/v1/events?q=` (lecture 11 substring filter) is the **baseline** and is unchanged.

**Changes:** `migrations/003_event_name_fts.sql` (GIN on `to_tsvector('simple', name)`); `PgEventRepository.search`, `EventService.search`, `parseSearchQuery` (validation.ts), `searchV1` (controller); `test/search.test.ts`; `experiments/search-compare.ts` (`npm run experiment:search`); two existing tests updated for the third migration and the new `search()` return shape.

**Commands and results (2026-11-23, local, PostgreSQL 17.11 in Docker, Node v24.22.1):**
- `npm run typecheck`: clean.
- `npm test`: 256 tests, 256 pass, 0 fail (includes the new search tests and all earlier regressions: HTTP, routing, auth, PostgreSQL, Redis cache, queues).
- `ROWS=20000 npm run experiment:search` and `ROWS=200000 ...`: full output in [20k](../evidence/lecture-15-search-20k.txt) and [200k](../evidence/lecture-15-search-200k.txt).

**Median of 15 warm runs, `LIMIT 10`, ms, with the GIN index (client round trip included; noisy machine, other containers running):**

| Query (200,000 rows) | substring `position()` | `ILIKE '%t%'` | FTS ranked |
| --- | ---: | ---: | ---: |
| rare word (225 matches) | 15.7 | 187.5 | 2.6 |
| very common word (115,402 matches) | 0.8 | 1.0 | 300.6 |
| no match (`labtop`) | 220.7 | 145.8 | 1.0 |

At 20,000 rows the same shape: rare 1.5 ms (FTS) vs 35 ms (ILIKE); common 42.7 ms (FTS) vs 1.3 ms. Before the index FTS was *slower* than ILIKE (520 ms rare at 200k) because it computes a tsvector per row. Plans confirm `Bitmap Index Scan on events_name_fts_idx` for FTS and `Seq Scan` for ILIKE on rare terms.

**Findings:** (1) the index is what makes FTS fast, the engine alone is not; (2) FTS loses on a very common word with `LIMIT 10`: the substring scan stops after 10 hits, while ranking must score all 115k matches; (3) the write cost of the index was +35% on a single 50k-row insert (2093 vs 1549 ms, one run, indicative only); index size 776 kB for 200k short names; (4) no fairness claim beyond this synthetic, skewed, single-field dataset.

**Negative cases tested (HTTP, `test/search.test.ts`):** missing/blank/101-char/repeated `q`, bad `page`/`limit` = 400; `%`, `_`, `'; DROP TABLE events; --`, `jazz | engineering`, `jazz & !night`, `!!!` are plain data (nothing dropped; `!` does not negate; punctuation-only matches nothing); no-match = 200 empty; page past the end = 200 empty with `total`; rename and delete are visible immediately. Typo (`labtop`, `jazzz`) and partial word (`jaz`) return nothing: no automatic correction. Arabic title matches on a whole token (`الذكاء`); Arabic stemming is unsupported by design (`simple`).

**Answer to the lecture's design check (20,000 events, simple search):** PostgreSQL FTS first, measured against the baseline, as the numbers above show for rare terms; Elasticsearch only if measured relevance/features justify it. This is the agent's recommendation, not a recorded learner answer.

**Not done / limitations:** Elasticsearch lab and outage/lag experiments; description field and visibility filtering (do not exist); `pg_trgm`/prefix/typo search; multilingual analyzers; interaction with the lecture-13 detail cache (search is not cached and never feeds booking or authorization).

- [x] Implementation and reproducible experiment (uncommitted working tree).
- [x] Query-plan and latency evidence with commands, environment and limitations.
- [x] Negative cases and regression run.
- [ ] Owner confirms implementation completion (required before PROGRESS marks it complete).
