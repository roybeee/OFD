import { randomUUID } from "node:crypto";
import pg from "pg";

import { OPENING_PHASES, OPENING_TEMPLATE, type OpeningPhase } from "./opening-template.ts";

export interface OpeningInput {
  name: string; region: string | null; openDate: string;
  mode: "가맹" | "운영대행"; storeType: "테이블형" | "포장형";
  stage?: OpeningStage; memo?: string;
}
export type OpeningStage = "상담중" | "진행" | "보류" | "완료";
export interface OpeningTask {
  id: string; phase: OpeningPhase; group: string; title: string; detail: string;
  owner: "hq" | "pt" | "both"; dayOffset: number; deadline: string;
  done: boolean; doneAt: string | null; memo: string; overdue: boolean; custom: boolean;
}
export interface OpeningSummary {
  id: string; name: string; region: string | null; openDate: string;
  mode: string; storeType: string; stage: OpeningStage; storeId: string | null; memo: string;
  total: number; done: number; overdue: number; progressPct: number; dDay: number;
  phases: Record<string, { total: number; done: number }>;
}
export interface OpeningDetail extends OpeningSummary { tasks: OpeningTask[] }

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const seoulToday = (now = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** 오픈유형에 맞는 템플릿만 남긴다 (V1: stype 지정 항목은 해당 유형에서만) */
export const templateFor = (storeType: string): readonly typeof OPENING_TEMPLATE[number][] =>
  OPENING_TEMPLATE.filter((item) => !item.storeType || item.storeType === storeType);

/** 지연 판정: 진행 단계에서만 집계한다 — 상담중/보류/완료는 미집계 (V1 규칙) */
export function decorateTasks(
  openDate: string, stage: OpeningStage,
  rows: Array<Omit<OpeningTask, "deadline" | "overdue">>,
  today = seoulToday(),
): OpeningTask[] {
  return rows.map((row) => {
    const deadline = addDays(openDate, row.dayOffset);
    return { ...row, deadline, overdue: stage === "진행" && !row.done && deadline < today };
  });
}

export function summarize(
  base: Omit<OpeningSummary, "total" | "done" | "overdue" | "progressPct" | "dDay" | "phases">,
  tasks: OpeningTask[], today = seoulToday(),
): OpeningSummary {
  const phases: Record<string, { total: number; done: number }> = {};
  for (const phase of OPENING_PHASES) phases[phase] = { total: 0, done: 0 };
  for (const task of tasks) {
    const bucket = phases[task.phase] ?? (phases[task.phase] = { total: 0, done: 0 });
    bucket.total += 1;
    if (task.done) bucket.done += 1;
  }
  const done = tasks.filter((t) => t.done).length;
  return {
    ...base, phases,
    total: tasks.length, done,
    overdue: tasks.filter((t) => t.overdue).length,
    progressPct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    dDay: daysBetween(today, base.openDate),
  };
}

export interface OpeningStore {
  create(input: OpeningInput): Promise<OpeningDetail>;
  list(today?: string): Promise<OpeningSummary[]>;
  get(id: string, today?: string): Promise<OpeningDetail | null>;
  setStage(id: string, stage: OpeningStage): Promise<OpeningSummary | null>;
  reschedule(id: string, openDate: string): Promise<OpeningSummary | null>;
  toggleTask(taskId: string, done: boolean, actorId: string | null, memo?: string): Promise<boolean>;
  addTask(openingId: string, input: { phase: OpeningPhase; group: string; title: string; detail?: string; owner: "hq" | "pt" | "both"; dayOffset: number }): Promise<OpeningTask | null>;
  confirmOpen(id: string, storeId: string): Promise<OpeningSummary | null>;
  close(): Promise<void>;
}

export class MemoryOpeningStore implements OpeningStore {
  private openings = new Map<string, OpeningInput & { id: string; stage: OpeningStage; storeId: string | null; memo: string }>();
  private tasks = new Map<string, Array<Omit<OpeningTask, "deadline" | "overdue"> & { openingId: string }>>();

  async create(input: OpeningInput): Promise<OpeningDetail> {
    const id = randomUUID();
    this.openings.set(id, { ...input, id, stage: input.stage ?? "상담중", storeId: null, memo: input.memo ?? "" });
    this.tasks.set(id, templateFor(input.storeType).map((item, index) => ({
      openingId: id, id: randomUUID(), phase: item.phase, group: item.group, title: item.title,
      detail: item.detail, owner: item.owner, dayOffset: item.offset,
      done: false, doneAt: null, memo: "", custom: false, sortOrder: index,
    } as never)));
    return (await this.get(id))!;
  }
  async list(today = seoulToday()): Promise<OpeningSummary[]> {
    const out: OpeningSummary[] = [];
    for (const id of this.openings.keys()) {
      const detail = await this.get(id, today);
      if (detail) { const { tasks: _t, ...summary } = detail; out.push(summary); }
    }
    return out.sort((a, b) => a.openDate.localeCompare(b.openDate));
  }
  async get(id: string, today = seoulToday()): Promise<OpeningDetail | null> {
    const opening = this.openings.get(id);
    if (!opening) return null;
    const tasks = decorateTasks(opening.openDate, opening.stage, this.tasks.get(id) ?? [], today);
    const summary = summarize({
      id, name: opening.name, region: opening.region, openDate: opening.openDate,
      mode: opening.mode, storeType: opening.storeType, stage: opening.stage,
      storeId: opening.storeId, memo: opening.memo,
    }, tasks, today);
    return { ...summary, tasks };
  }
  async setStage(id: string, stage: OpeningStage): Promise<OpeningSummary | null> {
    const opening = this.openings.get(id);
    if (!opening) return null;
    opening.stage = stage;
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async reschedule(id: string, openDate: string): Promise<OpeningSummary | null> {
    const opening = this.openings.get(id);
    if (!opening) return null;
    opening.openDate = openDate; /* 데드라인은 오프셋 기반이라 자동 재계산된다 */
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async toggleTask(taskId: string, done: boolean, _actorId: string | null, memo?: string): Promise<boolean> {
    for (const rows of this.tasks.values()) {
      const task = rows.find((t) => t.id === taskId);
      if (!task) continue;
      task.done = done;
      task.doneAt = done ? new Date().toISOString() : null;
      if (memo !== undefined) task.memo = memo;
      return true;
    }
    return false;
  }
  async addTask(openingId: string, input: { phase: OpeningPhase; group: string; title: string; detail?: string; owner: "hq" | "pt" | "both"; dayOffset: number }): Promise<OpeningTask | null> {
    const opening = this.openings.get(openingId);
    const rows = this.tasks.get(openingId);
    if (!opening || !rows) return null;
    const row = { openingId, id: randomUUID(), phase: input.phase, group: input.group, title: input.title,
      detail: input.detail ?? "", owner: input.owner, dayOffset: input.dayOffset,
      done: false, doneAt: null, memo: "", custom: true } as never as Omit<OpeningTask, "deadline" | "overdue"> & { openingId: string };
    rows.push(row);
    return decorateTasks(opening.openDate, opening.stage, [row])[0] ?? null;
  }
  async confirmOpen(id: string, storeId: string): Promise<OpeningSummary | null> {
    const opening = this.openings.get(id);
    if (!opening) return null;
    opening.storeId = storeId;
    opening.stage = "완료";
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async close(): Promise<void> {}
}

export class PostgresOpeningStore implements OpeningStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromEnv(env: NodeJS.ProcessEnv): PostgresOpeningStore {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
    return new PostgresOpeningStore(new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 }));
  }
  async create(input: OpeningInput): Promise<OpeningDetail> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO store_openings (name, region, open_date, mode, store_type, stage, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.name, input.region, input.openDate, input.mode, input.storeType, input.stage ?? "상담중", input.memo ?? ""]);
      const id = res.rows[0].id as string;
      const items = templateFor(input.storeType);
      for (const [index, item] of items.entries()) {
        await client.query(
          `INSERT INTO store_opening_tasks (opening_id, phase, task_group, title, detail, owner, day_offset, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, item.phase, item.group, item.title, item.detail, item.owner, item.offset, index]);
      }
      await client.query("COMMIT");
      return (await this.get(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async list(today = seoulToday()): Promise<OpeningSummary[]> {
    const res = await this.pool.query(
      `SELECT o.id, o.name, o.region, o.open_date::text AS open_date, o.mode, o.store_type, o.stage, o.store_id, o.memo,
              t.id AS task_id, t.phase, t.task_group, t.title, t.detail, t.owner, t.day_offset, t.done, t.done_at, t.memo AS task_memo, t.custom
       FROM store_openings o LEFT JOIN store_opening_tasks t ON t.opening_id = o.id
       ORDER BY o.open_date, t.sort_order`);
    return groupRows(res.rows, today).map(({ tasks: _t, ...summary }) => summary);
  }
  async get(id: string, today = seoulToday()): Promise<OpeningDetail | null> {
    const res = await this.pool.query(
      `SELECT o.id, o.name, o.region, o.open_date::text AS open_date, o.mode, o.store_type, o.stage, o.store_id, o.memo,
              t.id AS task_id, t.phase, t.task_group, t.title, t.detail, t.owner, t.day_offset, t.done, t.done_at, t.memo AS task_memo, t.custom
       FROM store_openings o LEFT JOIN store_opening_tasks t ON t.opening_id = o.id
       WHERE o.id = $1 ORDER BY t.sort_order`, [id]);
    return groupRows(res.rows, today)[0] ?? null;
  }
  async setStage(id: string, stage: OpeningStage): Promise<OpeningSummary | null> {
    const res = await this.pool.query(
      "UPDATE store_openings SET stage = $2, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING id", [id, stage]);
    if (!res.rows[0]) return null;
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async reschedule(id: string, openDate: string): Promise<OpeningSummary | null> {
    const res = await this.pool.query(
      "UPDATE store_openings SET open_date = $2, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING id", [id, openDate]);
    if (!res.rows[0]) return null;
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async toggleTask(taskId: string, done: boolean, actorId: string | null, memo?: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE store_opening_tasks SET done = $2,
         done_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         done_at = CASE WHEN $2 THEN now() ELSE NULL END,
         memo = COALESCE($4, memo)
       WHERE id = $1 RETURNING id`, [taskId, done, actorId, memo ?? null]);
    return Boolean(res.rows[0]);
  }
  async addTask(openingId: string, input: { phase: OpeningPhase; group: string; title: string; detail?: string; owner: "hq" | "pt" | "both"; dayOffset: number }): Promise<OpeningTask | null> {
    const opening = await this.pool.query("SELECT open_date::text AS open_date, stage FROM store_openings WHERE id = $1", [openingId]);
    if (!opening.rows[0]) return null;
    const res = await this.pool.query(
      `INSERT INTO store_opening_tasks (opening_id, phase, task_group, title, detail, owner, day_offset, sort_order, custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(sort_order),0)+1 FROM store_opening_tasks WHERE opening_id=$1),true)
       RETURNING id, phase, task_group, title, detail, owner, day_offset, done, done_at, memo, custom`,
      [openingId, input.phase, input.group, input.title, input.detail ?? "", input.owner, input.dayOffset]);
    const row = res.rows[0];
    return decorateTasks(opening.rows[0].open_date, opening.rows[0].stage, [{
      id: row.id, phase: row.phase, group: row.task_group, title: row.title, detail: row.detail,
      owner: row.owner, dayOffset: Number(row.day_offset), done: row.done, doneAt: row.done_at, memo: row.memo, custom: row.custom,
    }])[0] ?? null;
  }
  async confirmOpen(id: string, storeId: string): Promise<OpeningSummary | null> {
    const res = await this.pool.query(
      "UPDATE store_openings SET store_id = $2, stage = '완료', updated_at = now(), version = version + 1 WHERE id = $1 RETURNING id",
      [id, storeId]);
    if (!res.rows[0]) return null;
    const detail = await this.get(id);
    if (!detail) return null;
    const { tasks: _t, ...summary } = detail;
    return summary;
  }
  async close(): Promise<void> { await this.pool.end(); }
}

function groupRows(rows: Array<Record<string, unknown>>, today: string): OpeningDetail[] {
  const map = new Map<string, { base: Omit<OpeningSummary, "total" | "done" | "overdue" | "progressPct" | "dDay" | "phases">;
    stage: OpeningStage; openDate: string; tasks: Array<Omit<OpeningTask, "deadline" | "overdue">> }>();
  for (const row of rows) {
    const id = String(row.id);
    let entry = map.get(id);
    if (!entry) {
      entry = {
        base: { id, name: String(row.name), region: (row.region as string | null) ?? null,
          openDate: String(row.open_date), mode: String(row.mode), storeType: String(row.store_type),
          stage: row.stage as OpeningStage, storeId: (row.store_id as string | null) ?? null, memo: String(row.memo ?? "") },
        stage: row.stage as OpeningStage, openDate: String(row.open_date), tasks: [],
      };
      map.set(id, entry);
    }
    if (row.task_id) {
      entry.tasks.push({
        id: String(row.task_id), phase: row.phase as OpeningPhase, group: String(row.task_group),
        title: String(row.title), detail: String(row.detail ?? ""), owner: row.owner as "hq" | "pt" | "both",
        dayOffset: Number(row.day_offset), done: Boolean(row.done),
        doneAt: row.done_at ? new Date(row.done_at as string).toISOString() : null,
        memo: String(row.task_memo ?? ""), custom: Boolean(row.custom),
      });
    }
  }
  return [...map.values()].map(({ base, stage, openDate, tasks }) => {
    const decorated = decorateTasks(openDate, stage, tasks, today);
    return { ...summarize(base, decorated, today), tasks: decorated };
  });
}

export const createOpeningStore = (env: NodeJS.ProcessEnv): OpeningStore =>
  env.REPOSITORY_MODE === "postgres" ? PostgresOpeningStore.fromEnv(env) : new MemoryOpeningStore();
