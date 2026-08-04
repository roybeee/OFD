-- Phase 5: deterministic SQLite -> PostgreSQL import ledger and cutover controls.
-- This schema stores only sanitized source rows. Legacy credentials and sessions
-- are deliberately outside the import contract.

CREATE TABLE legacy_import_batches (
  id uuid PRIMARY KEY,
  source_system text NOT NULL CHECK (source_system = 'ofd-sqlite-v1'),
  source_snapshot_id text NOT NULL,
  manifest_sha256 varchar(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 varchar(64) NOT NULL UNIQUE CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  signature_key_id text NOT NULL,
  signature_value varchar(64) NOT NULL CHECK (signature_value ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('applying','applied','rolled_back')),
  authority text NOT NULL CHECK (authority IN ('legacy','shadow','v2')),
  cohort text NOT NULL,
  write_freeze_confirmed boolean NOT NULL CHECK (write_freeze_confirmed),
  source_counts jsonb NOT NULL DEFAULT '{}',
  source_amounts jsonb NOT NULL DEFAULT '{}',
  applied_counts jsonb NOT NULL DEFAULT '{}',
  quarantine_counts jsonb NOT NULL DEFAULT '{}',
  report jsonb NOT NULL DEFAULT '{}',
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'applying' AND completed_at IS NULL) OR (status <> 'applying' AND completed_at IS NOT NULL))
);

CREATE TABLE legacy_import_row_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES legacy_import_batches(id),
  source_system text NOT NULL CHECK (source_system = 'ofd-sqlite-v1'),
  entity text NOT NULL CHECK (entity IN ('store','product','order')),
  source_id text NOT NULL,
  source_row_sha256 varchar(64) NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  target_aggregate_type text,
  target_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('imported','replayed','quarantined')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_system, entity, source_id, source_row_sha256),
  CHECK (
    (outcome IN ('imported','replayed') AND target_aggregate_type IS NOT NULL AND target_id IS NOT NULL)
    OR (outcome = 'quarantined' AND target_aggregate_type IS NULL AND target_id IS NULL AND cardinality(reason_codes) > 0)
  )
);

CREATE INDEX legacy_import_row_source_identity_idx
  ON legacy_import_row_mappings (source_system, entity, source_id, created_at DESC);
CREATE INDEX legacy_import_batches_manifest_idx ON legacy_import_batches (manifest_sha256, started_at DESC);
CREATE INDEX legacy_import_row_target_idx
  ON legacy_import_row_mappings (target_aggregate_type, target_id)
  WHERE target_id IS NOT NULL;

CREATE TABLE legacy_import_quarantine (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES legacy_import_batches(id),
  source_system text NOT NULL CHECK (source_system = 'ofd-sqlite-v1'),
  entity text NOT NULL CHECK (entity IN ('store','product','order')),
  source_id text NOT NULL,
  source_row_sha256 varchar(64) NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  source_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entity, source_id, source_row_sha256)
);

CREATE TABLE legacy_cutover_controls (
  cohort text PRIMARY KEY,
  authority text NOT NULL CHECK (authority IN ('legacy','shadow','v2')),
  write_freeze_confirmed boolean NOT NULL DEFAULT false,
  active_batch_id uuid REFERENCES legacy_import_batches(id),
  changed_by uuid NOT NULL REFERENCES users(id),
  change_reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authority = 'v2' OR active_batch_id IS NOT NULL)
);

CREATE TABLE legacy_cutover_control_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cohort text NOT NULL,
  authority text NOT NULL CHECK (authority IN ('legacy','shadow','v2')),
  write_freeze_confirmed boolean NOT NULL,
  active_batch_id uuid REFERENCES legacy_import_batches(id),
  changed_by uuid NOT NULL REFERENCES users(id),
  change_reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_legacy_import_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER legacy_import_quarantine_immutable
  BEFORE UPDATE OR DELETE ON legacy_import_quarantine
  FOR EACH ROW EXECUTE FUNCTION prevent_legacy_import_immutable_change();
CREATE TRIGGER legacy_import_row_mappings_immutable
  BEFORE UPDATE OR DELETE ON legacy_import_row_mappings
  FOR EACH ROW EXECUTE FUNCTION prevent_legacy_import_immutable_change();
CREATE TRIGGER legacy_cutover_control_events_immutable
  BEFORE UPDATE OR DELETE ON legacy_cutover_control_events
  FOR EACH ROW EXECUTE FUNCTION prevent_legacy_import_immutable_change();

REVOKE UPDATE, DELETE ON legacy_import_quarantine FROM PUBLIC;
REVOKE UPDATE, DELETE ON legacy_import_row_mappings FROM PUBLIC;
REVOKE UPDATE, DELETE ON legacy_cutover_control_events FROM PUBLIC;

COMMENT ON TABLE legacy_import_quarantine IS
  'Read-only sanitized legacy rows that were incomplete, ambiguous, or conflicted with an earlier source hash.';
COMMENT ON COLUMN legacy_import_quarantine.source_payload IS
  'Allowlisted operational fields only; passwords, sessions, tokens, code hashes, and POS credentials are prohibited.';
