-- Lecture 12: persist the data the current code supports (users, events).
-- Sessions stay in memory (opaque tokens, 15 min TTL); tickets stay synthetic.

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,32}$'),
  role          TEXT NOT NULL CHECK (role IN ('attendee', 'organizer', 'admin')),
  password_hash TEXT NOT NULL CHECK (password_hash <> ''),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness, matching the application rule (BOB_1 == bob_1).
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

CREATE TABLE events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- RESTRICT: a user who owns events cannot be deleted by accident.
  owner_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name       TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 100),
  seats      INTEGER NOT NULL CHECK (seats BETWEEN 0 AND 100000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Postgres does not index foreign keys automatically; ownership lookups use this.
CREATE INDEX events_owner_id_idx ON events (owner_id);

-- Database-local housekeeping that holds for every writer (see lecture 12, triggers).
CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
