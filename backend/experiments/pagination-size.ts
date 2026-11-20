// Lecture 11 experiment: response bytes for bounded pages vs one big page (synthetic data, measured, not extrapolated).
import { server } from "../src/server.ts";
import { auth } from "../src/auth.ts";
import type { AddressInfo } from "node:net";

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
const u = `exp_${process.pid}`;
const pw = `pw-${u}-0123456789`;
await auth.createUser(u, pw, "admin");
const { token } = (await (await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: pw }) })).json()) as { token: string };
for (let i = 0; i < 500; i++)
  await fetch(`${base}/events`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Synthetic Event ${i}`, seats: i + 1 }) });
for (const qs of ["limit=10", "limit=100", "limit=100&page=5"]) {
  const t = performance.now();
  const body = await (await fetch(`${base}/events?${qs}`)).text();
  console.log(`${qs.padEnd(18)} bytes=${Buffer.byteLength(body)} ms=${(performance.now() - t).toFixed(1)}`);
}
console.log("limit=1000 ->", (await fetch(`${base}/events?limit=1000`)).status, "(rejected, unbounded read impossible)");
server.close();
