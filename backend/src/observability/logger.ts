import { currentTraceId } from "./otel.ts";
import { currentScope } from "./scope.ts";

// Lecture 18: ONE structured-logging boundary. Every record is a single JSON line with
// stable names: timestamp (UTC), level, event, service, plus requestId/traceId taken from
// the current request scope, plus the caller's own fields (redacted and bounded).
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// The single output point (a sink, so tests can capture lines). null = logging disabled.
// This is the same object lecture 10 introduced as `logSink`; it is only moved here.
export const logSink: { write: ((line: string) => void) | null } = { write: null };
export const logSettings: { level: LogLevel; service: string } = { level: "info", service: "api" };

// Keys whose VALUES are never emitted, whatever they contain.
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|credential|card|ssn|jwt/i;
const MAX_STRING = 200;
const MAX_DEPTH = 3;

// Strings can come from clients: strip control characters (so a value cannot forge a
// second log line) and cap the length.
function cleanString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  return flat.length > MAX_STRING ? `${flat.slice(0, MAX_STRING)}...` : flat;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cleanString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (value instanceof Error) return value.name; // never message or stack: they can embed SQL, hosts, data
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(typeof value);
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const write = logSink.write;
  if (!write || RANK[level] < RANK[logSettings.level]) return;
  const scope = currentScope();
  const traceId = currentTraceId();
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: logSettings.service,
    ...(scope ? { requestId: scope.requestId } : {}),
    ...(traceId ? { traceId } : {}),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in record)) record[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v);
  }
  try {
    write(JSON.stringify(record));
  } catch {
    // A broken log sink must never fail the operation being logged.
  }
}
