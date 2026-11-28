// Lecture 23 experiments (local, synthetic, nothing here is a route of the product).
//   npm run experiment:concurrency
// Part 1: I/O overlap with a bounded pool.  Part 2: CPU on the event loop vs in a worker.
import { createServer } from "node:http";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import pg from "pg";

const CPU_ITER = 100_000_000; // fixed workload (about 1-2 s on the author machine)
function burn(n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x = (x + i * 7) % 1_000_003;
  return x;
}

if (!isMainThread) {
  parentPort!.postMessage(burn((workerData as { n: number }).n)); // one job per short-lived worker (a pool would reuse it)
} else {
  const ms = (t: number) => Math.round(performance.now() - t);

  // ---- Part 1: 20 independent 80 ms waits (pg_sleep stands in for a slow query) ----
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 10 });
  const one = () => pool.query("SELECT pg_sleep(0.08)");
  const N = 20;
  await one(); // warm a connection
  let t = performance.now();
  for (let i = 0; i < N; i++) await one();
  console.log(`io sequential        : ${N} waits in ${ms(t)} ms`);
  t = performance.now();
  await Promise.all(Array.from({ length: N }, one));
  console.log(`io Promise.all       : ${N} waits in ${ms(t)} ms (pool max 10 => two waves, extra callers queue)`);
  for (const limit of [2, 5]) {
    t = performance.now();
    let next = 0;
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (next++ < N) {
          active++;
          peak = Math.max(peak, active);
          await one();
          active--;
        }
      }),
    );
    console.log(`io bounded (limit ${limit}) : ${N} waits in ${ms(t)} ms, peak in flight ${peak}, pool waiting now ${pool.waitingCount}`);
  }
  await pool.end();

  // ---- Part 2: /health while a CPU calculation runs ----
  const server = createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  async function probe(label: string, work: () => Promise<unknown>): Promise<void> {
    const lat: number[] = [];
    let running = true;
    const prober = (async () => {
      while (running) {
        const s = performance.now();
        await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
        lat.push(performance.now() - s);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const s = performance.now();
    await work();
    const total = ms(s);
    running = false;
    await prober;
    lat.sort((a, b) => a - b);
    const pct = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!);
    console.log(`${label}: work ${total} ms | health probes ${lat.length}, p50 ${pct(0.5)} ms, max ${Math.round(lat.at(-1)!)} ms`);
  }
  await probe("cpu on main thread ", async () => void burn(CPU_ITER));
  await probe("cpu in worker      ", () => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { n: CPU_ITER } });
    w.once("message", res).once("error", rej);
  }));
  server.close();
}
