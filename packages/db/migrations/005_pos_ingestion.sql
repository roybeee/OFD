-- 005: POS 실측 수집 (V1 워크스테이션 기능 이식 1단계)
-- pos_links: 매장-토스플레이스 연결 (키는 AES-256-GCM 암호문)
CREATE TABLE pos_links (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  provider text NOT NULL DEFAULT 'tossplace' CHECK (provider = 'tossplace'),
  merchant_id text NOT NULL UNIQUE,
  access_key_enc text NOT NULL,
  secret_key_enc text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX pos_links_store_idx ON pos_links(store_id);

-- pos_sales: 일자×품목 원시 집계 (V1 pos_sales와 동일 곡률; hour는 2단계에서)
CREATE TABLE pos_sales (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  sale_date date NOT NULL,
  raw_name text NOT NULL,
  qty integer NOT NULL DEFAULT 0,
  amount bigint NOT NULL DEFAULT 0,
  product_id uuid REFERENCES products(id),
  source text NOT NULL DEFAULT 'sync' CHECK (source IN ('sync','backfill','webhook')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, sale_date, raw_name)
);
CREATE INDEX pos_sales_store_date_idx ON pos_sales(store_id, sale_date);

-- pos_sync_runs: 수집 이력 (대조·감사용)
CREATE TABLE pos_sync_runs (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  range_from date NOT NULL,
  range_to date NOT NULL,
  rows_upserted integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok','error')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_sync_runs_store_idx ON pos_sync_runs(store_id, created_at DESC);

COMMENT ON TABLE pos_sales IS 'V1 대조 검증 기준: store_id+sale_date 합계(qty, amount)가 V1 /api/salesreport와 일치해야 한다';
