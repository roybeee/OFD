import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
type PoolInstance = InstanceType<typeof Pool>;

/* ── 가맹 영업 파이프라인 (V1 leads 이식) ─────────────────────────────── */

export const LEAD_STAGES = ["리드", "상담", "정보공개서 제공", "가맹계약", "실사·공사", "오픈완료"] as const;

export interface FranchiseLead {
  id: string;
  name: string;
  phone: string;
  area: string;
  storeName: string;
  stage: number;               // 0..5 (LEAD_STAGES 인덱스)
  docDate: string | null;      // 정보공개서 제공일 (YYYY-MM-DD)
  advisor: boolean;            // 가맹거래사 자문 → 숙려 7일
  openTarget: string;
  memo: string;
  flag: boolean;               // 숙려기간 미준수 사후기록
  storeId: string | null;      // 오픈완료 승격 매장
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface LeadInput {
  name: string; phone?: string; area?: string; storeName?: string;
  docDate?: string | null; advisor?: boolean; openTarget?: string; memo?: string;
}

export interface CoolingGate { has: boolean; days?: number; gate?: string; ok?: boolean }

export const kstToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* 가맹사업법 제7조③ — 정보공개서 제공 후 14일(가맹거래사 자문 시 7일) 경과 전 가맹계약 체결·가맹금 수령 금지. KST 기준 서버 강제 */
export function coolingGate(lead: Pick<FranchiseLead, "docDate" | "advisor">, today = kstToday()): CoolingGate {
  if (!lead.docDate) return { has: false };
  const days = lead.advisor ? 7 : 14;
  const gate = addDays(lead.docDate, days);
  return { has: true, days, gate, ok: today >= gate };
}

/* ── 공지 (V1 notices 이식) ───────────────────────────────────────────── */

export interface Notice { id: string; date: string; title: string; body: string; pinned: boolean }

/* ── 저장 계층 계약 ──────────────────────────────────────────────────── */

export interface FieldStore {
  listLeads(): Promise<FranchiseLead[]>;
  getLead(id: string): Promise<FranchiseLead | null>;
  createLead(input: LeadInput): Promise<FranchiseLead>;
  updateLead(id: string, patch: Partial<LeadInput>): Promise<FranchiseLead | null>;
  setLeadStage(id: string, stage: number, flag: boolean, storeId?: string | null): Promise<FranchiseLead | null>;
  removeLead(id: string): Promise<boolean>;
  listNotices(): Promise<Notice[]>;
  createNotice(input: { title: string; body?: string; pinned?: boolean }): Promise<Notice>;
  removeNotice(id: string): Promise<boolean>;
  getSetting(key: string): Promise<string | null>;
  putSetting(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/* ── Postgres 구현 ───────────────────────────────────────────────────── */

type LeadRow = {
  id: string; name: string; phone: string; area: string; store_name: string; stage: number;
  doc_date: string | null; advisor: boolean; open_target: string; memo: string; flag: boolean;
  store_id: string | null; created_at: Date; updated_at: Date; version: number;
};

const mapLead = (r: LeadRow): FranchiseLead => ({
  id: r.id, name: r.name, phone: r.phone, area: r.area, storeName: r.store_name, stage: Number(r.stage),
  docDate: r.doc_date, advisor: Boolean(r.advisor), openTarget: r.open_target, memo: r.memo, flag: Boolean(r.flag),
  storeId: r.store_id, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), version: Number(r.version),
});

export class PostgresFieldStore implements FieldStore {
  constructor(private readonly pool: PoolInstance) {}

  static fromEnv(env: NodeJS.ProcessEnv): PostgresFieldStore {
    const url = env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL_REQUIRED");
    return new PostgresFieldStore(new Pool({ connectionString: url, max: Number(env.DB_POOL_MAX ?? 5) }));
  }

  async listLeads(): Promise<FranchiseLead[]> {
    const res = await this.pool.query<LeadRow>(
      `SELECT id, name, phone, area, store_name, stage, doc_date::text AS doc_date, advisor, open_target, memo, flag,
              store_id, created_at, updated_at, version
       FROM franchise_leads WHERE NOT deleted ORDER BY stage, updated_at DESC`);
    return res.rows.map(mapLead);
  }
  async getLead(id: string): Promise<FranchiseLead | null> {
    const res = await this.pool.query<LeadRow>(
      `SELECT id, name, phone, area, store_name, stage, doc_date::text AS doc_date, advisor, open_target, memo, flag,
              store_id, created_at, updated_at, version
       FROM franchise_leads WHERE id = $1 AND NOT deleted`, [id]);
    return res.rows[0] ? mapLead(res.rows[0]) : null;
  }
  async createLead(input: LeadInput): Promise<FranchiseLead> {
    const res = await this.pool.query<LeadRow>(
      `INSERT INTO franchise_leads (id, name, phone, area, store_name, doc_date, advisor, open_target, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, phone, area, store_name, stage, doc_date::text AS doc_date, advisor, open_target, memo, flag,
                 store_id, created_at, updated_at, version`,
      [randomUUID(), input.name.trim(), input.phone ?? "", input.area ?? "", input.storeName ?? "",
        input.docDate || null, Boolean(input.advisor), input.openTarget ?? "", input.memo ?? ""]);
    const created = res.rows[0];
    if (!created) throw new Error("리드 생성 결과를 받지 못했습니다.");
    return mapLead(created);
  }
  async updateLead(id: string, patch: Partial<LeadInput>): Promise<FranchiseLead | null> {
    const res = await this.pool.query<LeadRow>(
      `UPDATE franchise_leads SET
         name = COALESCE($2, name), phone = COALESCE($3, phone), area = COALESCE($4, area),
         store_name = COALESCE($5, store_name),
         doc_date = CASE WHEN $6 THEN $7::date ELSE doc_date END,
         advisor = COALESCE($8, advisor), open_target = COALESCE($9, open_target), memo = COALESCE($10, memo),
         updated_at = now(), version = version + 1
       WHERE id = $1 AND NOT deleted
       RETURNING id, name, phone, area, store_name, stage, doc_date::text AS doc_date, advisor, open_target, memo, flag,
                 store_id, created_at, updated_at, version`,
      [id, patch.name?.trim() ?? null, patch.phone ?? null, patch.area ?? null, patch.storeName ?? null,
        patch.docDate !== undefined, patch.docDate ?? null,
        patch.advisor === undefined ? null : Boolean(patch.advisor), patch.openTarget ?? null, patch.memo ?? null]);
    return res.rows[0] ? mapLead(res.rows[0]) : null;
  }
  async setLeadStage(id: string, stage: number, flag: boolean, storeId?: string | null): Promise<FranchiseLead | null> {
    const res = await this.pool.query<LeadRow>(
      `UPDATE franchise_leads SET stage = $2, flag = $3,
         store_id = CASE WHEN $4::uuid IS NULL THEN store_id ELSE $4::uuid END,
         updated_at = now(), version = version + 1
       WHERE id = $1 AND NOT deleted
       RETURNING id, name, phone, area, store_name, stage, doc_date::text AS doc_date, advisor, open_target, memo, flag,
                 store_id, created_at, updated_at, version`,
      [id, stage, flag, storeId ?? null]);
    return res.rows[0] ? mapLead(res.rows[0]) : null;
  }
  async removeLead(id: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE franchise_leads SET deleted = true, updated_at = now() WHERE id = $1 AND NOT deleted", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async listNotices(): Promise<Notice[]> {
    const res = await this.pool.query<{ id: string; notice_date: string; title: string; body: string; pinned: boolean }>(
      "SELECT id, notice_date::text AS notice_date, title, body, pinned FROM notices WHERE NOT deleted ORDER BY pinned DESC, notice_date DESC, created_at DESC");
    return res.rows.map((r) => ({ id: r.id, date: r.notice_date, title: r.title, body: r.body, pinned: Boolean(r.pinned) }));
  }
  async createNotice(input: { title: string; body?: string; pinned?: boolean }): Promise<Notice> {
    const res = await this.pool.query<{ id: string; notice_date: string; title: string; body: string; pinned: boolean }>(
      `INSERT INTO notices (id, title, body, pinned) VALUES ($1,$2,$3,$4)
       RETURNING id, notice_date::text AS notice_date, title, body, pinned`,
      [randomUUID(), input.title.trim(), input.body ?? "", Boolean(input.pinned)]);
    const r = res.rows[0];
    if (!r) throw new Error("공지 생성 결과를 받지 못했습니다.");
    return { id: r.id, date: r.notice_date, title: r.title, body: r.body, pinned: Boolean(r.pinned) };
  }
  async removeNotice(id: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE notices SET deleted = true, updated_at = now() WHERE id = $1 AND NOT deleted", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async getSetting(key: string): Promise<string | null> {
    const res = await this.pool.query<{ value: string }>("SELECT value FROM app_settings WHERE key = $1", [key]);
    return res.rows[0]?.value ?? null;
  }
  async putSetting(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, value]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/* ── 메모리 구현 (테스트·메모리 모드) ─────────────────────────────────── */

const cloneLead = (lead: FranchiseLead): FranchiseLead => ({ ...lead });

export class MemoryFieldStore implements FieldStore {
  private leads: FranchiseLead[] = [];
  private notices: Array<Notice & { deleted: boolean; createdAt: string }> = [];
  private settings = new Map<string, string>();

  async listLeads(): Promise<FranchiseLead[]> {
    return [...this.leads].sort((a, b) => a.stage - b.stage || b.updatedAt.localeCompare(a.updatedAt)).map(cloneLead);
  }
  async getLead(id: string): Promise<FranchiseLead | null> {
    const lead = this.leads.find((l) => l.id === id);
    return lead ? cloneLead(lead) : null;
  }
  async createLead(input: LeadInput): Promise<FranchiseLead> {
    const now = new Date().toISOString();
    const lead: FranchiseLead = {
      id: randomUUID(), name: input.name.trim(), phone: input.phone ?? "", area: input.area ?? "",
      storeName: input.storeName ?? "", stage: 0, docDate: input.docDate || null, advisor: Boolean(input.advisor),
      openTarget: input.openTarget ?? "", memo: input.memo ?? "", flag: false, storeId: null,
      createdAt: now, updatedAt: now, version: 1,
    };
    this.leads.push(lead);
    return cloneLead(lead);
  }
  async updateLead(id: string, patch: Partial<LeadInput>): Promise<FranchiseLead | null> {
    const lead = this.leads.find((l) => l.id === id);
    if (!lead) return null;
    if (patch.name !== undefined) lead.name = patch.name.trim();
    if (patch.phone !== undefined) lead.phone = patch.phone;
    if (patch.area !== undefined) lead.area = patch.area;
    if (patch.storeName !== undefined) lead.storeName = patch.storeName;
    if (patch.docDate !== undefined) lead.docDate = patch.docDate || null;
    if (patch.advisor !== undefined) lead.advisor = Boolean(patch.advisor);
    if (patch.openTarget !== undefined) lead.openTarget = patch.openTarget;
    if (patch.memo !== undefined) lead.memo = patch.memo;
    lead.updatedAt = new Date().toISOString();
    lead.version += 1;
    return cloneLead(lead);
  }
  async setLeadStage(id: string, stage: number, flag: boolean, storeId?: string | null): Promise<FranchiseLead | null> {
    const lead = this.leads.find((l) => l.id === id);
    if (!lead) return null;
    lead.stage = stage;
    lead.flag = flag;
    if (storeId != null) lead.storeId = storeId;
    lead.updatedAt = new Date().toISOString();
    lead.version += 1;
    return cloneLead(lead);
  }
  async removeLead(id: string): Promise<boolean> {
    const index = this.leads.findIndex((l) => l.id === id);
    if (index < 0) return false;
    this.leads.splice(index, 1);
    return true;
  }

  async listNotices(): Promise<Notice[]> {
    return this.notices.filter((n) => !n.deleted)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .map(({ id, date, title, body, pinned }) => ({ id, date, title, body, pinned }));
  }
  async createNotice(input: { title: string; body?: string; pinned?: boolean }): Promise<Notice> {
    const notice = { id: randomUUID(), date: kstToday(), title: input.title.trim(), body: input.body ?? "",
      pinned: Boolean(input.pinned), deleted: false, createdAt: new Date().toISOString() };
    this.notices.push(notice);
    const { id, date, title, body, pinned } = notice;
    return { id, date, title, body, pinned };
  }
  async removeNotice(id: string): Promise<boolean> {
    const notice = this.notices.find((n) => n.id === id && !n.deleted);
    if (!notice) return false;
    notice.deleted = true;
    return true;
  }

  async getSetting(key: string): Promise<string | null> { return this.settings.get(key) ?? null; }
  async putSetting(key: string, value: string): Promise<void> { this.settings.set(key, value); }
  async close(): Promise<void> {}
}

export function createFieldStore(env: NodeJS.ProcessEnv): FieldStore {
  return env.REPOSITORY_MODE === "postgres" ? PostgresFieldStore.fromEnv(env) : new MemoryFieldStore();
}
