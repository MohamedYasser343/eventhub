import { log as defaultLog, logSink } from "../observability/logger.ts";
import type { LogLevel } from "../observability/logger.ts";

// Lecture 19: ONE shutdown coordinator, used by the API process and the worker process
// (two separate OS processes, each owning its own resources).
//
//   signal -> draining (stop admitting work) -> steps in dependency order -> exit
//
// Policies, all explicit:
//  * Idempotent: the first signal starts the sequence; a repeated SIGTERM/SIGINT is logged
//    and IGNORED (same promise returned). Escalation is the hard deadline, not a second signal.
//  * Bounded: one hard deadline covers the whole sequence. When it fires the process exits 1
//    and the log names the step that had not finished. A timer only stops WAITING; it cannot
//    cancel work already inside a driver, so `onDeadline` is where a caller actually kills
//    something (e.g. destroys sockets).
//  * Best effort: a failing step is logged and the remaining steps still run; the exit code is 1.
//  * Exit happens AFTER the awaited cleanup (never from the signal callback), via an injected
//    `exit` so tests can observe the code without killing the test runner.
export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  deadlineMs: number;
  exit: (code: number) => void;
  onDeadline?: () => void | Promise<void>;
  log?: (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;
}

export interface Shutdown {
  /** true from the first signal on; read by the readiness probe and by the request admission check. */
  readonly draining: boolean;
  trigger(signal: string): Promise<number>;
}

export function createShutdown(o: ShutdownOptions): Shutdown {
  const log = o.log ?? defaultLog;
  let started: Promise<number> | undefined;
  let draining = false;
  let current = "none"; // the step being waited on, for the deadline report

  async function sequence(signal: string): Promise<number> {
    const t0 = Date.now();
    draining = true;
    log("info", "shutdown.signal_received", { signal, deadlineMs: o.deadlineMs });
    log("info", "shutdown.draining_started", { steps: o.steps.map((s) => s.name) });

    let failures = 0;
    let finished = false;
    let fired = false;
    const timedOut = () => fired;
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        if (finished) return;
        fired = true;
        failures++;
        log("error", "shutdown.deadline_exceeded", { deadlineMs: o.deadlineMs, pendingStep: current, elapsedMs: Date.now() - t0 });
        void Promise.resolve()
          .then(() => o.onDeadline?.())
          .catch(() => {})
          .finally(() => {
            log("error", "shutdown.forced_exit", { code: 1 });
            o.exit(1);
            resolve(1);
          });
      }, o.deadlineMs);
      timer.unref();
    });

    const work: Promise<number> = (async () => {
      for (const step of o.steps) {
        current = step.name;
        const s0 = Date.now();
        try {
          await step.run();
          log("info", "shutdown.step_done", { step: step.name, durationMs: Date.now() - s0 });
        } catch (err) {
          failures++;
          // Name only: an error message from a driver can embed hosts or SQL.
          log("error", "shutdown.step_failed", { step: step.name, error: err instanceof Error ? err.name : "non-error thrown" });
        }
        if (timedOut()) return 1; // the deadline already decided; do not run more steps or exit twice
      }
      finished = true;
      clearTimeout(timer);
      current = "none";
      const code = failures > 0 ? 1 : 0;
      log(code === 0 ? "info" : "error", "shutdown.complete", { code, elapsedMs: Date.now() - t0 });
      o.exit(code);
      return code;
    })();

    return Promise.race([work, deadline]);
  }

  return {
    get draining() {
      return draining;
    },
    trigger(signal) {
      if (started) {
        log("warn", "shutdown.signal_ignored", { signal, reason: "already shutting down" });
        return started;
      }
      started = sequence(signal);
      return started;
    },
  };
}

// Registered as early as possible by the entry point. SIGKILL cannot be handled, by design.
export function installSignalHandlers(shutdown: Shutdown, proc: Pick<NodeJS.Process, "on"> = process): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    proc.on(sig, () => void shutdown.trigger(sig));
  }
}

// Lifecycle lines must reach stdout even when request logging is off (LOG_REQUESTS=0 leaves the
// sink null). The sink is borrowed for this one synchronous call and restored, so request logs stay off.
export function lifecycleLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const prev = logSink.write;
  if (!prev) logSink.write = (line) => console.log(line);
  try {
    defaultLog(level, event, fields);
  } finally {
    logSink.write = prev;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
