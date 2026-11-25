import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Counter, Histogram, Span, UpDownCounter } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// Lecture 18 (ADR-017, revised): OpenTelemetry for traces and metrics. The OTel SDK is the
// instrumentation layer; WHERE telemetry goes (here: an in-memory ring for spans, Prometheus text
// for metrics) is a swappable exporter, so a real Collector/Tempo/Prometheus can replace them
// later without touching the instrumented code.
const resource = resourceFromAttributes({ "service.name": "eventhub" });

// ---------- context + propagation ----------
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// ---------- traces ----------
export const MAX_PENDING_SPANS = 500;
export const EXPORT_BATCH = 100;
export const EXPORT_TIMEOUT_MS = 1_000;

export type SpanExportFn = (spans: ReadableSpan[]) => void | Promise<void>;

// Default sink: a ring of the most recent finished spans (inspected by tests and the experiment).
const RECENT_MAX = 500;
const recent: ReadableSpan[] = [];
const memorySink: SpanExportFn = (spans) => {
  recent.push(...spans);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
};
let sink: SpanExportFn = memorySink;
export const setSpanExporter = (fn: SpanExportFn): void => void (sink = fn);
export const resetSpanExporter = (): void => void (sink = memorySink);
export const clearRecentSpans = (): void => void (recent.length = 0);

// A flat view of a finished span, for tests, the experiment and humans.
export interface SpanView {
  traceId: string;
  spanId: string;
  parentId: string | undefined;
  name: string;
  server: boolean;
  durationMs: number;
  status: "ok" | "error";
  attributes: Attributes;
}
export const recentSpans = (): SpanView[] =>
  recent.map((s) => ({
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentId: s.parentSpanContext?.spanId,
    name: s.name,
    server: s.kind === SpanKind.SERVER,
    durationMs: s.duration[0] * 1_000 + s.duration[1] / 1e6,
    status: s.status.code === SpanStatusCode.ERROR ? "error" : "ok",
    attributes: s.attributes,
  }));

// Spans that ended but have not finished exporting. This is the memory bound: a span that ends
// while MAX_PENDING_SPANS are already waiting is dropped (and counted), never queued.
let pending = 0;
export const pendingSpanCount = (): number => pending;

// Wraps the exporter function: a hard timeout, no retry, a throw/reject/timeout drops the batch
// and counts it. The export runs off the request path (BatchSpanProcessor timer), so a dead sink
// can lose telemetry but never delays or crashes a request.
const boundedExporter: SpanExporter = {
  export(spans, done) {
    let finished = false;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending -= spans.length;
      if (!ok) m.dropped.add(spans.length, { signal: "span" });
      done({ code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
    };
    const timer = setTimeout(() => finish(false), EXPORT_TIMEOUT_MS);
    timer.unref();
    try {
      Promise.resolve(sink(spans)).then(() => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  },
  shutdown: async () => {},
};

const batch = new BatchSpanProcessor(boundedExporter, {
  maxQueueSize: MAX_PENDING_SPANS * 2, // our guard below is the real limit
  maxExportBatchSize: EXPORT_BATCH,
  scheduledDelayMillis: 1_000,
  exportTimeoutMillis: EXPORT_TIMEOUT_MS + 500,
});
const guard: SpanProcessor = {
  onStart() {},
  onEnd(span) {
    if (pending >= MAX_PENDING_SPANS) return void m.dropped.add(1, { signal: "span" });
    pending++;
    batch.onEnd(span);
  },
  forceFlush: () => batch.forceFlush(),
  shutdown: () => batch.shutdown(),
};

const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [guard] });
export const tracer = tracerProvider.getTracer("eventhub");
// forceFlush rejects when an export failed; the failure is already counted as a drop, so it is swallowed here.
export const flushSpans = (): Promise<void> => guard.forceFlush().catch(() => {});

// W3C traceparent from the client is untrusted: only that one header is handed to the
// propagator (tracestate/baggage are never read), and a malformed or all-zero value yields no parent.
export function extractParent(traceparent: string | string[] | undefined) {
  return typeof traceparent === "string" ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
}

// Root span of a request. Returns the span and the context to run the request in.
export function startRequestSpan(traceparent: string | string[] | undefined, method: string) {
  const span = tracer.startSpan("HTTP", { kind: SpanKind.SERVER, attributes: { "http.request.method": method } }, extractParent(traceparent));
  return { span, ctx: trace.setSpan(extractParent(traceparent), span) };
}

// Runs fn inside a child span of the current request. With no active request span (a plain call
// outside HTTP) it just runs fn. A throw marks the span failed (class name only, no message) and is
// re-thrown unchanged, so tracing never alters the application's error behavior.
export async function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  if (!trace.getActiveSpan()) return fn();
  return tracer.startActiveSpan(name, { attributes }, async (span: Span) => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (err) {
      span.setAttribute("error.type", err instanceof Error ? err.name : "unknown");
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  });
}

export const currentTraceId = (): string | undefined => trace.getActiveSpan()?.spanContext().traceId;
export { SpanStatusCode };

// ---------- metrics ----------
export const MAX_SERIES = 200;
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Instruments {
  httpDuration: Histogram; // http.server.request.duration (s): count + buckets + sum per route/method/status class
  httpActive: UpDownCounter;
  jobAttempts: Counter;
  jobDuration: Histogram;
  dropped: Counter;
}
// Built by newMetrics(); tests rebuild it for a clean slate (resetMetrics).
export const m = {} as Instruments;

let reader: PrometheusExporter;
let meterProvider: MeterProvider;
const serializer = new PrometheusSerializer("", false, undefined, true, true); // no target_info, no scope labels

function newMetrics(): void {
  const old = meterProvider;
  // preventServerStart: no listening socket of its own; we serialize on demand behind the admin check.
  reader = new PrometheusExporter({ preventServerStart: true });
  const names = ["http.server.request.duration", "http.server.active_requests", "eventhub.job.attempts", "eventhub.job.attempt.duration", "eventhub.telemetry.dropped"];
  meterProvider = new MeterProvider({
    resource,
    readers: [reader],
    // Cardinality guard: past MAX_SERIES distinct attribute sets, OTel folds the rest into ONE
    // overflow series (otel_metric_overflow="true") instead of growing memory.
    views: names.map((instrumentName) => ({ instrumentName, aggregationCardinalityLimit: MAX_SERIES })),
  });
  const meter = meterProvider.getMeter("eventhub");
  m.httpDuration = meter.createHistogram("http.server.request.duration", { unit: "s", description: "HTTP server request duration, finished or aborted.", advice: { explicitBucketBoundaries: LATENCY_BUCKETS } });
  m.httpActive = meter.createUpDownCounter("http.server.active_requests", { unit: "{request}", description: "Requests currently being handled." });
  m.jobAttempts = meter.createCounter("eventhub.job.attempts", { description: "Background job attempts by outcome (completed, retry_scheduled, failed)." });
  m.jobDuration = meter.createHistogram("eventhub.job.attempt.duration", { unit: "s", description: "Duration of one job attempt.", advice: { explicitBucketBoundaries: LATENCY_BUCKETS } });
  m.dropped = meter.createCounter("eventhub.telemetry.dropped", { description: "Telemetry discarded by a bounded buffer or a failed export." });
  if (old) void old.shutdown().catch(() => {});
}
newMetrics();

export const resetMetrics = (): void => newMetrics();

export async function renderMetrics(): Promise<string> {
  const { resourceMetrics } = await reader.collect();
  return serializer.serialize(resourceMetrics);
}

// Only a fixed set of methods becomes an attribute value; anything else is "OTHER".
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
export const methodLabel = (method: string | undefined): string => (method && METHODS.has(method) ? method : "OTHER");
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;
