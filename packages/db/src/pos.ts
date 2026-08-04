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

export interface PosStore {
  upsertLink(link: Omit<PosLink, "id" | "lastSyncAt"> & { id?: string }): Promise<PosLink>;
  listLinks(): Promise<PosLink[]>;
  findLinkByMerchant(merchantId: string): Promise<PosLink | null>;
  recordSales(storeId: string, rows: PosSaleRow[], source: "sync" | "backfill"): Promise<number>;
  dailyTotals(from: string, to: string): Promise<PosDailyTotal[]>;
  itemRows(storeId: string, from: string, to: string): Promise<PosSaleRow[]>;
  touchLinkSynced(id: string, at: Date): Promise<void>;
  recordRun(run: PosSyncRun): Promise<void>;
  recordWebhookInbox(provider: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
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
  async recordWebhookInbox(provider: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_inbox (id, provider, dedupe_key, payload, received_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), provider, `tossplace:${randomUUID()}`, JSON.stringify(payload ?? {})]);
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
  async recordWebhookInbox(_provider: string, payload: unknown): Promise<void> { this.inbox.push(payload); }
  async close(): Promise<void> {}
}

export function createPosStore(env: NodeJS.ProcessEnv): PosStore {
  return env.REPOSITORY_MODE === "postgres" ? PostgresPosStore.fromEnv(env) : new MemoryPosStore();
}

const mapLink = (r: Record<string, unknown>): PosLink => ({
  id: String(r.id), storeId: String(r.store_id), merchantId: String(r.merchant_id),
  accessKeyEnc: String(r.access_key_enc), secretKeyEnc: String(r.secret_key_enc),
  status: r.status as "active" | "disabled",
  lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at as string).toISOString() : null,
});
