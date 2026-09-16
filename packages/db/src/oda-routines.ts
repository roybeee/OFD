import { randomUUID } from 'node:crypto';
import pg from 'pg';

export interface RoutineDefinition {
  title: string; prompt: string; timeZone: string; time: string; weekdays: number[];
  mode: 'report' | 'oda_batch'; runnerEndpoint: string; retentionSeconds: number;
  approvalSupported: boolean;
}
export interface OdaRoutine {
  id: string; tokenId: string; storeId: string; definition: RoutineDefinition;
  runnerSecretEnc: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export type RoutineRunStatus = 'queued' | 'submitting' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'stopping' | 'needs_review';
export interface RoutineRunState {
  title: string; mode: RoutineDefinition['mode']; runnerEndpoint: string;
  request: { session_id: string; instructions: string; input: string; conversation_history: never[] };
  runId: string | null; attemptedAt: string | null; retryUntil: string | null;
  retentionSeconds: number; approvalSupported: boolean;
  output: string; error: string;
  approval: null | { id: string; description: string; choices: string[] };
  uncertainApproval?: string;
  batchId?: string;
  resolution?: { note: string; actorId: string; nativeStatus: string | null; confirmedAt: string };
}
export interface OdaRoutineRun {
  id: string; routineId: string; tokenId: string; storeId: string; scheduledFor: string;
  status: RoutineRunStatus; state: RoutineRunState; runnerSecretEnc: string;
  leaseId: string | null; createdAt: string; updatedAt: string;
}
type Row = Record<string, any>;
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const routine = (r: Row): OdaRoutine => ({ id: r.id, tokenId: r.token_id, storeId: r.store_id,
  definition: r.definition, runnerSecretEnc: r.runner_secret_enc, enabled: r.enabled,
  nextRunAt: iso(r.next_run_at), lastRunAt: iso(r.last_run_at), version: r.version,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });
const run = (r: Row): OdaRoutineRun => ({ id: r.id, routineId: r.routine_id, tokenId: r.token_id,
  storeId: r.store_id, scheduledFor: iso(r.scheduled_for)!, status: r.status, state: r.state,
  runnerSecretEnc: r.runner_secret_enc, leaseId: r.lease_id,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });

/** Minute schedules use local wall time. DST gaps are skipped; repeated local
 * times execute once per date by advancing beyond the consumed local date. */
export function nextRoutineTime(def: Pick<RoutineDefinition, 'timeZone' | 'time' | 'weekdays'>, after: Date, consumedDate?: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: def.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let ms = Math.floor(after.getTime() / 60000) * 60000 + 60000, end = ms + 9 * 86400000; ms <= end; ms += 60000) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(v => [v.type, v.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    if ((!consumedDate || date > consumedDate) && `${p.hour}:${p.minute}` === def.time && def.weekdays.includes(days.indexOf(p.weekday!))) return new Date(ms).toISOString();
  }
  throw new Error('ROUTINE_TIME_INVALID');
}
export function routineLocalDate(def: Pick<RoutineDefinition, 'timeZone'>, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: def.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export class PostgresRoutineStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromEnv(env: NodeJS.ProcessEnv) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    return new PostgresRoutineStore(new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 }));
  }
  async close() { await this.pool.end(); }
  async list(tokenId: string) {
    return (await this.pool.query('SELECT * FROM oda_routines WHERE token_id=$1 ORDER BY created_at DESC LIMIT 100', [tokenId])).rows.map(routine);
  }
  async get(tokenId: string, id: string) {
    const row = (await this.pool.query('SELECT * FROM oda_routines WHERE token_id=$1 AND id=$2', [tokenId, id])).rows[0];
    return row ? routine(row) : null;
  }
  async save(value: OdaRoutine, expectedVersion: number | null) {
    const values = [value.id, value.tokenId, value.storeId, JSON.stringify(value.definition), value.runnerSecretEnc, value.enabled, value.nextRunAt, value.updatedAt];
    const result = expectedVersion === null
      ? await this.pool.query(`INSERT INTO oda_routines(id,token_id,store_id,definition,runner_secret_enc,enabled,next_run_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT DO NOTHING RETURNING *`, values)
      : await this.pool.query(`UPDATE oda_routines SET definition=$4,runner_secret_enc=$5,enabled=$6,next_run_at=$7,updated_at=$8,version=version+1
          WHERE id=$1 AND token_id=$2 AND store_id=$3 AND version=$9 RETURNING *`, [...values, expectedVersion]);
    return result.rows[0] ? routine(result.rows[0]) : null;
  }
  async pause(id: string) { await this.pool.query('UPDATE oda_routines SET enabled=false,next_run_at=NULL,version=version+1,updated_at=now() WHERE id=$1', [id]); }
  async runs(tokenId: string, routineId?: string) {
    return (await this.pool.query('SELECT * FROM oda_routine_runs WHERE token_id=$1 AND ($2::text IS NULL OR routine_id=$2) ORDER BY created_at DESC LIMIT 100', [tokenId, routineId ?? null])).rows.map(run);
  }
  async getRun(tokenId: string, id: string) {
    const row = (await this.pool.query('SELECT * FROM oda_routine_runs WHERE token_id=$1 AND id=$2', [tokenId, id])).rows[0];
    return row ? run(row) : null;
  }
  async enqueueNow(tokenId: string, routineId: string, id: string, now: Date, makeState: (routine: OdaRoutine, id: string, scheduledFor: string) => RoutineRunState) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT * FROM oda_routines WHERE token_id=$1 AND id=$2 FOR UPDATE', [tokenId, routineId]);
      if (!selected.rows[0]) throw new Error('ROUTINE_NOT_FOUND');
      const def = routine(selected.rows[0]);
      await client.query(`INSERT INTO oda_routine_runs(id,routine_id,token_id,store_id,scheduled_for,status,state,runner_secret_enc,next_poll_at,created_at,updated_at)
        SELECT $1,$2,$3,$4,$5,'queued',$6,$7,$5,$5,$5 WHERE NOT EXISTS
        (SELECT 1 FROM oda_routine_runs WHERE routine_id=$2 AND status NOT IN ('completed','failed','cancelled','needs_review')) ON CONFLICT DO NOTHING`,
      [id, def.id, tokenId, def.storeId, now.toISOString(), JSON.stringify(makeState(def, id, now.toISOString())), def.runnerSecretEnc]);
      const result = await client.query('SELECT * FROM oda_routine_runs WHERE id=$1 AND routine_id=$2 AND token_id=$3', [id, routineId, tokenId]);
      if (result.rows[0]) await client.query('UPDATE oda_routines SET last_run_at=$2,updated_at=$2 WHERE id=$1', [routineId, now.toISOString()]);
      await client.query('COMMIT');
      return result.rows[0] ? run(result.rows[0]) : null;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async enqueueDue(now: Date, makeState: (routine: OdaRoutine, id: string, scheduledFor: string) => RoutineRunState) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`SELECT * FROM oda_routines WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 10`, [now.toISOString()]);
      for (const row of selected.rows) {
        const def = routine(row), id = randomUUID(), scheduled = def.nextRunAt!;
        const result = await client.query(`INSERT INTO oda_routine_runs(id,routine_id,token_id,store_id,scheduled_for,status,state,runner_secret_enc,next_poll_at,created_at,updated_at)
          SELECT $1,$2,$3,$4,$5,'queued',$6,$7,$8,$8,$8 WHERE NOT EXISTS
          (SELECT 1 FROM oda_routine_runs WHERE routine_id=$2 AND status NOT IN ('completed','failed','cancelled','needs_review')) ON CONFLICT DO NOTHING RETURNING id`,
        [id, def.id, def.tokenId, def.storeId, scheduled, JSON.stringify(makeState(def, id, scheduled)), def.runnerSecretEnc, now.toISOString()]);
        // One catch-up at most. All older occurrences are coalesced, including
        // those suppressed by an active/uncertain/approval-waiting invocation.
        const next = nextRoutineTime(def.definition, now, routineLocalDate(def.definition, new Date(scheduled)));
        await client.query(`UPDATE oda_routines SET next_run_at=$2,last_run_at=CASE WHEN $3 THEN $4 ELSE last_run_at END,updated_at=$4 WHERE id=$1`, [def.id, next, result.rowCount === 1, now.toISOString()]);
      }
      await client.query('COMMIT');
      return selected.rowCount ?? 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async claim(now: Date, id?: string, tokenId?: string) {
    const leaseId = randomUUID();
    const result = await this.pool.query(`UPDATE oda_routine_runs SET lease_id=$2,lease_until=$3 WHERE id=(SELECT id FROM oda_routine_runs
      WHERE ($4::text IS NULL OR id=$4) AND ($5::text IS NULL OR token_id=$5)
      AND (($4::text IS NOT NULL AND status NOT IN ('completed','failed','cancelled','needs_review')) OR
        ($4::text IS NULL AND status NOT IN ('completed','failed','cancelled','needs_review','unknown') AND next_poll_at <= $1))
      AND (lease_until IS NULL OR lease_until < $1) ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [now.toISOString(), leaseId, new Date(now.getTime() + 90000).toISOString(), id ?? null, tokenId ?? null]);
    return result.rows[0] ? run(result.rows[0]) : null;
  }
  async updateRun(value: OdaRoutineRun, now: Date, release = true) {
    const result = await this.pool.query(`UPDATE oda_routine_runs SET state=$3,status=$4,updated_at=$5,next_poll_at=$6,
      lease_id=CASE WHEN $7 THEN NULL ELSE lease_id END,lease_until=CASE WHEN $7 THEN NULL ELSE lease_until END
      WHERE id=$1 AND lease_id=$2 RETURNING id`,
    [value.id, value.leaseId, JSON.stringify(value.state), value.status, now.toISOString(), new Date(now.getTime() + 15000).toISOString(), release]);
    if (result.rowCount !== 1) throw new Error('ROUTINE_LEASE_LOST');
  }
  async resolveUnknown(value: OdaRoutineRun, actorId: string, note: string, nativeStatus: string | null, now: Date) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE oda_routine_runs SET status='cancelled',state=$3,updated_at=$4,lease_id=NULL,lease_until=NULL
        WHERE id=$1 AND lease_id=$2 AND status='unknown' RETURNING *`, [value.id, value.leaseId,
        JSON.stringify({ ...value.state, error: '사용자가 Hermes의 실행 종료를 확인하여 중복 실행 잠금을 해제했습니다. 이미 발생한 외부 결과는 취소되지 않습니다.', approval: null,
          resolution: { note, actorId, nativeStatus, confirmedAt: now.toISOString() } }), now.toISOString()]);
      if (!result.rows[0]) throw new Error('ROUTINE_LEASE_LOST');
      await client.query(`INSERT INTO oda_routine_run_resolutions(run_id,actor_id,token_id,note,native_status,resolved_at) VALUES($1,$2,$3,$4,$5,$6)`, [value.id, actorId, value.tokenId, note, nativeStatus, now.toISOString()]);
      await client.query('COMMIT'); return run(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
