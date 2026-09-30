-- Shared fuzz-finding registry. One row per defect fingerprint, whatever how many
-- agents rediscover it. Used by D1 in the cloud and by node:sqlite locally; the
-- statements are identical so the local test exercises the real SQL.
CREATE TABLE IF NOT EXISTS findings (
  fingerprint TEXT PRIMARY KEY,
  first_agent TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  body        TEXT,              -- the finding JSON, uploaded by the claimer
  triaged_at  TEXT               -- set when an issue has been filed
);
CREATE INDEX IF NOT EXISTS findings_untriaged ON findings (triaged_at, first_seen);

-- Liveness. A lane that stops reporting is the failure this table exists to expose.
CREATE TABLE IF NOT EXISTS beats (
  agent     TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  round     INTEGER NOT NULL DEFAULT 0,
  journeys  INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER
);
