-- 007: 신규매장 오픈 프로세스 (V1 이식 5단계)
CREATE TABLE store_openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  region text,
  open_date date NOT NULL,
  mode text NOT NULL DEFAULT '가맹' CHECK (mode IN ('가맹','운영대행')),
  store_type text NOT NULL DEFAULT '테이블형' CHECK (store_type IN ('테이블형','포장형')),
  stage text NOT NULL DEFAULT '상담중' CHECK (stage IN ('상담중','진행','보류','완료')),
  store_id uuid REFERENCES stores(id),        -- 오픈 확정 시 매장 대장으로 승격
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX store_openings_stage_idx ON store_openings(stage, open_date);

CREATE TABLE store_opening_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id uuid NOT NULL REFERENCES store_openings(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('D-4주차','D-3주차','D-2주차','D-1주차','D-DAY')),
  task_group text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  owner text NOT NULL CHECK (owner IN ('hq','pt','both')),
  day_offset integer NOT NULL,                -- 오픈일 기준 (음수 = 이전)
  done boolean NOT NULL DEFAULT false,
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  memo text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  custom boolean NOT NULL DEFAULT false
);
CREATE INDEX store_opening_tasks_opening_idx ON store_opening_tasks(opening_id, sort_order);

COMMENT ON TABLE store_opening_tasks IS 'V1 OPEN_TPL 54항목 이식 · 지연 판정은 stage=진행에서만 (상담중은 미집계)';
