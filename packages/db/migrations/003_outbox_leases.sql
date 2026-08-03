-- Phase 4: fenced outbox leases and persisted worker liveness.
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Legacy in-flight rows receive a finite lease and are reclaimed or dead-lettered by the next claim pass.
UPDATE outbox_events
SET lease_token = COALESCE(lease_token, gen_random_uuid()::text),
    lease_expires_at = COALESCE(lease_expires_at, locked_at + interval '5 minutes', now())
WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS outbox_events_claimable_idx
  ON outbox_events (status, available_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('running','stopping')),
  observed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
