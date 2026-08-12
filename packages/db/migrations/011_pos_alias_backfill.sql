-- 011: POS 미매칭 품목 정리 — '코코넛 (CO)', '버터넛 (BT)' 별칭 등록 + 기존 매출 소급 연결.
-- 다른 품목은 화면에서 별칭을 등록해 해소했으나, 이 둘은 원본명 뒤 코드(CO/BT) 때문에 누락됐다.
-- upsertAlias()와 같은 의미로 처리한다: 별칭은 공백 제거 + 소문자(normalizeAlias),
-- 두 상품 모두 본사 공통(store_id IS NULL)이므로 전 매장 범위로 등록한다.
-- 상품이 없거나 비활성이면 JOIN이 비어 아무것도 하지 않는다(마이그레이션은 실패하지 않는다).
INSERT INTO product_aliases (alias, store_id, product_id)
SELECT v.alias, NULL, p.id
FROM (VALUES ('코코넛(co)', '코코넛'), ('버터넛(bt)', '버터넛')) AS v(alias, product_name)
JOIN products p ON p.name = v.product_name AND p.store_id IS NULL AND p.active
ON CONFLICT (alias, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO UPDATE SET product_id = EXCLUDED.product_id;

-- 별칭 등록·해제 시 pos_sales.product_id 소급 재적용이 규약(006 주석)이므로 기존 매출도 연결한다.
UPDATE pos_sales s
SET product_id = a.product_id, updated_at = now()
FROM product_aliases a
WHERE a.store_id IS NULL AND a.alias IN ('코코넛(co)', '버터넛(bt)')
  AND s.product_id IS NULL
  AND lower(regexp_replace(s.raw_name, '\s+', '', 'g')) = a.alias;
