-- 008: 현장 운영 계층 완성 (V1 전량 이식 마감)
--
-- (A) FK 지뢰 제거 — 매장·사용자·수령 데이터의 정본은 aggregate_snapshots(jsonb)인데,
--     005~007이 아무 코드도 쓰지 않는 관계형 코어(stores/users)에 FK를 걸어
--     운영 DB에서 POS 링크 생성·매출 적재·오픈 승격·체크 완료가 전부 23503으로 실패한다.
--     참조 무결성은 서비스 계층(저장 전 매장 존재 검증)이 이미 담당하므로 FK를 걷어낸다.
ALTER TABLE pos_links          DROP CONSTRAINT IF EXISTS pos_links_store_id_fkey;
ALTER TABLE pos_sales          DROP CONSTRAINT IF EXISTS pos_sales_store_id_fkey;
ALTER TABLE pos_sync_runs      DROP CONSTRAINT IF EXISTS pos_sync_runs_store_id_fkey;
ALTER TABLE products           DROP CONSTRAINT IF EXISTS products_store_id_fkey;
ALTER TABLE product_aliases    DROP CONSTRAINT IF EXISTS product_aliases_store_id_fkey;
ALTER TABLE store_openings     DROP CONSTRAINT IF EXISTS store_openings_store_id_fkey;
ALTER TABLE store_opening_tasks DROP CONSTRAINT IF EXISTS store_opening_tasks_done_by_fkey;

-- (B) 가맹 영업 파이프라인 (V1 leads — 가맹사업법 제7조③ 숙려기간 서버 강제)
CREATE TABLE franchise_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  area text NOT NULL DEFAULT '',
  store_name text NOT NULL DEFAULT '',
  stage integer NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 5),
  doc_date date,                                -- 정보공개서 제공일
  advisor boolean NOT NULL DEFAULT false,       -- 가맹거래사 자문 시 숙려 7일 단축
  open_target text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  flag boolean NOT NULL DEFAULT false,          -- 숙려기간 미준수 사후기록 표식
  store_id uuid,                                -- 오픈완료 시 매장 대장 승격 결과
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX franchise_leads_stage_idx ON franchise_leads(stage, updated_at DESC) WHERE NOT deleted;

-- (C) 가맹점 공지 (V1 notices — 본사 → 매장 공지)
CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  pinned boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notices_live_idx ON notices(pinned DESC, notice_date DESC) WHERE NOT deleted;

-- (D) 운영 설정 (네이버 지도 클라이언트 키 등 — V1 config)
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
