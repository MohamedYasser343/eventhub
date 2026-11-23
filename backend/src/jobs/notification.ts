import type pg from "pg";

// Lecture 14 lab: a mock ticket-confirmation notification. No real booking exists yet
// (POST /bookings is a 501 stub), so nothing here claims that a booking happened.

export const NOTIFICATION_JOB = "ticket_confirmation";
export const PAYLOAD_VERSION = 1;

// Versioned, serializable payload: ids and synthetic references only. No secrets,
// tokens, e-mail addresses or live objects. `scenario` is a LAB-ONLY switch that steers
// the mock provider ("ok", "transient:N", "permanent", "slow:MS", "ambiguous",
// "crash-after-send"); a real producer would never send it.
export interface NotificationPayload {
  version: typeof PAYLOAD_VERSION;
  notificationId: string; // the LOGICAL operation id: identical on every retry and replay
  recipientRef: string; // synthetic reference such as "synthetic-user-1"
  correlationId: string; // ties the job back to the request that caused it
  scenario?: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Malformed input is a permanent error: retrying the same bytes can never fix it.
export class InvalidJobError extends Error {}
// The provider said "no" for a reason a retry cannot change (bad address, bad credentials).
export class PermanentProviderError extends Error {}
// Timeouts, 5xx, 429: a later attempt may succeed.
export class TransientProviderError extends Error {}

export function parsePayload(data: unknown): NotificationPayload {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new InvalidJobError("payload is not an object");
  const d = data as Record<string, unknown>;
  if (d["version"] !== PAYLOAD_VERSION) throw new InvalidJobError("unsupported payload version");
  for (const key of ["notificationId", "recipientRef", "correlationId"] as const) {
    if (typeof d[key] !== "string" || !ID.test(d[key])) throw new InvalidJobError(`${key} is missing or malformed`);
  }
  if (d["scenario"] !== undefined && (typeof d["scenario"] !== "string" || d["scenario"].length > 40)) throw new InvalidJobError("scenario is malformed");
  return d as unknown as NotificationPayload;
}

// ---------- mock e-mail provider ----------
export interface EmailProvider {
  // `idempotencyKey` is the provider-side dedup key. `attempt` is 0-based.
  send(msg: { idempotencyKey: string; recipientRef: string; scenario: string | undefined; attempt: number }): Promise<void>;
}

// Deterministic provider whose "sent mail" ledger is the mock_provider_sent table. The
// primary key on idempotency_key is the provider's duplicate protection: the same key
// can never be recorded twice, even from two workers at once.
export class MockEmailProvider implements EmailProvider {
  constructor(
    private readonly db: pg.Pool,
    // The crash scenario kills the whole process, so it only runs where explicitly allowed.
    private readonly allowCrash = false,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async record(key: string, recipientRef: string): Promise<boolean> {
    const r = await this.db.query("INSERT INTO mock_provider_sent (idempotency_key, recipient_ref) VALUES ($1, $2) ON CONFLICT DO NOTHING", [key, recipientRef]);
    return r.rowCount === 1; // false: this key was already sent (duplicate suppressed)
  }

  async send(msg: { idempotencyKey: string; recipientRef: string; scenario: string | undefined; attempt: number }): Promise<void> {
    const [kind = "ok", arg] = (msg.scenario ?? "ok").split(":");
    switch (kind) {
      case "ok":
        await this.record(msg.idempotencyKey, msg.recipientRef);
        return;
      case "transient": // fail the first N attempts, then succeed
        if (msg.attempt < Number(arg ?? 1)) throw new TransientProviderError("provider unavailable (503)");
        await this.record(msg.idempotencyKey, msg.recipientRef);
        return;
      case "permanent":
        throw new PermanentProviderError("recipient rejected by provider");
      case "slow":
        await this.sleep(Number(arg ?? 500));
        await this.record(msg.idempotencyKey, msg.recipientRef);
        return;
      case "ambiguous": {
        // The provider ACCEPTED the mail but the response is lost: the caller sees only a timeout.
        const first = await this.record(msg.idempotencyKey, msg.recipientRef);
        if (first) throw new TransientProviderError("timeout waiting for provider response");
        return;
      }
      case "crash-after-send": {
        // The side effect happens, then the worker dies before it can report success.
        const first = await this.record(msg.idempotencyKey, msg.recipientRef);
        if (first && this.allowCrash) process.exit(137);
        if (first) throw new TransientProviderError("simulated crash (not allowed in this process)");
        return;
      }
      default:
        throw new InvalidJobError("unknown scenario");
    }
  }
}

export type HandlerResult = "sent" | "already_sent";

// The job handler. Safe to run twice for one notificationId, also concurrently:
//  1. claim/refresh the EventHub delivery row (atomic upsert; already 'sent' => do nothing),
//  2. call the provider with the SAME idempotency key on every attempt,
//  3. mark 'sent'.
// Honest limit: if the provider has no idempotency support, a crash between 2 and 3 can
// still send twice. Here the mock provider dedups by key, so the recorded effect stays one.
export async function handleNotification(
  data: unknown,
  attempt: number,
  deps: { db: pg.Pool; provider: EmailProvider; timeoutMs: number },
): Promise<HandlerResult> {
  const p = parsePayload(data);
  const claim = await deps.db.query<{ status: string }>(
    `INSERT INTO notification_deliveries (notification_id, recipient_ref, status, attempts)
     VALUES ($1, $2, 'processing', 1)
     ON CONFLICT (notification_id) DO UPDATE
       SET attempts = notification_deliveries.attempts + 1
       WHERE notification_deliveries.status <> 'sent'
     RETURNING status`,
    [p.notificationId, p.recipientRef],
  );
  if (claim.rowCount === 0) return "already_sent"; // WHERE failed: row exists and is 'sent'

  await withTimeout(
    deps.provider.send({ idempotencyKey: p.notificationId, recipientRef: p.recipientRef, scenario: p.scenario, attempt }),
    deps.timeoutMs,
  );
  await deps.db.query("UPDATE notification_deliveries SET status = 'sent', sent_at = now() WHERE notification_id = $1", [p.notificationId]);
  return "sent";
}

// A provider call that outlives the budget is treated as a transient, AMBIGUOUS failure:
// the mail may or may not have been sent.
async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransientProviderError("handler timeout")), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
