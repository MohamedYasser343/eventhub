// Lecture 21/22: a small closed-loop HTTP load generator on native Node primitives (no download;
// k6 is the usual tool, this is the "equivalent repeatable tool" the assignment allows).
//
// Closed loop: VUS virtual users, each sends the next request as soon as the previous one finishes.
// That means offered load adapts to the server (offered == achieved). It cannot show behaviour past
// saturation the way an open-loop arrival model does; this is a stated limitation of every number here.
//
//   BASE_URL=http://127.0.0.1:8080 SCENARIO=detail-hot VUS=50 DURATION_S=20 WARMUP_S=5 LABEL=baseline \
//     npm run bench:load
// Output: one human summary and one JSON line. Percentiles use the nearest-rank method on every
// sample of the measured window (warm-up excluded); nothing is averaged across runs.
import http from "node:http";
import { createHash } from "node:crypto";

const env = (k: string, d: string) => process.env[k] ?? d;
const BASE = new URL(env("BASE_URL", "http://127.0.0.1:8080"));
const SCENARIO = env("SCENARIO", "detail-hot");
const VUS = Number(env("VUS", "10"));
const DURATION_MS = Number(env("DURATION_S", "20")) * 1000;
const WARMUP_MS = Number(env("WARMUP_S", "5")) * 1000;
const TIMEOUT_MS = Number(env("TIMEOUT_MS", "10000"));
const ROWS = Number(env("ROWS", "300000"));
const LABEL = env("LABEL", "run");
if (![VUS, DURATION_MS, WARMUP_MS, TIMEOUT_MS, ROWS].every((n) => Number.isFinite(n) && n >= 0) || VUS < 1) throw new Error("bad numeric setting");

const rnd = (n: number) => 1 + Math.floor(Math.random() * n);
const selectiveToken = createHash("md5").update("12345").digest("hex").slice(0, 12); // ~1 matching row
const SCENARIOS: Record<string, () => string> = {
  "list-plain": () => "/api/v1/events?limit=10",
  "list-selective": () => `/api/v1/events?q=${selectiveToken}&limit=10`,
  "list-broad": () => "/api/v1/events?q=conference&minSeats=50000&limit=10",
  "search-broad": () => "/api/v1/events/search?q=conference&limit=10",
  "detail-hot": () => `/api/v1/events/${rnd(200)}`, // 200 distinct ids: cache-friendly
  "detail-random": () => `/api/v1/events/${rnd(ROWS)}`, // spread over every row: mostly misses at first
  // mixed-duration workload (lecture 22): mostly cheap cached reads plus a heavy counting query
  mixed: () => (Math.random() < 0.9 ? `/api/v1/events/${rnd(200)}` : "/api/v1/events?q=conference&minSeats=50000&limit=10"),
};
const pick = SCENARIOS[SCENARIO];
if (!pick) throw new Error(`unknown SCENARIO ${SCENARIO}; one of ${Object.keys(SCENARIOS).join(", ")}`);

const agent = new http.Agent({ keepAlive: true, maxSockets: VUS });
type Outcome = "2xx" | "3xx" | "4xx" | "429" | "5xx" | "timeout" | "error";
const samples: number[] = []; // latency ms of every measured request that got a response
const counts: Record<Outcome, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "429": 0, "5xx": 0, timeout: 0, error: 0 };
const upstreams = new Map<string, number>();

function once(path: string): Promise<{ outcome: Outcome; ms: number; upstream?: string }> {
  const start = performance.now();
  return new Promise((resolve) => {
    const req = http.request({ host: BASE.hostname, port: BASE.port, path, agent, method: "GET", timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      res.on("end", () => {
        const s = res.statusCode ?? 0;
        const outcome: Outcome = s === 429 ? "429" : s >= 500 ? "5xx" : s >= 400 ? "4xx" : s >= 300 ? "3xx" : "2xx";
        const up = res.headers["x-upstream"];
        resolve({ outcome, ms: performance.now() - start, upstream: typeof up === "string" ? up : undefined });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ outcome: "timeout", ms: performance.now() - start });
    });
    req.on("error", () => resolve({ outcome: "error", ms: performance.now() - start }));
    req.end();
  });
}

const t0 = performance.now();
const measureFrom = t0 + WARMUP_MS;
const endAt = measureFrom + DURATION_MS;
const cpu0 = process.cpuUsage();
let cpuAtMeasure = cpu0;
setTimeout(() => (cpuAtMeasure = process.cpuUsage()), WARMUP_MS);

async function vu(): Promise<void> {
  while (performance.now() < endAt) {
    const r = await once(pick!());
    if (performance.now() < measureFrom) continue; // warm-up: discarded
    counts[r.outcome]++;
    if (r.outcome !== "timeout" && r.outcome !== "error") samples.push(r.ms);
    if (r.upstream) upstreams.set(r.upstream, (upstreams.get(r.upstream) ?? 0) + 1);
  }
}
await Promise.all(Array.from({ length: VUS }, vu));
const cpu = process.cpuUsage(cpuAtMeasure);

samples.sort((a, b) => a - b);
const nearestRank = (p: number) => (samples.length ? samples[Math.min(samples.length - 1, Math.max(0, Math.ceil((p / 100) * samples.length) - 1))]! : NaN);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const ok = counts["2xx"] + counts["3xx"];
const secs = DURATION_MS / 1000;
const f = (n: number) => Math.round(n * 100) / 100;
const result = {
  label: LABEL, scenario: SCENARIO, vus: VUS, durationS: secs, warmupS: WARMUP_MS / 1000, samples: samples.length, requests: total,
  successRps: f(ok / secs), p50: f(nearestRank(50)), p95: f(nearestRank(95)), p99: f(nearestRank(99)), max: f(samples.at(-1) ?? NaN),
  statuses: counts, errorRate: f(total ? (total - ok) / total : NaN),
  loadGenCpuPct: f(((cpu.user + cpu.system) / 1000 / DURATION_MS) * 100), // % of ONE core over the measured window
  ...(upstreams.size > 1 || [...upstreams.keys()][0] ? { upstreams: Object.fromEntries(upstreams) } : {}),
};
console.log(
  `[${LABEL}] ${SCENARIO} vus=${VUS} ${secs}s: ${result.samples} samples, ${result.successRps} ok-req/s, ` +
    `p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms max=${result.max}ms, status=${JSON.stringify(counts)}, loadgen cpu=${result.loadGenCpuPct}% of 1 core`,
);
console.log("JSON " + JSON.stringify(result));
agent.destroy();
