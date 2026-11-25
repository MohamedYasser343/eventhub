import { AsyncLocalStorage } from "node:async_hooks";

// Lecture 18: the HTTP request id of the operation running in THIS async call chain. (The trace
// context itself lives in OpenTelemetry's own context, see otel.ts.) AsyncLocalStorage keeps one
// value per request even while many requests interleave on the single event loop. It does NOT
// cross a process boundary: queue jobs carry a correlation id explicitly instead.
export interface Scope {
  requestId: string;
}

const store = new AsyncLocalStorage<Scope>();

export const currentScope = (): Scope | undefined => store.getStore();
export const runInScope = <T>(scope: Scope, fn: () => T): T => store.run(scope, fn);
