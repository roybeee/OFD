import { createHash } from "node:crypto";
import { DomainError, type AuditEvent, type OutboxEvent } from "@ofd/domain";
import pg from "pg";
import { deterministicOutboxJitter, outboxRetryDelayMs,
  type AggregateChange, type AggregateType, type CommitRequest, type IdempotencyRecord, type StateRepository,
  type RepositoryReadiness, type RequiredMigration, type WebhookRecord, type WorkerHeartbeat } from "./repository.ts";
import { deriveClaims } from "./claims.ts";

const { Pool } = pg;
type PoolInstance = InstanceType<typeof Pool>;

export class PostgresRepository implements StateRepository {
  constructor(private readonly pool: PoolInstance, private readonly scopedClient?: pg.PoolClient) {}

  static connect(connectionString: string, env: NodeJS.ProcessEnv = process.env): PostgresRepository {
    return new PostgresRepository(new Pool({
      connectionString,
      max: Number(env.DB_POOL_MAX ?? 20),
      connectionTimeoutMillis: Number(env.DB_CONNECT_TIMEOUT_MS ?? 5_000),
      query_timeout: Number(env.DB_QUERY_TIMEOUT_MS ?? 15_000),
    }));
  }

  async get<T>(type: AggregateType, id: string): Promise<T | undefined> {
    const result = await this.query<{ payload: T }>(
      "SELECT payload FROM aggregate_snapshots WHERE aggregate_type = $1 AND aggregate_id = $2",
      [type, id],
    );
    return result.rows[0]?.payload;
  }

  async list<T>(type: AggregateType, storeIds?: string[]): Promise<T[]> {
    if (storeIds !== undefined && storeIds.length === 0) return [];
    const result = storeIds !== undefined
      ? await this.query<{ payload: T }>(
        "SELECT payload FROM aggregate_snapshots WHERE aggregate_type = $1 AND store_id = ANY($2::text[]) ORDER BY updated_at DESC",
        [type, storeIds],
      )
      : await this.query<{ payload: T }>(
        "SELECT payload FROM aggregate_snapshots WHERE aggregate_type = $1 ORDER BY updated_at DESC",
        [type],
      );
    return result.rows.map((row) => row.payload);
  }

  async commit(request: CommitRequest): Promise<void> {
    const client = this.scopedClient ?? await this.pool.connect();
    const ownsTransaction = !this.scopedClient;
    try {
      if (ownsTransaction) await client.query("BEGIN");
      for (const change of request.changes) await this.writeAggregate(client, change);

      // 빈 ledger의 동시 genesis를 포함해 전체 hash-chain에 쓰기 순서를 강제한다.
      if ((request.audits?.length ?? 0) > 0) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ofd_audit_ledger_chain'))");
      }
      let previousHash = (await client.query<{ event_hash: string }>(
        "SELECT event_hash FROM audit_ledger ORDER BY sequence DESC LIMIT 1 FOR UPDATE",
      )).rows[0]?.event_hash;
      for (const event of request.audits ?? []) {
        const canonical = JSON.stringify({ ...event, previousHash });
        const eventHash = createHash("sha256").update(canonical).digest("hex");
        await client.query(
          `INSERT INTO audit_ledger
           (id, aggregate_type, aggregate_id, action, actor_id, actor_role, store_id, before_data, after_data, metadata, previous_hash, event_hash, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)`,
          [event.id, event.aggregateType, event.aggregateId, event.action, event.actorId, event.actorRole, event.storeId ?? null,
            event.before === undefined ? null : JSON.stringify(event.before), event.after === undefined ? null : JSON.stringify(event.after),
            JSON.stringify(event.metadata), previousHash ?? null, eventHash, event.occurredAt],
        );
        previousHash = eventHash;
      }
      for (const event of request.outbox ?? []) {
        await client.query(
          `INSERT INTO outbox_events (id, topic, aggregate_id, payload, status, attempts, available_at, created_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
          [event.id, event.topic, event.aggregateId, JSON.stringify(event.payload), event.status, event.attempts, event.availableAt, event.createdAt],
        );
      }
      if (ownsTransaction) await client.query("COMMIT");
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  private async writeAggregate(client: pg.PoolClient, change: AggregateChange): Promise<void> {
    const valueVersion = typeof change.value === "object" && change.value !== null && "version" in change.value
      ? Number((change.value as { version: unknown }).version)
      : (change.expectedVersion ?? 0) + 1;
    if (change.expectedVersion === null) {
      for (const claim of deriveClaims(change)) {
        try {
          await client.query(
            "INSERT INTO aggregate_claims (claim_type,claim_key,aggregate_type,aggregate_id) VALUES ($1,$2,$3,$4)",
            [claim.type, claim.key, claim.aggregateType, claim.aggregateId],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            throw new DomainError("BUSINESS_KEY_CONFLICT", "동일 업무 대상을 중복 생성할 수 없습니다.", 409, { claimType: claim.type });
          }
          throw error;
        }
      }
      const result = await client.query(
        `INSERT INTO aggregate_snapshots (aggregate_type, aggregate_id, store_id, version, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [change.type, change.id, change.storeId ?? null, valueVersion, JSON.stringify(change.value)],
      );
      if (result.rowCount !== 1) throw new DomainError("AGGREGATE_EXISTS", "이미 생성된 데이터입니다.", 409);
      return;
    }
    if (valueVersion !== change.expectedVersion + 1) {
      throw new DomainError("INVALID_NEXT_VERSION", "저장할 버전이 예상 버전보다 정확히 1 커야 합니다.", 500);
    }
    const result = await client.query(
      `UPDATE aggregate_snapshots SET store_id = COALESCE($3, store_id), version = $4, payload = $5::jsonb, updated_at = now()
       WHERE aggregate_type = $1 AND aggregate_id = $2 AND version = $6`,
      [change.type, change.id, change.storeId ?? null, valueVersion, JSON.stringify(change.value), change.expectedVersion],
    );
    if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "다른 사용자가 먼저 변경했습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.", 409);
  }

  async listAudit(limit = 100, storeIds?: string[]): Promise<AuditEvent[]> {
    if (storeIds !== undefined && storeIds.length === 0) return [];
    const params: unknown[] = [limit];
    const scope = storeIds !== undefined ? "WHERE store_id = ANY($2::text[])" : "";
    if (scope) params.push(storeIds);
    const result = await this.query<{
      id: string; aggregate_type: string; aggregate_id: string; action: string; actor_id: string; actor_role: AuditEvent["actorRole"];
      store_id: string | null; before_data: unknown | null; after_data: unknown | null; metadata: Record<string, unknown>; occurred_at: Date;
    }>(`SELECT * FROM audit_ledger ${scope} ORDER BY sequence DESC LIMIT $1`, params);
    return result.rows.map((row) => ({
      id: row.id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, action: row.action,
      actorId: row.actor_id, actorRole: row.actor_role,
      ...(row.store_id !== null ? { storeId: row.store_id } : {}),
      ...(row.before_data !== null ? { before: row.before_data } : {}),
      ...(row.after_data !== null ? { after: row.after_data } : {}),
      metadata: row.metadata, occurredAt: row.occurred_at.toISOString(),
    }));
  }

  async transaction<T>(run: (repository: StateRepository) => Promise<T>): Promise<T> {
    if (this.scopedClient) return run(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(new PostgresRepository(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async exclusiveTransaction<T>(key: string, run: (repository: StateRepository) => Promise<T>): Promise<T> {
    return this.transaction(async (repository) => {
      await (repository as PostgresRepository).query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      return run(repository);
    });
  }

  async reserveIdempotency(actorId: string, key: string, requestHash: string, expiresAt: string): Promise<IdempotencyRecord | undefined> {
    const inserted = await this.query(
      `INSERT INTO idempotency_keys (actor_id,key,request_hash,state,expires_at)
       VALUES ($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING RETURNING key`,
      [actorId, key, requestHash, expiresAt],
    );
    if (inserted.rowCount === 1) return undefined;
    const existing = await this.query<{
      actor_id: string; key: string; request_hash: string; state: string; status_code: number | null; response: unknown; expires_at: Date;
    }>("SELECT * FROM idempotency_keys WHERE actor_id=$1 AND key=$2 FOR UPDATE", [actorId, key]);
    const row = existing.rows[0];
    if (!row || row.expires_at <= new Date()) {
      await this.query("DELETE FROM idempotency_keys WHERE actor_id=$1 AND key=$2", [actorId, key]);
      return this.reserveIdempotency(actorId, key, requestHash, expiresAt);
    }
    if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
    if (row.state !== "completed" || row.status_code === null) throw new DomainError("IDEMPOTENCY_IN_PROGRESS", "동일 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.", 409);
    return { actorId: row.actor_id, key: row.key, requestHash: row.request_hash, statusCode: row.status_code, response: row.response, expiresAt: row.expires_at.toISOString() };
  }

  async getIdempotency(actorId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.query<{
      actor_id: string; key: string; request_hash: string; status_code: number; response: unknown; expires_at: Date;
    }>("SELECT * FROM idempotency_keys WHERE actor_id=$1 AND key=$2 AND state='completed' AND expires_at > now()", [actorId, key]);
    const row = result.rows[0];
    return row ? { actorId: row.actor_id, key: row.key, requestHash: row.request_hash, statusCode: row.status_code, response: row.response, expiresAt: row.expires_at.toISOString() } : undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    const result = await this.query<{ request_hash: string }>(
      `INSERT INTO idempotency_keys (actor_id,key,request_hash,state,status_code,response,expires_at)
       VALUES ($1,$2,$3,'completed',$4,$5::jsonb,$6)
       ON CONFLICT (actor_id,key) DO UPDATE SET state='completed', status_code=EXCLUDED.status_code,
         response=EXCLUDED.response, expires_at=EXCLUDED.expires_at WHERE idempotency_keys.request_hash=EXCLUDED.request_hash
       RETURNING request_hash`,
      [record.actorId, record.key, record.requestHash, record.statusCode, JSON.stringify(record.response), record.expiresAt],
    );
    if (result.rows[0]?.request_hash !== record.requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
    }
  }

  async claimOutbox(limit: number, workerId = "worker", maxAttempts = 12, leaseMs = 5 * 60_000): Promise<OutboxEvent[]> {
    await this.query(
      `UPDATE outbox_events SET status='dead_letter', dead_letter_at=now(), locked_at=NULL, locked_by=NULL,
         lease_token=NULL, lease_expires_at=NULL
       WHERE attempts >= $1 AND (status IN ('pending','failed') OR (status='processing'
         AND COALESCE(lease_expires_at, locked_at + interval '5 minutes', now()) <= now()))`, [maxAttempts],
    );
    const result = await this.query<{
      id: string; topic: string; aggregate_id: string; payload: unknown; status: OutboxEvent["status"]; attempts: number;
      available_at: Date; created_at: Date; processed_at: Date | null; last_error: string | null;
      locked_at: Date | null; locked_by: string | null; lease_token: string | null; lease_expires_at: Date | null;
      dead_letter_at: Date | null;
    }>(
      `WITH claimed AS (
         SELECT id FROM outbox_events
         WHERE attempts < $2 AND ((status IN ('pending','failed') AND available_at <= now())
            OR (status='processing' AND COALESCE(lease_expires_at, locked_at + interval '5 minutes', now()) <= now()))
         ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE outbox_events o SET status='processing', attempts=o.attempts+1, locked_at=now(), locked_by=$3,
         lease_token=gen_random_uuid()::text, lease_expires_at=now() + ($4 * interval '1 millisecond')
       FROM claimed WHERE o.id=claimed.id RETURNING o.*`,
      [limit, maxAttempts, workerId, leaseMs],
    );
    return result.rows.map((row) => ({
      id: row.id, topic: row.topic, aggregateId: row.aggregate_id, payload: row.payload, status: row.status,
      attempts: row.attempts, availableAt: row.available_at.toISOString(), createdAt: row.created_at.toISOString(),
      ...(row.processed_at ? { processedAt: row.processed_at.toISOString() } : {}),
      ...(row.last_error !== null ? { lastError: row.last_error } : {}),
      ...(row.locked_at ? { lockedAt: row.locked_at.toISOString() } : {}),
      ...(row.locked_by !== null ? { lockedBy: row.locked_by } : {}),
      ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
      ...(row.dead_letter_at ? { deadLetterAt: row.dead_letter_at.toISOString() } : {}),
    }));
  }

  async completeOutbox(id: string, workerId: string, leaseToken: string, error?: string, maxAttempts = 12): Promise<boolean> {
    const current = await this.query<{ topic: string; attempts: number }>(
      `SELECT topic, attempts FROM outbox_events WHERE id=$1 AND status='processing' AND locked_by=$2
       AND lease_token=$3 AND lease_expires_at > now()`, [id, workerId, leaseToken],
    );
    const event = current.rows[0];
    if (!event) return false;
    if (error) {
      const retryDelayMs = outboxRetryDelayMs(event.topic, event.attempts, deterministicOutboxJitter(id, event.attempts));
      const result = await this.query(
        `UPDATE outbox_events SET status=CASE WHEN attempts >= $3 THEN 'dead_letter' ELSE 'failed' END,
         dead_letter_at=CASE WHEN attempts >= $3 THEN now() ELSE NULL END, last_error=$2, locked_at=NULL, locked_by=NULL,
         lease_token=NULL, lease_expires_at=NULL, processed_at=NULL,
         available_at=now() + ($6 * interval '1 millisecond')
         WHERE id=$1 AND status='processing' AND locked_by=$4 AND lease_token=$5 AND lease_expires_at > now()`,
        [id, error.slice(0, 2_000), maxAttempts, workerId, leaseToken, retryDelayMs],
      );
      return result.rowCount === 1;
    } else {
      const result = await this.query(
        `UPDATE outbox_events SET status='completed', processed_at=now(), last_error=NULL, locked_at=NULL, locked_by=NULL,
         lease_token=NULL, lease_expires_at=NULL WHERE id=$1 AND status='processing' AND locked_by=$2
         AND lease_token=$3 AND lease_expires_at > now()`, [id, workerId, leaseToken],
      );
      return result.rowCount === 1;
    }
  }

  async requeueOutbox(id: string): Promise<OutboxEvent | undefined> {
    const result = await this.query<{
      id: string; topic: string; aggregate_id: string; payload: unknown; status: OutboxEvent["status"]; attempts: number;
      available_at: Date; created_at: Date;
    }>(
      `UPDATE outbox_events SET status='pending', attempts=0, available_at=now(), last_error=NULL, dead_letter_at=NULL,
       locked_at=NULL, locked_by=NULL, lease_token=NULL, lease_expires_at=NULL
       WHERE id=$1 AND status='dead_letter' RETURNING *`, [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, topic: row.topic, aggregateId: row.aggregate_id, payload: row.payload, status: row.status,
      attempts: row.attempts, availableAt: row.available_at.toISOString(), createdAt: row.created_at.toISOString() } : undefined;
  }

  async recordWorkerHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    await this.query(
      `INSERT INTO worker_heartbeats (worker_id,state,observed_at,lease_expires_at,updated_at)
       VALUES ($1,$2,$3,$4,now()) ON CONFLICT (worker_id) DO UPDATE SET state=EXCLUDED.state,
       observed_at=EXCLUDED.observed_at, lease_expires_at=EXCLUDED.lease_expires_at, updated_at=now()`,
      [heartbeat.workerId, heartbeat.state, heartbeat.observedAt, heartbeat.leaseExpiresAt],
    );
  }

  async getWorkerHeartbeat(workerId: string): Promise<WorkerHeartbeat | undefined> {
    const result = await this.query<{
      worker_id: string; state: WorkerHeartbeat["state"]; observed_at: Date; lease_expires_at: Date;
    }>("SELECT worker_id,state,observed_at,lease_expires_at FROM worker_heartbeats WHERE worker_id=$1", [workerId]);
    const row = result.rows[0];
    return row ? { workerId: row.worker_id, state: row.state, observedAt: row.observed_at.toISOString(),
      leaseExpiresAt: row.lease_expires_at.toISOString() } : undefined;
  }

  async checkReadiness(requiredMigrations: readonly RequiredMigration[], now = new Date()): Promise<RepositoryReadiness> {
    const unavailable = (code: string): RepositoryReadiness => ({
      ok: false,
      database: { ok: false, mode: "postgres", code },
      migrations: { ok: false, expected: requiredMigrations.length, applied: 0, missing: requiredMigrations.map((item) => item.version),
        drifted: [], unexpected: [], code: "DATABASE_UNAVAILABLE" },
      worker: { ok: false, code: "DATABASE_UNAVAILABLE" },
    });
    try {
      await this.query("SELECT 1 AS ready");
    } catch {
      return unavailable("DATABASE_UNAVAILABLE");
    }

    let migrations: RepositoryReadiness["migrations"];
    try {
      const appliedResult = await this.query<{ version: string; checksum_sha256: string | null }>(
        "SELECT version,checksum_sha256 FROM schema_migrations ORDER BY version",
      );
      const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum_sha256]));
      const expected = new Map(requiredMigrations.map((migration) => [migration.version, migration.checksumSha256]));
      const missing = requiredMigrations.filter((migration) => !applied.has(migration.version)).map((migration) => migration.version);
      const drifted = requiredMigrations.filter((migration) => applied.has(migration.version)
        && applied.get(migration.version) !== migration.checksumSha256).map((migration) => migration.version);
      const unexpected = [...applied.keys()].filter((version) => !expected.has(version));
      const ok = missing.length === 0 && drifted.length === 0 && unexpected.length === 0;
      migrations = { ok, expected: requiredMigrations.length, applied: applied.size, missing, drifted, unexpected,
        ...(!ok ? { code: "MIGRATION_LEDGER_MISMATCH" } : {}) };
    } catch {
      migrations = { ok: false, expected: requiredMigrations.length, applied: 0,
        missing: requiredMigrations.map((item) => item.version), drifted: [], unexpected: [], code: "MIGRATION_LEDGER_UNAVAILABLE" };
    }

    let worker: RepositoryReadiness["worker"];
    try {
      const heartbeatResult = await this.query<{
        state: WorkerHeartbeat["state"]; observed_at: Date; lease_expires_at: Date;
      }>("SELECT state,observed_at,lease_expires_at FROM worker_heartbeats ORDER BY observed_at DESC LIMIT 1");
      const heartbeat = heartbeatResult.rows[0];
      const ok = Boolean(heartbeat && heartbeat.state === "running" && heartbeat.lease_expires_at > now);
      worker = heartbeat
        ? { ok, state: heartbeat.state, observedAt: heartbeat.observed_at.toISOString(),
          leaseExpiresAt: heartbeat.lease_expires_at.toISOString(), ...(!ok ? { code: "WORKER_HEARTBEAT_STALE" } : {}) }
        : { ok: false, code: "WORKER_HEARTBEAT_MISSING" };
    } catch {
      worker = { ok: false, code: "WORKER_HEARTBEAT_UNAVAILABLE" };
    }

    return { ok: migrations.ok && worker.ok, database: { ok: true, mode: "postgres" }, migrations, worker };
  }

  async receiveWebhook(record: WebhookRecord): Promise<boolean> {
    const result = await this.query(
      `INSERT INTO webhook_inbox (provider,event_id,payload,status,received_at)
       VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
      [record.provider, record.eventId, JSON.stringify(record.payload), record.status, record.receivedAt],
    );
    return result.rowCount === 1;
  }

  async close(): Promise<void> {
    if (!this.scopedClient) await this.pool.end();
  }

  private query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
    return (this.scopedClient ?? this.pool).query<T>(text, values);
  }
}
