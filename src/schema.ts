/**
 * SQLite schema for tempo.
 *
 * Two tables. Every column is commented. If you change this file, bump
 * SCHEMA_VERSION and add a migration in db.ts.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observations (
  id                  TEXT PRIMARY KEY,   -- random uuid
  org                 TEXT NOT NULL,      -- hard boundary; every query filters on this
  key                 TEXT NOT NULL,      -- what the fact is about, e.g. "deploy.command"
  value               TEXT NOT NULL,      -- the fact

  -- valid time: when it was true in the real world
  valid_from          INTEGER NOT NULL,   -- ms epoch
  valid_to            INTEGER,            -- ms epoch; NULL = still true as far as we know
  valid_from_explicit INTEGER NOT NULL,   -- 1 if the writer gave valid_from, 0 if we guessed "now"

  -- record time: when we learned it
  recorded_at         INTEGER NOT NULL,   -- ms epoch
  closed_at           INTEGER,            -- ms epoch when valid_to was set; NULL if still open.
                                          -- needed so "as of" queries can undo closes that
                                          -- happened after the as-of moment.

  superseded_by       TEXT,               -- id of the observation that replaced this one
  confirmations       INTEGER NOT NULL DEFAULT 1,  -- how many writes agreed with this value

  -- provenance
  writer              TEXT NOT NULL,      -- agent id / person / bot
  source_kind         TEXT NOT NULL,      -- session | slack | github | doc | manual | ...
  source_ref          TEXT                -- session id, URL, commit sha, ...
);

-- The main lookup: "current facts for this key in this org".
CREATE INDEX IF NOT EXISTS obs_org_key_open
  ON observations (org, key, valid_to);

CREATE TABLE IF NOT EXISTS conflicts (
  id           TEXT PRIMARY KEY,
  org          TEXT NOT NULL,
  key          TEXT NOT NULL,
  a_id         TEXT NOT NULL,             -- the older observation
  b_id         TEXT NOT NULL,             -- the newer observation
  detected_at  INTEGER NOT NULL,          -- ms epoch
  status       TEXT NOT NULL,             -- 'open' | 'resolved'
  winner_id    TEXT,                      -- which one won, once resolved
  reason       TEXT,                      -- why (free text, or an auto rule name)
  resolved_at  INTEGER                    -- ms epoch
);

CREATE INDEX IF NOT EXISTS conflicts_org_status
  ON conflicts (org, status);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;
