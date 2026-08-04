-- 006: 상품 카테고리·매장 전용·소비자가 + POS 별칭 매핑 (V1 이식 2단계)
ALTER TABLE products
  ADD COLUMN category text NOT NULL DEFAULT '기타'
    CHECK (category IN ('도넛','링도넛','음료','굿즈','서비스','세트','기타')),
  ADD COLUMN store_id uuid REFERENCES stores(id),      -- NULL = 본사 공통, 값 = 매장 전용
  ADD COLUMN consumer_price bigint;                    -- 소비자가 (공급가는 supply_price_versions가 권위)
CREATE INDEX products_store_idx ON products(store_id) WHERE store_id IS NOT NULL;

-- POS 원본 품목명 → 상품 별칭. store_id 스코프: 전용 상품 매핑이 타 매장 동명 매출을 끌어가지 않도록.
CREATE TABLE product_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias text NOT NULL,                                 -- 정규화(공백 제거·소문자) 저장
  store_id uuid REFERENCES stores(id),
  product_id uuid NOT NULL REFERENCES products(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_aliases_scope_uniq
  ON product_aliases (alias, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX product_aliases_product_idx ON product_aliases(product_id);

COMMENT ON TABLE product_aliases IS 'V1 sku_aliases 이식: 매핑·해제 시 pos_sales.product_id 소급 재적용이 규약';
