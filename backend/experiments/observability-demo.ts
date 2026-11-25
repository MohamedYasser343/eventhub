// Lecture 18 experiment: drive a few requests (ok, 404, slow, failing) and print the
// correlated signals: log lines, metrics text and the span tree. Local only; run:
//   npm run experiment:observability
import { logSettings, logSink } from "../src/observability/logger.ts";
import { flushSpans, recentSpans, renderMetrics } from "../src/observability/otel.ts";
import { server } from "../src/server.ts";
import { pool } from "../src/db/pool.ts";
import type { AddressInfo } from "node:net";

logSettings.level = "debug";
logSink.write = (l) => console.log("LOG   ", l);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const real = pool.query.bind(pool);
const get = async (p: string) => console.log("HTTP  ", p, (await fetch(base + p)).status);

await get("/api/v1/events/1");
await get("/api/v1/events/99999");
(pool as { query: unknown }).query = async (...a: unknown[]) => (await new Promise((r) => setTimeout(r, 300)), (real as (...x: unknown[]) => unknown)(...a));
await get("/api/v1/events/99998"); // slow dependency (id 1 is now served from the cache, so use an uncached id)
(pool as { query: unknown }).query = async () => {
  throw Object.assign(new Error("injected"), { code: "ECONNREFUSED" });
};
await get("/api/v1/events/99998"); // dependency down
(pool as { query: unknown }).query = real;
await flushSpans();
for (const s of recentSpans()) console.log("SPAN  ", JSON.stringify({ trace: s.traceId.slice(0, 8), span: s.spanId.slice(0, 6), parent: s.parentId?.slice(0, 6), name: s.name, ms: Math.round(s.durationMs), status: s.status }));
console.log((await renderMetrics()).split("\n").filter((l) => /^http_server_request_duration_(count|sum)/.test(l)).join("\n"));
server.close();
await pool.end();
