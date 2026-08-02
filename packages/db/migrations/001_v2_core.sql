CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_number varchar(10) NOT NULL UNIQUE CHECK (business_number ~ '^[0-9]{10}$'),
  legal_name text NOT NULL,
  representative_name text NOT NULL,
  address text NOT NULL,
  business_type text NOT NULL,
  business_category text NOT NULL,
  email text NOT NULL,
  is_headquarters boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX legal_entities_single_hq_idx ON legal_entities (is_headquarters) WHERE is_headquarters;

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly', 'per_delivery')),
  payment_method text NOT NULL CHECK (payment_method IN ('prepaid', 'monthly_credit')),
  notification_phone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  role text NOT NULL CHECK (role IN ('store_owner','store_staff','hq_ops','hq_finance','hq_master','auditor','driver','system')),
  mfa_secret_encrypted text,
  mfa_required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  membership_role text NOT NULL CHECK (membership_role IN ('owner','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  unit text NOT NULL,
  taxable boolean NOT NULL DEFAULT true CHECK (taxable),
  tax_rate smallint NOT NULL DEFAULT 10 CHECK (tax_rate = 10),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supply_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  gross_amount bigint NOT NULL CHECK (gross_amount >= 0),
  valid_from date NOT NULL,
  valid_to date,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (product_id WITH =, daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[]') WITH &&)
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL CHECK (status IN ('draft','submitted','change_requested','approved','rejected','cancelled')),
  source text NOT NULL CHECK (source IN ('native','legacy_unverified')),
  requested_delivery_date date NOT NULL,
  note text NOT NULL DEFAULT '',
  gross_amount bigint NOT NULL CHECK (gross_amount >= 0),
  supply_amount bigint NOT NULL CHECK (supply_amount >= 0),
  vat_amount bigint NOT NULL CHECK (vat_amount >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_amount = supply_amount + vat_amount)
);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES purchase_orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  sku_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  unit_snapshot text NOT NULL,
  unit_gross_snapshot bigint NOT NULL CHECK (unit_gross_snapshot >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  tax_rate smallint NOT NULL DEFAULT 10 CHECK (tax_rate = 10),
  CHECK (gross_amount = supply_amount + vat_amount)
);

CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES purchase_orders(id),
  event_type text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES purchase_orders(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  driver_id uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('preparing','out_for_delivery','delivered')),
  planned_date date NOT NULL,
  delivered_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_lines (
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  order_line_id uuid NOT NULL REFERENCES purchase_order_lines(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (shipment_id, order_line_id)
);

CREATE TABLE delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL UNIQUE REFERENCES shipments(id),
  photo_object_key text NOT NULL,
  object_version_id text NOT NULL,
  etag text NOT NULL,
  checksum_sha256 text NOT NULL,
  recipient_name text NOT NULL,
  note text NOT NULL DEFAULT '',
  latitude numeric(9,6),
  longitude numeric(9,6),
  captured_at timestamptz NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL UNIQUE REFERENCES shipments(id),
  order_id uuid NOT NULL REFERENCES purchase_orders(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL CHECK (status IN ('confirmed','returned')),
  confirmed_at timestamptz NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES users(id),
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_amount = supply_amount + vat_amount)
);

CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES goods_receipts(id),
  status text NOT NULL CHECK (status IN ('requested','approved','rejected','completed')),
  reason text NOT NULL,
  gross_amount bigint NOT NULL CHECK (gross_amount >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id),
  order_id uuid REFERENCES purchase_orders(id),
  settlement_id uuid,
  amount bigint NOT NULL CHECK (amount > 0),
  due_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','matching','manual_review','paid','reversed','cancelled')),
  depositor_hint text NOT NULL,
  matched_bank_transaction_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  direction text NOT NULL CHECK (direction IN ('credit','debit')),
  memo text NOT NULL,
  matched boolean NOT NULL DEFAULT false,
  raw_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_bank_fk
  FOREIGN KEY (matched_bank_transaction_id) REFERENCES bank_transactions(id);

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL REFERENCES payment_requests(id),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id),
  amount bigint NOT NULL CHECK (amount > 0),
  match_type text NOT NULL CHECK (match_type IN ('automatic','manual')),
  allocated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_request_id, bank_transaction_id)
);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('open','draft','reviewed','approved','locked')),
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end),
  CHECK (gross_amount = supply_amount + vat_amount),
  UNIQUE (store_id, period_start, period_end)
);

ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_settlement_fk
  FOREIGN KEY (settlement_id) REFERENCES settlements(id);

CREATE TABLE settlement_lines (
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  receipt_id uuid NOT NULL UNIQUE REFERENCES goods_receipts(id),
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  PRIMARY KEY (settlement_id, receipt_id),
  CHECK (gross_amount = supply_amount + vat_amount)
);

CREATE TABLE tax_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id),
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  invoice_group_id uuid NOT NULL,
  part_number integer NOT NULL CHECK (part_number > 0),
  part_count integer NOT NULL CHECK (part_count >= part_number),
  provider_management_key varchar(24) NOT NULL UNIQUE,
  issue_type text NOT NULL CHECK (issue_type IN ('normal','internal_statement','modified')),
  status text NOT NULL CHECK (status IN ('draft','reviewed','approved','queued','issued','nts_pending','nts_success','failed','cancelled')),
  serial_number text,
  issue_date date NOT NULL,
  supplier_snapshot jsonb NOT NULL,
  recipient_snapshot jsonb NOT NULL,
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  prepared_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  provider_receipt_id text UNIQUE,
  failure_reason text,
  original_invoice_id uuid REFERENCES tax_invoices(id),
  original_nts_confirm_number varchar(24),
  modification_reason_code varchar(2) CHECK (modification_reason_code IN ('01','02','03','04','05','06')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_amount = supply_amount + vat_amount),
  UNIQUE (invoice_group_id, part_number)
);

CREATE TABLE tax_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_invoice_id uuid NOT NULL REFERENCES tax_invoices(id),
  line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 99),
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_amount bigint NOT NULL,
  supply_amount bigint NOT NULL,
  vat_amount bigint NOT NULL,
  UNIQUE (tax_invoice_id, line_number),
  CHECK (gross_amount = supply_amount + vat_amount)
);

CREATE TABLE tax_invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_invoice_id uuid NOT NULL REFERENCES tax_invoices(id),
  provider_event_id text UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('order_receipt','order_confirmation','payment_request','delivery_statement','delivery_proof','monthly_statement','tax_invoice')),
  object_key text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  store_id uuid REFERENCES stores(id),
  channel text NOT NULL CHECK (channel IN ('app','email','sms')),
  template text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sent','failed')),
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE audit_ledger (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_role text NOT NULL,
  store_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  previous_hash text,
  event_hash text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  dead_letter_at timestamptz
);

CREATE TABLE webhook_inbox (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE idempotency_keys (
  actor_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (actor_id, key)
);

-- 도메인 aggregate의 최신 불변 스냅샷. 정규화 테이블은 조회/회계 projection으로
-- worker가 동일 outbox 트랜잭션을 소비해 갱신한다.
CREATE TABLE aggregate_snapshots (
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  store_id text,
  version integer NOT NULL CHECK (version >= 0),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_id)
);

-- 경쟁 요청의 check-then-create race를 막는 도메인 business-key claim.
-- snapshot이 source of truth이고 정규화 테이블은 worker projection이다.
CREATE TABLE aggregate_claims (
  claim_type text NOT NULL,
  claim_key text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_type, claim_key),
  UNIQUE (aggregate_type, aggregate_id, claim_type, claim_key)
);

CREATE INDEX purchase_orders_store_status_idx ON purchase_orders (store_id, status, created_at DESC);
CREATE INDEX shipments_driver_date_idx ON shipments (driver_id, planned_date, status);
CREATE INDEX receipts_store_date_idx ON goods_receipts (store_id, confirmed_at DESC);
CREATE INDEX payment_requests_status_idx ON payment_requests (status, due_date);
CREATE INDEX bank_transactions_unmatched_idx ON bank_transactions (occurred_at DESC) WHERE NOT matched;
CREATE INDEX settlements_store_period_idx ON settlements (store_id, period_end DESC);
CREATE INDEX tax_invoices_status_idx ON tax_invoices (status, issue_date);
CREATE INDEX notifications_pending_idx ON notifications (created_at) WHERE status = 'pending';
CREATE INDEX outbox_claim_idx ON outbox_events (available_at, created_at) WHERE status IN ('pending','failed');
CREATE INDEX audit_aggregate_idx ON audit_ledger (aggregate_type, aggregate_id, sequence);
CREATE INDEX aggregate_snapshots_scope_idx ON aggregate_snapshots (aggregate_type, store_id, updated_at DESC);
ALTER TABLE aggregate_snapshots ADD CONSTRAINT aggregate_store_scope_required CHECK (
  aggregate_type IN ('actor','credential','legal_entity','product','bank_transaction') OR store_id IS NOT NULL
);
CREATE UNIQUE INDEX aggregate_one_shipment_per_order_idx ON aggregate_snapshots ((payload->>'orderId'))
  WHERE aggregate_type = 'shipment';
CREATE UNIQUE INDEX aggregate_one_receipt_per_shipment_idx ON aggregate_snapshots ((payload->>'shipmentId'))
  WHERE aggregate_type = 'receipt';
CREATE UNIQUE INDEX aggregate_one_settlement_period_idx ON aggregate_snapshots
  ((payload->>'storeId'), (payload->>'periodStart'), (payload->>'periodEnd')) WHERE aggregate_type = 'settlement';
CREATE UNIQUE INDEX aggregate_one_invoice_generation_idx ON aggregate_snapshots ((payload->>'settlementId'))
  WHERE aggregate_type = 'tax_invoice' AND (payload->>'partNumber')::int = 1 AND payload->>'issueType' <> 'modified';
CREATE UNIQUE INDEX aggregate_invoice_part_idx ON aggregate_snapshots ((payload->>'invoiceGroupId'), (payload->>'partNumber'))
  WHERE aggregate_type = 'tax_invoice';
CREATE UNIQUE INDEX aggregate_one_prepayment_per_order_idx ON aggregate_snapshots ((payload->>'orderId'))
  WHERE aggregate_type = 'payment_request' AND payload ? 'orderId';

CREATE OR REPLACE FUNCTION prevent_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER audit_ledger_immutable BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER tax_invoice_events_immutable BEFORE UPDATE OR DELETE ON tax_invoice_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
