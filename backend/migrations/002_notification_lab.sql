-- Lecture 14 lab: background notification jobs. Synthetic data only.

-- EventHub's own record of each LOGICAL notification (the same id across every retry).
CREATE TABLE notification_deliveries (
  notification_id TEXT PRIMARY KEY CHECK (notification_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  recipient_ref   TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('processing', 'sent')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

-- The MOCK PROVIDER's side of the world: its "sent mail" ledger. The primary key is the
-- provider-side idempotency key, so a repeated send with the same key cannot add a
-- second row (concurrent senders included). It stands in for a provider that supports
-- idempotency keys; a real one must be checked against its own contract.
CREATE TABLE mock_provider_sent (
  idempotency_key TEXT PRIMARY KEY,
  recipient_ref   TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
