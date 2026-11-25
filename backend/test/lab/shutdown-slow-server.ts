import { createServer } from "node:http";
import { createReadyHandler } from "../../src/http/health.ts";
import { forceCloseConnections, httpShutdownSteps } from "../../src/lifecycle/http.ts";
import { createShutdown, installSignalHandlers, lifecycleLog } from "../../src/lifecycle/shutdown.ts";

// ISOLATED lecture 19 lab (test-only, never imported by the app): a tiny server with a deliberately
// slow route, wired through the SAME shutdown coordinator and HTTP steps as src/server.ts, so the
// experiments ("slow request during SIGTERM", "deadline exceeded", ...) need no debug endpoint in
// the real API.  GET /slow?ms=N answers after N ms.  FAIL_STEP=1 adds a cleanup step that throws.
const port = Number(process.env["LAB_PORT"]);
const timeoutMs = Number(process.env["SHUTDOWN_TIMEOUT_MS"] ?? 10_000);
const drainDelayMs = Number(process.env["SHUTDOWN_DRAIN_DELAY_MS"] ?? 0);

const server = createServer((req, res) => {
  if (shutdown.draining && !req.url?.startsWith("/ready")) {
    res.writeHead(503, { Connection: "close" }).end("draining");
    return;
  }
  if (req.url?.startsWith("/ready")) {
    void createReadyHandler({ query: async () => 1 }, 1000, () => shutdown.draining)(req, res);
    return;
  }
  const ms = Number(new URL(req.url ?? "/", "http://x").searchParams.get("ms") ?? 0);
  setTimeout(() => res.end("done"), ms);
});

const shutdown = createShutdown({
  deadlineMs: timeoutMs,
  log: lifecycleLog,
  exit: (code) => process.exit(code),
  onDeadline: () => forceCloseConnections(server),
  steps: [
    ...httpShutdownSteps(server, drainDelayMs),
    ...(process.env["FAIL_STEP"] ? [{ name: "failing-cleanup", run: () => Promise.reject(new Error("boom with secret-host.internal")) }] : []),
    { name: "after-failure", run: async () => void lifecycleLog("info", "lab.later_step_ran") },
  ],
});
installSignalHandlers(shutdown);
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ lab: "listening" })));
