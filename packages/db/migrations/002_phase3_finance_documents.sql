-- Phase 3: persisted finance deadlines, immutable original-document versions and business-key guards.
ALTER TABLE tax_invoices
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN IF NOT EXISTS last_retried_at timestamptz;

UPDATE tax_invoices
SET due_date = ((date_trunc('month', issue_date::timestamp) + interval '1 month 9 days')::date)
WHERE due_date IS NULL;

ALTER TABLE tax_invoices ALTER COLUMN due_date SET NOT NULL;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_version integer,
  ADD COLUMN IF NOT EXISTS object_version_id text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Projection rows created before Phase 3 are assigned source version one. New writes must supply immutable storage metadata.
UPDATE documents SET source_version = 1 WHERE source_version IS NULL;
ALTER TABLE documents ALTER COLUMN source_version SET NOT NULL;
ALTER TABLE documents ADD CONSTRAINT documents_source_version_positive CHECK (source_version > 0);
ALTER TABLE documents ADD CONSTRAINT documents_size_nonnegative CHECK (size_bytes IS NULL OR size_bytes >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS aggregate_one_payment_per_settlement_idx
  ON aggregate_snapshots ((payload->>'settlementId'))
  WHERE aggregate_type = 'payment_request' AND payload ? 'settlementId';

CREATE UNIQUE INDEX IF NOT EXISTS aggregate_one_document_source_idx
  ON aggregate_snapshots ((payload->>'kind'), (payload->>'aggregateId'), ((payload->>'sourceVersion')::integer))
  WHERE aggregate_type = 'document';

CREATE UNIQUE INDEX IF NOT EXISTS documents_one_source_version_idx
  ON documents (document_type, aggregate_id, source_version);

-- 001_v2_core.sql is immutable. Upgrade both databases that applied the original
-- migration and fresh installs by changing settlement cardinality only here.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS kind text;
UPDATE settlements settlement
SET kind = store.billing_cycle
FROM stores store
WHERE settlement.store_id = store.id AND settlement.kind IS NULL;
ALTER TABLE settlements ALTER COLUMN kind SET NOT NULL;
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_kind_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_kind_check CHECK (kind IN ('monthly','per_delivery'));
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_store_id_period_start_period_end_key;
CREATE UNIQUE INDEX IF NOT EXISTS settlements_one_monthly_period_idx ON settlements (store_id, period_start, period_end)
  WHERE kind = 'monthly';

-- Existing snapshots predate Settlement.kind. Derive it from the store contract, then scope period uniqueness to monthly closing only.
UPDATE aggregate_snapshots settlement
SET payload = jsonb_set(settlement.payload, '{kind}', to_jsonb(COALESCE((
  SELECT store.payload->>'billingCycle'
  FROM aggregate_snapshots store
  WHERE store.aggregate_type = 'store' AND store.aggregate_id = settlement.payload->>'storeId'
), 'monthly')))
WHERE settlement.aggregate_type = 'settlement' AND NOT settlement.payload ? 'kind';

DROP INDEX IF EXISTS aggregate_one_settlement_period_idx;
CREATE UNIQUE INDEX aggregate_one_settlement_period_idx ON aggregate_snapshots
  ((payload->>'storeId'), (payload->>'periodStart'), (payload->>'periodEnd'))
  WHERE aggregate_type = 'settlement' AND payload->>'kind' = 'monthly';
