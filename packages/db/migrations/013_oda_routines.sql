-- Server-side schedules are independent of browser tabs and survive API restarts.
CREATE TABLE oda_routines (
  id text PRIMARY KEY,
  token_id text NOT NULL,
  store_id text NOT NULL,
  definition jsonb NOT NULL,
  runner_secret_enc text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oda_routines_due ON oda_routines(next_run_at) WHERE enabled;
CREATE INDEX oda_routines_token ON oda_routines(token_id);

CREATE TABLE oda_routine_runs (
  id text PRIMARY KEY,
  routine_id text NOT NULL REFERENCES oda_routines(id),
  token_id text NOT NULL,
  store_id text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','submitting','running','waiting_for_approval','completed','failed','cancelled','needs_review','unknown','stopping')),
  state jsonb NOT NULL,
  runner_secret_enc text NOT NULL,
  lease_id text,
  lease_until timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(routine_id,scheduled_for)
);
-- Uncertain admission remains active: the scheduler must not replace it with a
-- new invocation and accidentally repeat externally visible work.
CREATE UNIQUE INDEX oda_routine_one_active ON oda_routine_runs(routine_id)
  WHERE status NOT IN ('completed','failed','cancelled','needs_review');
CREATE INDEX oda_routine_runs_poll ON oda_routine_runs(next_poll_at)
  WHERE status NOT IN ('completed','failed','cancelled','needs_review','unknown');
CREATE INDEX oda_routine_runs_token ON oda_routine_runs(token_id,created_at DESC);

CREATE TABLE oda_routine_run_resolutions (
  run_id text PRIMARY KEY REFERENCES oda_routine_runs(id),
  actor_id text NOT NULL,
  token_id text NOT NULL,
  note text NOT NULL,
  native_status text,
  resolved_at timestamptz NOT NULL
);
-- Resolution is an append-only owner acknowledgement, never a fabricated
-- upstream cancellation receipt. No mutation route edits these rows.
