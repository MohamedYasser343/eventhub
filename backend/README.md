# Backend

Learning implementation of the EventHub HTTP boundary (lecture 05). Native `node:http` on Node/TypeScript, in-memory synthetic data, no framework and no database. See [ADR-001](../docs/decisions/001-backend-language-and-tooling.md) and [`../docs/lectures/05-http.md`](../docs/lectures/05-http.md). Not production-ready: state resets on restart, there is no authentication, persistence or concurrency control.

## Run

```bash
cd backend
npm install
npm start          # http://127.0.0.1:8080  (PORT=9000 npm start to change the port)
npm run dev        # same, restarts on file changes
npm test           # node:test, starts its own server on a random port
npm run typecheck  # tsc --noEmit
```

The server listens on `127.0.0.1` only. Set `CORS_ORIGIN` to change the single browser origin allowed to read responses (default `http://localhost:3000`). Set `LOG_REQUESTS=1` to print one JSON line per response (request id, method, path, status, duration, user id; never query, headers or bodies). Every response carries `X-Request-Id`.

## Endpoints

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| GET, HEAD | `/health` | 200 | `{"status":"ok"}` |
| GET, HEAD | `/events` | 200 | JSON list |
| POST | `/events` | 201 + `Location` | body `{"name": 1-100 chars, "seats": integer 0-100000}` |
| OPTIONS | `/events`, `/events/:id` | 204 + `Allow` | CORS preflight answered for the allowed origin only |
| GET, HEAD | `/events/:id` | 200 + `ETag` | `If-None-Match` match returns 304 |
| PUT | `/events/:id` | 200 | full replacement; 404 if absent |
| DELETE | `/events/:id` | 204 | 404 if absent |

Errors: 400 malformed JSON, 404 unknown path/id (ids must match `^[1-9][0-9]*$`), 405 + `Allow` for a known path with an unsupported method, 413 body over 16 KB, 415 non-JSON `Content-Type`, 422 invalid fields. Decisions: [ADR-002](../docs/decisions/002-event-creation-rules.md), [ADR-003](../docs/decisions/003-put-delete-semantics.md), [ADR-004](../docs/decisions/004-head-options-cors-etag.md).

## Try it

```bash
curl -v --http1.1 http://localhost:8080/events
curl -i -X POST -H 'Content-Type: application/json' -d '{"name":"Demo","seats":10}' http://localhost:8080/events
curl -i http://localhost:8080/events/1                                  # note the ETag
curl -i -H 'If-None-Match: "<etag from above>"' http://localhost:8080/events/1   # 304
```

## Browser CORS experiment (disposable)

The page in `experiments/cors-test/` calls the API from another origin. Serve it from the allowed origin, then from a rejected one, and watch DevTools (Network and Console) and the server log:

```bash
LOG_REQUESTS=1 npm start                                              # terminal 1
cd experiments/cors-test && python3 -m http.server 3000 --bind 127.0.0.1   # terminal 2
# open http://localhost:3000   (allowed)  and  http://127.0.0.1:3000   (rejected), click "Run all"
```
