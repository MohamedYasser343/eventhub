-- Lecture 23: real bookings. Inventory is events.seats (already CHECK seats >= 0, so the database itself
-- refuses a negative stock). One row per successful booking; quantity > 0 is enforced here too.
-- CASCADE on event deletion is a deliberate learning simplification (refund policy is deferred).
-- Rollback: DROP TABLE bookings;
CREATE TABLE bookings (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   BIGINT  NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id    BIGINT  NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bookings_event_id_idx ON bookings (event_id);
CREATE INDEX bookings_user_id_idx ON bookings (user_id);
