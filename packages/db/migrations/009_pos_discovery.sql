-- 009: 토스플레이스 앱 설치 웹훅(app.installation.created.v1)으로 발견된 매장 ID 자동 수집.
-- 매장 POS에 OFD 앱이 설치되면 merchantId가 여기에 쌓이고, 본사 매출현황 화면에서
-- 매장과 매칭해 연동을 완성한다. linked 이후 재설치가 와도 pending으로 되돌리지 않는다.
CREATE TABLE pos_discovered_merchants (
  merchant_id text PRIMARY KEY,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','dismissed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
