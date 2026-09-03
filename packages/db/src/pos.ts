import { randomUUID } from "node:crypto";
import pg from "pg";

/** 1단계 이식: 핵심 Repository 인터페이스를 건드리지 않는 부가 저장소.
 *  2단계 리뷰에서 StateRepository로 흡수 여부를 결정한다. */
export interface PosLink {
  id: string; storeId: string; merchantId: string;
  accessKeyEnc: string; secretKeyEnc: string;
  status: "active" | "disabled"; lastSyncAt: string | null;
}
export interface PosSaleRow { date: string; rawName: string; qty: number; amount: number }
export interface PosDailyTotal { storeId: string; date: string; qty: number; amount: number }
export interface PosSyncRun {
  storeId: string; from: string; to: string;
  rows: number; status: "ok" | "error"; error?: string;
}
export interface PosDiscoveredMerchant {
  merchantId: string; eventType: string; status: "pending" | "linked" | "dismissed";
  firstSeenAt: string; lastSeenAt: string;
}

/** 웹훅 파이프가 살아 있는지 확인하기 위한 마지막 수신 기록. 신규 매장 없이도 연동 상태를 점검할 수 있게 한다. */
export interface PosWebhookReceipt {
  receivedAt: string; eventType: string | null; merchantId: string | null;
}

export interface PosStore {
  upsertLink(link: Omit<PosLink, "id" | "lastSyncAt"> & { id?: string }): Promise<PosLink>;
  listLinks(): Promise<PosLink[]>;
  findLinkByMerchant(merchantId: string): Promise<PosLink | null>;
  recordSales(storeId: string, rows: PosSaleRow[], source: "sync" | "backfill"): Promise<number>;
  dailyTotals(from: string, to: string): Promise<PosDailyTotal[]>;
  itemRows(storeId: string, from: string, to: string): Promise<PosSaleRow[]>;
  touchLinkSynced(id: string, at: Date): Promise<void>;
  recordRun(run: PosSyncRun): Promise<void>;
  /** eventId(x-toss-webhook-id)를 멱등 키로 저장한다. 이미 받은 이벤트면 false. */
  recordWebhookInbox(provider: string, payload: unknown, eventId?: string): Promise<boolean>;
  /** 해당 provider로 마지막에 수신한 웹훅. 한 번도 없으면 null. */
  lastWebhook(provider: string): Promise<PosWebhookReceipt | null>;
  /* ── 앱 설치 웹훅으로 발견된 매장 ID 자동 수집 ── */
  recordDiscoveredMerchant(merchantId: string, eventType: string): Promise<void>;
  listDiscoveredMerchants(): Promise<PosDiscoveredMerchant[]>;
  markDiscoveredLinked(merchantId: string): Promise<void>;
  /* ── 2단계: 상품·별칭 ── */
  createProduct(input: PosProductInput): Promise<PosProduct>;
  listProducts(): Promise<PosProduct[]>;
  updateProduct(id: string, patch: Partial<Pick<PosProduct, "category" | "storeId" | "consumerPrice">>): Promise<PosProduct | null>;
  upsertAlias(rawName: string, productId: string): Promise<{ aliasId: string; scopeStoreId: string | null; relinked: number }>;
  removeAlias(aliasId: string): Promise<{ reverted: number } | null>;
  listAliases(): Promise<PosAlias[]>;
  resolveUnmatched(storeId?: string): Promise<number>;
  listUnmatched(from: string, to: string): Promise<PosUnmatched[]>;
  priceDeviations(from: string, to: string, thresholdPct: number): Promise<PosDeviation[]>;
  report(from: string, to: string, unit: PosReportUnit, filter?: PosReportFilter): Promise<PosReport>;
  /** 기간 내 상품 매칭된 판매 수량 합계 (매장×상품) — 월별 정산 집계의 로스 계산용 */
  productTotals(from: string, to: string): Promise<Array<{ storeId: string; productId: string; qty: number; amount: number }>>;
  wasteReport(storeId: string, date: string): Promise<PosWasteReport>;
  close(): Promise<void>;
}

/* ── 4단계: 폐기 = 입고 − 판매 (당일생산·당일판매) ──
 * 입고는 goods_receipts(검수 확정) 기준. 입고 기록이 없는 날은 폐기를 0으로 단정하지 않고 null(N/A)로 둔다. */
export interface PosWasteItem {
  productId: string; productName: string;
  received: number | null; sold: number;
  waste: number | null; over: number;
  wasteRatePct: number | null; lossAmount: number | null;
}
export interface PosWasteReport {
  storeId: string; date: string; hasReceipt: boolean; hasPos: boolean;
  items: PosWasteItem[];
  totals: { received: number | null; sold: number; waste: number | null; wasteRatePct: number | null; lossAmount: number | null };
}
export interface PosReceiptLine { productId: string; productName: string; quantity: number; unitSupply: number }

/** 공용 순수 계산 — memory/postgres가 같은 산식을 쓴다 */
export function buildWasteReport(
  storeId: string, date: string,
  receipts: PosReceiptLine[],
  sold: Array<{ productId: string; productName: string; qty: number }>,
): PosWasteReport {
  const hasReceipt = receipts.length > 0;
  const recvMap = new Map<string, PosReceiptLine>();
  for (const line of receipts) {
    const cur = recvMap.get(line.productId);
    if (cur) { cur.quantity += line.quantity; cur.unitSupply = line.unitSupply || cur.unitSupply; }
    else recvMap.set(line.productId, { ...line });
  }
  const soldMap = new Map<string, { productName: string; qty: number }>();
  for (const row of sold) {
    const cur = soldMap.get(row.productId);
    if (cur) cur.qty += row.qty;
    else soldMap.set(row.productId, { productName: row.productName, qty: row.qty });
  }
  const items: PosWasteItem[] = [...new Set([...recvMap.keys(), ...soldMap.keys()])].map((productId) => {
    const recv = recvMap.get(productId);
    const soldQty = soldMap.get(productId)?.qty ?? 0;
    const received = recv ? recv.quantity : null;
    const waste = received === null ? null : Math.max(0, received - soldQty);
    return {
      productId,
      productName: recv?.productName ?? soldMap.get(productId)?.productName ?? productId,
      received, sold: soldQty, waste,
      over: received !== null && soldQty > received ? soldQty - received : 0,
      wasteRatePct: received && received > 0 ? Math.round((Math.max(0, received - soldQty) / received) * 1000) / 10 : null,
      lossAmount: waste === null ? null : waste * (recv?.unitSupply ?? 0),
    };
  }).sort((a, b) => (b.lossAmount ?? 0) - (a.lossAmount ?? 0));
  const totalReceived = hasReceipt ? items.reduce((acc, i) => acc + (i.received ?? 0), 0) : null;
  const totalSold = items.reduce((acc, i) => acc + i.sold, 0);
  const totalWaste = hasReceipt ? items.reduce((acc, i) => acc + (i.waste ?? 0), 0) : null;
  return {
    storeId, date, hasReceipt, hasPos: sold.length > 0, items,
    totals: {
      received: totalReceived, sold: totalSold, waste: totalWaste,
      wasteRatePct: totalReceived && totalReceived > 0 && totalWaste !== null
        ? Math.round((totalWaste / totalReceived) * 1000) / 10 : null,
      lossAmount: hasReceipt ? items.reduce((acc, i) => acc + (i.lossAmount ?? 0), 0) : null,
    },
  };
}

export type PosReportUnit = "day" | "week" | "month";
export interface PosReportFilter { storeIds?: string[]; productIds?: string[] }
export interface PosReportRawRow {
  storeId: string; date: string; rawName: string; productId: string | null; productName: string | null;
  /** 상품 관리에 등록된 카테고리(도넛·음료 등). 미매칭 품목은 null. */
  category?: string | null;
  qty: number; amount: number;
}
export interface PosReportMixStore { storeId: string; qty: number; amount: number }
export interface PosReportMix {
  key: string; name: string; productId: string | null; category: string | null;
  qty: number; amount: number; stores: PosReportMixStore[];
}
export interface PosReportRow {
  bucket: string; label: string;
  perStore: Record<string, { qty: number; amount: number }>;
  total: { qty: number; amount: number };
  mix: PosReportMix[];
}
export interface PosReport { unit: PosReportUnit; rows: PosReportRow[]; storeIds: string[] }

/** V1 weekStartMon 이식: KST 일자 문자열의 주 시작(월요일) */
export const weekStartMonday = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay(); /* 0=일 */
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const addDaysStr = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** memory/postgres 공용 순수 집계 — 동일 입력이면 동일 리포트 (V1 computeSalesReport 이식) */
export function buildPosReport(rows: PosReportRawRow[], unit: PosReportUnit, filter?: PosReportFilter): PosReport {
  const storeAllow = filter?.storeIds?.length ? new Set(filter.storeIds) : null;
  const productAllow = filter?.productIds?.length ? new Set(filter.productIds) : null;
  const bucketOf = (date: string) => unit === "week" ? weekStartMonday(date) : unit === "month" ? date.slice(0, 7) : date;
  const labelOf = (bucket: string) => unit === "week"
    ? `${bucket.slice(5).replace("-", "/")}~${addDaysStr(bucket, 6).slice(5).replace("-", "/")}`
    : bucket;
  type MixAcc = PosReportMix & { storeMap: Map<string, PosReportMixStore> };
  type RowAcc = Omit<PosReportRow, "mix"> & { mixMap: Map<string, MixAcc> };
  const buckets = new Map<string, RowAcc>();
  const storeIds = new Set<string>();
  for (const row of rows) {
    if (storeAllow && !storeAllow.has(row.storeId)) continue;
    if (productAllow && (!row.productId || !productAllow.has(row.productId))) continue;
    storeIds.add(row.storeId);
    const bucket = bucketOf(row.date);
    let entry = buckets.get(bucket);
    if (!entry) {
      entry = { bucket, label: labelOf(bucket), perStore: {}, total: { qty: 0, amount: 0 }, mixMap: new Map() };
      buckets.set(bucket, entry);
    }
    const per = entry.perStore[row.storeId] ?? (entry.perStore[row.storeId] = { qty: 0, amount: 0 });
    per.qty += row.qty; per.amount += row.amount;
    entry.total.qty += row.qty; entry.total.amount += row.amount;
    const key = row.productId ?? "__unmatched";
    let mix = entry.mixMap.get(key);
    if (!mix) {
      mix = { key, name: row.productId ? (row.productName ?? key) : "미매칭(기타)", productId: row.productId,
        category: row.productId ? (row.category ?? "기타") : null,
        qty: 0, amount: 0, stores: [], storeMap: new Map() };
      entry.mixMap.set(key, mix);
    }
    mix.qty += row.qty; mix.amount += row.amount;
    let ms = mix.storeMap.get(row.storeId);
    if (!ms) { ms = { storeId: row.storeId, qty: 0, amount: 0 }; mix.storeMap.set(row.storeId, ms); }
    ms.qty += row.qty; ms.amount += row.amount;
  }
  const out: PosReportRow[] = [...buckets.values()]
    .sort((a, b) => (a.bucket < b.bucket ? 1 : -1))
    .map(({ mixMap, ...row }) => ({
      ...row,
      mix: [...mixMap.values()]
        .map(({ storeMap: _sm, ...mix }) => ({ ...mix, stores: [...mix.stores, ..._sm.values()] }))
        .sort((a, b) => b.amount - a.amount),
    }));
  return { unit, rows: out, storeIds: [...storeIds].sort() };
}

export interface PosProductInput {
  name: string; category: string; storeId: string | null; consumerPrice: number | null; sku?: string; unit?: string;
}
export interface PosProduct extends PosProductInput { id: string; active: boolean }
export interface PosAlias { id: string; alias: string; storeId: string | null; productId: string; productName: string }
export interface PosUnmatched {
  storeId: string; rawName: string; qty: number; amount: number;
  suggestion: { productId: string; productName: string; similarity: number } | null;
}
export interface PosDeviation {
  productId: string; productName: string; storeId: string;
  consumerPrice: number; avgSoldPrice: number; deviationPct: number;
}

/** V1 normName 이식: 공백 제거 + 소문자 */
export const normalizeAlias = (value: string): string => value.replace(/\s+/g, "").toLowerCase();

/** V1 유사도 제안 이식: 바이그램 Dice 계수 (0~100) */
export function aliasSimilarity(a: string, b: string): number {
  const na = normalizeAlias(a); const nb = normalizeAlias(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const grams = (v: string) => { const g = new Map<string, number>();
    for (let i = 0; i < v.length - 1; i++) { const k = v.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const ga = grams(na); const gb = grams(nb);
  let overlap = 0;
  for (const [k, ca] of ga) overlap += Math.min(ca, gb.get(k) ?? 0);
  const total = [...ga.values()].reduce((x, y) => x + y, 0) + [...gb.values()].reduce((x, y) => x + y, 0);
  return total ? Math.round((2 * overlap / total) * 100) : 0;
}

export class PostgresPosStore implements PosStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromEnv(env: NodeJS.ProcessEnv): PostgresPosStore {
    const url = env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL_REQUIRED");
    return new PostgresPosStore(new pg.Pool({ connectionString: url, max: 3 }));
  }
  async upsertLink(link: Omit<PosLink, "id" | "lastSyncAt"> & { id?: string }): Promise<PosLink> {
    const id = link.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO pos_links (id, store_id, merchant_id, access_key_enc, secret_key_enc, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (merchant_id) DO UPDATE SET
         store_id = EXCLUDED.store_id, access_key_enc = EXCLUDED.access_key_enc,
         secret_key_enc = EXCLUDED.secret_key_enc, status = EXCLUDED.status,
         updated_at = now(), version = pos_links.version + 1
       RETURNING id, store_id, merchant_id, access_key_enc, secret_key_enc, status, last_sync_at`,
      [id, link.storeId, link.merchantId, link.accessKeyEnc, link.secretKeyEnc, link.status]);
    return mapLink(res.rows[0]);
  }
  async listLinks(): Promise<PosLink[]> {
    const res = await this.pool.query(
      "SELECT id, store_id, merchant_id, access_key_enc, secret_key_enc, status, last_sync_at FROM pos_links ORDER BY created_at");
    return res.rows.map(mapLink);
  }
  async findLinkByMerchant(merchantId: string): Promise<PosLink | null> {
    const res = await this.pool.query(
      "SELECT id, store_id, merchant_id, access_key_enc, secret_key_enc, status, last_sync_at FROM pos_links WHERE merchant_id = $1",
      [merchantId]);
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }
  async recordSales(storeId: string, rows: PosSaleRow[], source: "sync" | "backfill"): Promise<number> {
    if (rows.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        await client.query(
          `INSERT INTO pos_sales (id, store_id, sale_date, raw_name, qty, amount, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (store_id, sale_date, raw_name) DO UPDATE SET
             qty = EXCLUDED.qty, amount = EXCLUDED.amount, source = EXCLUDED.source, updated_at = now()`,
          [randomUUID(), storeId, row.date, row.rawName, row.qty, row.amount, source]);
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async dailyTotals(from: string, to: string): Promise<PosDailyTotal[]> {
    const res = await this.pool.query(
      `SELECT store_id, sale_date::text AS date, COALESCE(SUM(qty),0)::int AS qty, COALESCE(SUM(amount),0)::bigint AS amount
       FROM pos_sales WHERE sale_date BETWEEN $1 AND $2
       GROUP BY store_id, sale_date ORDER BY sale_date, store_id`, [from, to]);
    return res.rows.map((r) => ({ storeId: r.store_id, date: r.date, qty: Number(r.qty), amount: Number(r.amount) }));
  }
  async itemRows(storeId: string, from: string, to: string): Promise<PosSaleRow[]> {
    const res = await this.pool.query(
      `SELECT sale_date::text AS date, raw_name, qty, amount FROM pos_sales
       WHERE store_id = $1 AND sale_date BETWEEN $2 AND $3 ORDER BY sale_date, raw_name`,
      [storeId, from, to]);
    return res.rows.map((r) => ({ date: r.date, rawName: r.raw_name, qty: Number(r.qty), amount: Number(r.amount) }));
  }
  async touchLinkSynced(id: string, at: Date): Promise<void> {
    await this.pool.query("UPDATE pos_links SET last_sync_at = $2, updated_at = now() WHERE id = $1", [id, at.toISOString()]);
  }
  async recordRun(run: PosSyncRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO pos_sync_runs (id, store_id, range_from, range_to, rows_upserted, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), run.storeId, run.from, run.to, run.rows, run.status, run.error ?? null]);
  }
  async recordWebhookInbox(provider: string, payload: unknown, eventId?: string): Promise<boolean> {
    // webhook_inbox PK는 (provider, event_id) — 토스가 재전송해도 event_id로 멱등 처리된다.
    const key = eventId?.trim() || `no-event-id:${randomUUID()}`;
    const res = await this.pool.query(
      `INSERT INTO webhook_inbox (provider, event_id, payload)
       VALUES ($1,$2,$3)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, key, JSON.stringify(payload ?? {})]);
    return (res.rowCount ?? 0) > 0;
  }
  async lastWebhook(provider: string): Promise<PosWebhookReceipt | null> {
    const res = await this.pool.query(
      `SELECT received_at, payload->>'type' AS event_type, payload->>'merchantId' AS merchant_id
       FROM webhook_inbox WHERE provider = $1 ORDER BY received_at DESC LIMIT 1`, [provider]);
    const row = res.rows[0];
    if (!row) return null;
    return { receivedAt: new Date(row.received_at).toISOString(), eventType: row.event_type ?? null, merchantId: row.merchant_id ?? null };
  }
  async recordDiscoveredMerchant(merchantId: string, eventType: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO pos_discovered_merchants (merchant_id, event_type)
       VALUES ($1,$2)
       ON CONFLICT (merchant_id) DO UPDATE SET
         last_seen_at = now(), event_type = EXCLUDED.event_type,
         status = CASE WHEN pos_discovered_merchants.status = 'linked' THEN 'linked' ELSE 'pending' END`,
      [merchantId, eventType]);
  }
  async listDiscoveredMerchants(): Promise<PosDiscoveredMerchant[]> {
    const res = await this.pool.query(
      `SELECT merchant_id, event_type, status, first_seen_at, last_seen_at
       FROM pos_discovered_merchants WHERE status = 'pending' ORDER BY last_seen_at DESC`);
    return res.rows.map((r) => ({
      merchantId: r.merchant_id, eventType: r.event_type, status: r.status,
      firstSeenAt: new Date(r.first_seen_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(),
    }));
  }
  async markDiscoveredLinked(merchantId: string): Promise<void> {
    await this.pool.query(
      "UPDATE pos_discovered_merchants SET status = 'linked', last_seen_at = now() WHERE merchant_id = $1",
      [merchantId]);
  }
  async createProduct(input: PosProductInput): Promise<PosProduct> {
    const sku = input.sku ?? `POS-${randomUUID().slice(0, 8)}`;
    const res = await this.pool.query(
      `INSERT INTO products (sku, name, unit, category, store_id, consumer_price)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, sku, name, unit, category, store_id, consumer_price, active`,
      [sku, input.name, input.unit ?? "EA", input.category, input.storeId, input.consumerPrice]);
    return mapProduct(res.rows[0]);
  }
  async listProducts(): Promise<PosProduct[]> {
    const res = await this.pool.query(
      "SELECT id, sku, name, unit, category, store_id, consumer_price, active FROM products WHERE active ORDER BY category, name");
    return res.rows.map(mapProduct);
  }
  async updateProduct(id: string, patch: Partial<Pick<PosProduct, "category" | "storeId" | "consumerPrice">>): Promise<PosProduct | null> {
    const res = await this.pool.query(
      `UPDATE products SET
         category = COALESCE($2, category),
         store_id = CASE WHEN $3 THEN $4 ELSE store_id END,
         consumer_price = CASE WHEN $5 THEN $6 ELSE consumer_price END,
         updated_at = now()
       WHERE id = $1
       RETURNING id, sku, name, unit, category, store_id, consumer_price, active`,
      [id, patch.category ?? null,
       Object.hasOwn(patch, "storeId"), patch.storeId ?? null,
       Object.hasOwn(patch, "consumerPrice"), patch.consumerPrice ?? null]);
    return res.rows[0] ? mapProduct(res.rows[0]) : null;
  }
  async upsertAlias(rawName: string, productId: string): Promise<{ aliasId: string; scopeStoreId: string | null; relinked: number }> {
    const alias = normalizeAlias(rawName);
    const prod = await this.pool.query("SELECT store_id FROM products WHERE id = $1 AND active", [productId]);
    if (!prod.rows[0]) throw new Error("PRODUCT_NOT_FOUND");
    const scope: string | null = prod.rows[0].store_id ?? null;
    const up = await this.pool.query(
      `INSERT INTO product_aliases (alias, store_id, product_id) VALUES ($1,$2,$3)
       ON CONFLICT (alias, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET product_id = EXCLUDED.product_id
       RETURNING id`, [alias, scope, productId]);
    const relink = await this.pool.query(
      `UPDATE pos_sales SET product_id = $1, updated_at = now()
       WHERE lower(regexp_replace(raw_name, '\\s+', '', 'g')) = $2
         AND ($3::uuid IS NULL OR store_id = $3)`, [productId, alias, scope]);
    return { aliasId: up.rows[0].id, scopeStoreId: scope, relinked: relink.rowCount ?? 0 };
  }
  async removeAlias(aliasId: string): Promise<{ reverted: number } | null> {
    const found = await this.pool.query("DELETE FROM product_aliases WHERE id = $1 RETURNING alias, store_id, product_id", [aliasId]);
    if (!found.rows[0]) return null;
    const { alias, store_id: scope, product_id: productId } = found.rows[0];
    const rev = await this.pool.query(
      `UPDATE pos_sales SET product_id = NULL, updated_at = now()
       WHERE product_id = $1 AND lower(regexp_replace(raw_name, '\\s+', '', 'g')) = $2
         AND ($3::uuid IS NULL OR store_id = $3)`, [productId, alias, scope]);
    return { reverted: rev.rowCount ?? 0 };
  }
  async listAliases(): Promise<PosAlias[]> {
    const res = await this.pool.query(
      `SELECT a.id, a.alias, a.store_id, a.product_id, p.name AS product_name
       FROM product_aliases a JOIN products p ON p.id = a.product_id ORDER BY a.created_at DESC`);
    return res.rows.map((r) => ({ id: r.id, alias: r.alias, storeId: r.store_id ?? null, productId: r.product_id, productName: r.product_name }));
  }
  async resolveUnmatched(storeId?: string): Promise<number> {
    /* 우선순위: 매장 별칭 → 공통 별칭 → 매장 전용 상품명 → 공통 상품명 (V1 resolveSku 이식) */
    const res = await this.pool.query(
      `WITH target AS (
         SELECT s.id, s.store_id, lower(regexp_replace(s.raw_name, '\\s+', '', 'g')) AS norm
         FROM pos_sales s WHERE s.product_id IS NULL AND ($1::uuid IS NULL OR s.store_id = $1)
       ), resolved AS (
         SELECT t.id, COALESCE(a_store.product_id, a_global.product_id, p_store.id, p_global.id) AS pid
         FROM target t
         LEFT JOIN product_aliases a_store ON a_store.alias = t.norm AND a_store.store_id = t.store_id
         LEFT JOIN product_aliases a_global ON a_global.alias = t.norm AND a_global.store_id IS NULL
         LEFT JOIN products p_store ON p_store.active AND p_store.store_id = t.store_id
           AND lower(regexp_replace(p_store.name, '\\s+', '', 'g')) = t.norm
         LEFT JOIN products p_global ON p_global.active AND p_global.store_id IS NULL
           AND lower(regexp_replace(p_global.name, '\\s+', '', 'g')) = t.norm
       )
       UPDATE pos_sales s SET product_id = r.pid, updated_at = now()
       FROM resolved r WHERE s.id = r.id AND r.pid IS NOT NULL`, [storeId ?? null]);
    return res.rowCount ?? 0;
  }
  async listUnmatched(from: string, to: string): Promise<PosUnmatched[]> {
    const res = await this.pool.query(
      `SELECT store_id, raw_name, SUM(qty)::int AS qty, SUM(amount)::bigint AS amount
       FROM pos_sales WHERE product_id IS NULL AND sale_date BETWEEN $1 AND $2
       GROUP BY store_id, raw_name ORDER BY SUM(amount) DESC`, [from, to]);
    const products = await this.listProducts();
    return res.rows.map((r) => ({
      storeId: r.store_id, rawName: r.raw_name, qty: Number(r.qty), amount: Number(r.amount),
      suggestion: bestSuggestion(r.raw_name, r.store_id, products),
    }));
  }
  async priceDeviations(from: string, to: string, thresholdPct: number): Promise<PosDeviation[]> {
    const res = await this.pool.query(
      `SELECT s.product_id, p.name, s.store_id, p.consumer_price,
              (SUM(s.amount)::numeric / NULLIF(SUM(s.qty), 0)) AS avg_price
       FROM pos_sales s JOIN products p ON p.id = s.product_id
       WHERE s.sale_date BETWEEN $1 AND $2 AND p.consumer_price IS NOT NULL AND p.consumer_price > 0
       GROUP BY s.product_id, p.name, s.store_id, p.consumer_price`, [from, to]);
    return res.rows.map((r) => {
      const avg = Number(r.avg_price ?? 0);
      const base = Number(r.consumer_price);
      return { productId: r.product_id, productName: r.name, storeId: r.store_id,
        consumerPrice: base, avgSoldPrice: Math.round(avg),
        deviationPct: base ? Math.round(((avg - base) / base) * 1000) / 10 : 0 };
    }).filter((d) => Math.abs(d.deviationPct) >= thresholdPct)
      .sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));
  }
  async report(from: string, to: string, unit: PosReportUnit, filter?: PosReportFilter): Promise<PosReport> {
    const res = await this.pool.query(
      `SELECT s.store_id, s.sale_date::text AS date, s.raw_name, s.product_id, p.name AS product_name, p.category, s.qty, s.amount
       FROM pos_sales s LEFT JOIN products p ON p.id = s.product_id
       WHERE s.sale_date BETWEEN $1 AND $2`, [from, to]);
    return buildPosReport(res.rows.map((r) => ({
      storeId: r.store_id, date: r.date, rawName: r.raw_name,
      productId: r.product_id ?? null, productName: r.product_name ?? null, category: r.category ?? null,
      qty: Number(r.qty), amount: Number(r.amount),
    })), unit, filter);
  }
  async productTotals(from: string, to: string): Promise<Array<{ storeId: string; productId: string; qty: number; amount: number }>> {
    const res = await this.pool.query(
      `SELECT store_id, product_id, COALESCE(SUM(qty),0)::int AS qty, COALESCE(SUM(amount),0)::bigint AS amount
       FROM pos_sales WHERE product_id IS NOT NULL AND sale_date BETWEEN $1 AND $2
       GROUP BY store_id, product_id`, [from, to]);
    return res.rows.map((r) => ({ storeId: r.store_id, productId: r.product_id, qty: Number(r.qty), amount: Number(r.amount) }));
  }
  async wasteReport(storeId: string, date: string): Promise<PosWasteReport> {
    /* 입고: 검수 확정(confirmed) 건의 배송 라인 수량 · 일자는 KST 확정일 */
    const receipts = await this.pool.query(
      `SELECT pol.product_id, pol.product_name_snapshot AS product_name,
              SUM(sl.quantity)::int AS quantity,
              MAX(pol.unit_gross_snapshot)::bigint AS unit_supply
       FROM goods_receipts gr
       JOIN shipments sh ON sh.id = gr.shipment_id
       JOIN shipment_lines sl ON sl.shipment_id = sh.id
       JOIN purchase_order_lines pol ON pol.id = sl.order_line_id
       WHERE gr.store_id = $1 AND gr.status = 'confirmed'
         AND (gr.confirmed_at AT TIME ZONE 'Asia/Seoul')::date = $2::date
       GROUP BY pol.product_id, pol.product_name_snapshot`, [storeId, date]);
    const sold = await this.pool.query(
      `SELECT s.product_id, p.name AS product_name, SUM(s.qty)::int AS qty
       FROM pos_sales s JOIN products p ON p.id = s.product_id
       WHERE s.store_id = $1 AND s.sale_date = $2::date AND s.product_id IS NOT NULL
       GROUP BY s.product_id, p.name`, [storeId, date]);
    return buildWasteReport(storeId, date,
      receipts.rows.map((r) => ({ productId: r.product_id, productName: r.product_name,
        quantity: Number(r.quantity), unitSupply: Number(r.unit_supply ?? 0) })),
      sold.rows.map((r) => ({ productId: r.product_id, productName: r.product_name, qty: Number(r.qty) })));
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class MemoryPosStore implements PosStore {
  private links = new Map<string, PosLink>();
  private sales = new Map<string, { storeId: string } & PosSaleRow>();
  private runs: PosSyncRun[] = [];
  private inbox: unknown[] = [];
  async upsertLink(link: Omit<PosLink, "id" | "lastSyncAt"> & { id?: string }): Promise<PosLink> {
    const existing = [...this.links.values()].find((l) => l.merchantId === link.merchantId);
    const record: PosLink = { id: existing?.id ?? link.id ?? randomUUID(), lastSyncAt: existing?.lastSyncAt ?? null, ...link };
    this.links.set(record.id, record);
    return { ...record };
  }
  async listLinks(): Promise<PosLink[]> { return [...this.links.values()].map((l) => ({ ...l })); }
  async findLinkByMerchant(merchantId: string): Promise<PosLink | null> {
    const found = [...this.links.values()].find((l) => l.merchantId === merchantId);
    return found ? { ...found } : null;
  }
  async recordSales(storeId: string, rows: PosSaleRow[], _source: "sync" | "backfill"): Promise<number> {
    for (const row of rows) this.sales.set(`${storeId}|${row.date}|${row.rawName}`, { storeId, ...row });
    return rows.length;
  }
  async dailyTotals(from: string, to: string): Promise<PosDailyTotal[]> {
    const acc = new Map<string, PosDailyTotal>();
    for (const s of this.sales.values()) {
      if (s.date < from || s.date > to) continue;
      const key = `${s.storeId}|${s.date}`;
      const cur = acc.get(key) ?? { storeId: s.storeId, date: s.date, qty: 0, amount: 0 };
      cur.qty += s.qty; cur.amount += s.amount;
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => (a.date === b.date ? a.storeId.localeCompare(b.storeId) : a.date.localeCompare(b.date)));
  }
  async itemRows(storeId: string, from: string, to: string): Promise<PosSaleRow[]> {
    return [...this.sales.values()]
      .filter((s) => s.storeId === storeId && s.date >= from && s.date <= to)
      .map(({ date, rawName, qty, amount }) => ({ date, rawName, qty, amount }))
      .sort((a, b) => (a.date === b.date ? a.rawName.localeCompare(b.rawName) : a.date.localeCompare(b.date)));
  }
  async touchLinkSynced(id: string, at: Date): Promise<void> {
    const link = this.links.get(id);
    if (link) link.lastSyncAt = at.toISOString();
  }
  async recordRun(run: PosSyncRun): Promise<void> { this.runs.push({ ...run }); }
  private inboxEventIds = new Set<string>();
  private lastWebhooks = new Map<string, PosWebhookReceipt>();
  private discovered = new Map<string, PosDiscoveredMerchant>();
  async recordWebhookInbox(provider: string, payload: unknown, eventId?: string): Promise<boolean> {
    const key = eventId?.trim();
    if (key) {
      const dedupe = `${provider}:${key}`;
      if (this.inboxEventIds.has(dedupe)) return false;
      this.inboxEventIds.add(dedupe);
    }
    this.inbox.push(payload);
    const body = (payload ?? {}) as { type?: unknown; merchantId?: unknown };
    this.lastWebhooks.set(provider, {
      receivedAt: new Date().toISOString(),
      eventType: typeof body.type === "string" ? body.type : null,
      merchantId: body.merchantId === undefined || body.merchantId === null ? null : String(body.merchantId),
    });
    return true;
  }
  async lastWebhook(provider: string): Promise<PosWebhookReceipt | null> {
    return this.lastWebhooks.get(provider) ?? null;
  }
  async recordDiscoveredMerchant(merchantId: string, eventType: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.discovered.get(merchantId);
    if (existing) {
      existing.eventType = eventType;
      existing.lastSeenAt = now;
      if (existing.status !== "linked") existing.status = "pending";
      return;
    }
    this.discovered.set(merchantId, { merchantId, eventType, status: "pending", firstSeenAt: now, lastSeenAt: now });
  }
  async listDiscoveredMerchants(): Promise<PosDiscoveredMerchant[]> {
    return [...this.discovered.values()].filter((m) => m.status === "pending")
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).map((m) => ({ ...m }));
  }
  async markDiscoveredLinked(merchantId: string): Promise<void> {
    const found = this.discovered.get(merchantId);
    if (found) { found.status = "linked"; found.lastSeenAt = new Date().toISOString(); }
  }
  private products = new Map<string, PosProduct>();
  private aliases = new Map<string, { alias: string; storeId: string | null; productId: string }>();
  async createProduct(input: PosProductInput): Promise<PosProduct> {
    const product: PosProduct = { id: randomUUID(), active: true, unit: input.unit ?? "EA",
      sku: input.sku ?? `POS-${randomUUID().slice(0, 8)}`, ...input };
    this.products.set(product.id, product);
    return { ...product };
  }
  async listProducts(): Promise<PosProduct[]> { return [...this.products.values()].filter((p) => p.active).map((p) => ({ ...p })); }
  async updateProduct(id: string, patch: Partial<Pick<PosProduct, "category" | "storeId" | "consumerPrice">>): Promise<PosProduct | null> {
    const product = this.products.get(id);
    if (!product) return null;
    if (patch.category !== undefined) product.category = patch.category;
    if (Object.hasOwn(patch, "storeId")) product.storeId = patch.storeId ?? null;
    if (Object.hasOwn(patch, "consumerPrice")) product.consumerPrice = patch.consumerPrice ?? null;
    return { ...product };
  }
  async upsertAlias(rawName: string, productId: string): Promise<{ aliasId: string; scopeStoreId: string | null; relinked: number }> {
    const product = this.products.get(productId);
    if (!product?.active) throw new Error("PRODUCT_NOT_FOUND");
    const alias = normalizeAlias(rawName);
    const scope = product.storeId ?? null;
    const key = `${alias}|${scope ?? ""}`;
    let id = [...this.aliases.entries()].find(([, a]) => `${a.alias}|${a.storeId ?? ""}` === key)?.[0];
    if (!id) { id = randomUUID(); }
    this.aliases.set(id, { alias, storeId: scope, productId });
    let relinked = 0;
    for (const [k, row] of this.sales) {
      if (normalizeAlias(row.rawName) !== alias) continue;
      if (scope && row.storeId !== scope) continue;
      this.salesProduct.set(k, productId); relinked++;
    }
    return { aliasId: id, scopeStoreId: scope, relinked };
  }
  async removeAlias(aliasId: string): Promise<{ reverted: number } | null> {
    const found = this.aliases.get(aliasId);
    if (!found) return null;
    this.aliases.delete(aliasId);
    let reverted = 0;
    for (const [k, row] of this.sales) {
      if (this.salesProduct.get(k) !== found.productId) continue;
      if (normalizeAlias(row.rawName) !== found.alias) continue;
      if (found.storeId && row.storeId !== found.storeId) continue;
      this.salesProduct.delete(k); reverted++;
    }
    return { reverted };
  }
  async listAliases(): Promise<PosAlias[]> {
    return [...this.aliases.entries()].map(([id, a]) => ({ id, alias: a.alias, storeId: a.storeId,
      productId: a.productId, productName: this.products.get(a.productId)?.name ?? "" }));
  }
  private salesProduct = new Map<string, string>();
  async resolveUnmatched(storeId?: string): Promise<number> {
    let resolved = 0;
    for (const [k, row] of this.sales) {
      if (this.salesProduct.has(k)) continue;
      if (storeId && row.storeId !== storeId) continue;
      const norm = normalizeAlias(row.rawName);
      const aliasHit = [...this.aliases.values()].find((a) => a.alias === norm && a.storeId === row.storeId)
        ?? [...this.aliases.values()].find((a) => a.alias === norm && a.storeId === null);
      const nameHit = [...this.products.values()].find((p) => p.active && p.storeId === row.storeId && normalizeAlias(p.name) === norm)
        ?? [...this.products.values()].find((p) => p.active && p.storeId === null && normalizeAlias(p.name) === norm);
      const pid = aliasHit?.productId ?? nameHit?.id;
      if (pid) { this.salesProduct.set(k, pid); resolved++; }
    }
    return resolved;
  }
  async listUnmatched(from: string, to: string): Promise<PosUnmatched[]> {
    const acc = new Map<string, PosUnmatched>();
    const products = await this.listProducts();
    for (const [k, row] of this.sales) {
      if (this.salesProduct.has(k) || row.date < from || row.date > to) continue;
      const key = `${row.storeId}|${row.rawName}`;
      const cur = acc.get(key) ?? { storeId: row.storeId, rawName: row.rawName, qty: 0, amount: 0,
        suggestion: bestSuggestion(row.rawName, row.storeId, products) };
      cur.qty += row.qty; cur.amount += row.amount;
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => b.amount - a.amount);
  }
  async priceDeviations(from: string, to: string, thresholdPct: number): Promise<PosDeviation[]> {
    const acc = new Map<string, { qty: number; amount: number; storeId: string; productId: string }>();
    for (const [k, row] of this.sales) {
      const pid = this.salesProduct.get(k);
      if (!pid || row.date < from || row.date > to) continue;
      const key = `${pid}|${row.storeId}`;
      const cur = acc.get(key) ?? { qty: 0, amount: 0, storeId: row.storeId, productId: pid };
      cur.qty += row.qty; cur.amount += row.amount;
      acc.set(key, cur);
    }
    const out: PosDeviation[] = [];
    for (const { qty, amount, storeId, productId } of acc.values()) {
      const product = this.products.get(productId);
      if (!product?.consumerPrice || !qty) continue;
      const avg = amount / qty;
      const pct = Math.round(((avg - product.consumerPrice) / product.consumerPrice) * 1000) / 10;
      if (Math.abs(pct) >= thresholdPct) out.push({ productId, productName: product.name, storeId,
        consumerPrice: product.consumerPrice, avgSoldPrice: Math.round(avg), deviationPct: pct });
    }
    return out.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));
  }
  async report(from: string, to: string, unit: PosReportUnit, filter?: PosReportFilter): Promise<PosReport> {
    const rows: PosReportRawRow[] = [];
    for (const [k, row] of this.sales) {
      if (row.date < from || row.date > to) continue;
      const productId = this.salesProduct.get(k) ?? null;
      rows.push({ storeId: row.storeId, date: row.date, rawName: row.rawName, productId,
        productName: productId ? (this.products.get(productId)?.name ?? null) : null,
        category: productId ? (this.products.get(productId)?.category ?? null) : null,
        qty: row.qty, amount: row.amount });
    }
    return buildPosReport(rows, unit, filter);
  }
  async productTotals(from: string, to: string): Promise<Array<{ storeId: string; productId: string; qty: number; amount: number }>> {
    const acc = new Map<string, { storeId: string; productId: string; qty: number; amount: number }>();
    for (const [k, row] of this.sales) {
      const productId = this.salesProduct.get(k);
      if (!productId || row.date < from || row.date > to) continue;
      const key = `${row.storeId}|${productId}`;
      const cur = acc.get(key) ?? { storeId: row.storeId, productId, qty: 0, amount: 0 };
      cur.qty += row.qty; cur.amount += row.amount;
      acc.set(key, cur);
    }
    return [...acc.values()];
  }
  private receipts = new Map<string, PosReceiptLine[]>();
  /** 테스트/시드 전용: 실제 입고는 V2 검수 흐름이 만든다 */
  seedReceipt(storeId: string, date: string, lines: PosReceiptLine[]): void {
    const key = `${storeId}|${date}`;
    this.receipts.set(key, [...(this.receipts.get(key) ?? []), ...lines]);
  }
  async wasteReport(storeId: string, date: string): Promise<PosWasteReport> {
    const sold: Array<{ productId: string; productName: string; qty: number }> = [];
    for (const [k, row] of this.sales) {
      if (row.storeId !== storeId || row.date !== date) continue;
      const productId = this.salesProduct.get(k);
      if (!productId) continue;
      sold.push({ productId, productName: this.products.get(productId)?.name ?? productId, qty: row.qty });
    }
    return buildWasteReport(storeId, date, this.receipts.get(`${storeId}|${date}`) ?? [], sold);
  }
  async close(): Promise<void> {}
}

export function createPosStore(env: NodeJS.ProcessEnv): PosStore {
  return env.REPOSITORY_MODE === "postgres" ? PostgresPosStore.fromEnv(env) : new MemoryPosStore();
}

function bestSuggestion(rawName: string, storeId: string, products: PosProduct[]): PosUnmatched["suggestion"] {
  let best: PosUnmatched["suggestion"] = null;
  for (const p of products) {
    if (p.storeId && p.storeId !== storeId) continue; /* 타 매장 전용 상품은 제안하지 않는다 */
    const similarity = aliasSimilarity(rawName, p.name);
    if (similarity >= 60 && (!best || similarity > best.similarity)) {
      best = { productId: p.id, productName: p.name, similarity };
    }
  }
  return best;
}

const mapProduct = (r: Record<string, unknown>): PosProduct => ({
  id: String(r.id), sku: String(r.sku), name: String(r.name), unit: String(r.unit),
  category: String(r.category), storeId: (r.store_id as string | null) ?? null,
  consumerPrice: r.consumer_price === null || r.consumer_price === undefined ? null : Number(r.consumer_price),
  active: Boolean(r.active),
});

const mapLink = (r: Record<string, unknown>): PosLink => ({
  id: String(r.id), storeId: String(r.store_id), merchantId: String(r.merchant_id),
  accessKeyEnc: String(r.access_key_enc), secretKeyEnc: String(r.secret_key_enc),
  status: r.status as "active" | "disabled",
  lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at as string).toISOString() : null,
});
