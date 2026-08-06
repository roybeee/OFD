import { randomUUID } from "node:crypto";
import { DomainError, type AuditEvent, type OutboxEvent } from "@ofd/domain";
import { outboxRetryDelayMs,
  type AggregateChange, type AggregateType, type AuditSearchInput, type CommitRequest, type IdempotencyRecord, type StateRepository,
  type RepositoryReadiness, type RequiredMigration, type WebhookRecord, type WorkerHeartbeat } from "./repository.ts";
import { deriveClaims } from "./claims.ts";

interface Entry {
  version: number;
  storeId?: string;
  value: unknown;
}

const keyOf = (type: AggregateType, id: string): string => `${type}:${id}`;
const clone = <T>(value: T): T => structuredClone(value);
const entryOf = (version: number, value: unknown, storeId?: string): Entry => ({
  version,
  value: clone(value),
  ...(storeId !== undefined ? { storeId } : {}),
});

export class MemoryRepository implements StateRepository {
  private records = new Map<string, Entry>();
  private audits: AuditEvent[] = [];
  private outbox = new Map<string, OutboxEvent>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private webhooks = new Map<string, WebhookRecord>();
  private workerHeartbeats = new Map<string, WorkerHeartbeat>();
  private claims = new Map<string, string>();
  private transactionTail: Promise<void> = Promise.resolve();
  private exclusiveTails = new Map<string, Promise<void>>();
  private transactionScoped = false;

  constructor(seed: AggregateChange[] = [], private readonly runtime: {
    now?: () => Date;
    random?: () => number;
    leaseToken?: () => string;
  } = {}) {
    for (const item of seed) {
      const valueVersion = typeof item.value === "object" && item.value && "version" in item.value
        ? Number((item.value as { version: unknown }).version)
        : 1;
      this.records.set(keyOf(item.type, item.id), entryOf(valueVersion, item.value, item.storeId));
      for (const claim of deriveClaims(item)) this.claims.set(`${claim.type}:${claim.key}`, `${claim.aggregateType}:${claim.aggregateId}`);
    }
  }

  async get<T>(type: AggregateType, id: string): Promise<T | undefined> {
    const entry = this.records.get(keyOf(type, id));
    return entry ? clone(entry.value as T) : undefined;
  }

  async list<T>(type: AggregateType, storeIds?: string[]): Promise<T[]> {
    if (storeIds !== undefined && storeIds.length === 0) return [];
    const prefix = `${type}:`;
    return [...this.records.entries()]
      .filter(([key, entry]) => key.startsWith(prefix) && (!storeIds || (Boolean(entry.storeId) && storeIds.includes(entry.storeId!))))
      .map(([, entry]) => clone(entry.value as T));
  }

  async commit(request: CommitRequest): Promise<void> {
    const nextRecords = new Map(this.records);
    const nextClaims = new Map(this.claims);
    for (const change of request.changes) {
      this.applyClaims(nextClaims, change);
      this.applyChange(nextRecords, change);
    }
    this.records = nextRecords;
    this.claims = nextClaims;
    for (const audit of request.audits ?? []) this.audits.push(clone(audit));
    for (const event of request.outbox ?? []) this.outbox.set(event.id, clone(event));
  }

  private applyClaims(target: Map<string, string>, change: AggregateChange): void {
    for (const claim of deriveClaims(change)) {
      const key = `${claim.type}:${claim.key}`;
      const owner = target.get(key);
      if (owner && owner !== `${claim.aggregateType}:${claim.aggregateId}`) {
        throw new DomainError("BUSINESS_KEY_CONFLICT", "동일 업무 대상을 중복 생성할 수 없습니다.", 409, { claimType: claim.type });
      }
      target.set(key, `${claim.aggregateType}:${claim.aggregateId}`);
    }
  }

  private applyChange(target: Map<string, Entry>, change: AggregateChange): void {
    const key = keyOf(change.type, change.id);
    const existing = target.get(key);
    if (change.expectedVersion === null) {
      if (existing) throw new DomainError("AGGREGATE_EXISTS", "이미 생성된 데이터입니다.", 409);
      const version = this.valueVersion(change.value, 1);
      target.set(key, entryOf(version, change.value, change.storeId));
      return;
    }
    if (!existing || existing.version !== change.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "다른 사용자가 먼저 변경했습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.", 409);
    }
    const nextVersion = this.valueVersion(change.value, change.expectedVersion + 1);
    if (nextVersion !== change.expectedVersion + 1) {
      throw new DomainError("INVALID_NEXT_VERSION", "저장할 버전이 예상 버전보다 정확히 1 커야 합니다.", 500);
    }
    target.set(key, entryOf(nextVersion, change.value, change.storeId ?? existing.storeId));
  }

  private valueVersion(value: unknown, fallback: number): number {
    return typeof value === "object" && value !== null && "version" in value
      ? Number((value as { version: unknown }).version)
      : fallback;
  }

  async listAudit(limit = 100, storeIds?: string[]): Promise<AuditEvent[]> {
    if (storeIds !== undefined && storeIds.length === 0) return [];
    return this.audits
      .filter((event) => storeIds === undefined || (Boolean(event.storeId) && storeIds.includes(event.storeId!)))
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  async searchAudit(input: AuditSearchInput): Promise<{ rows: AuditEvent[]; total: number }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const page = Math.max(input.page ?? 1, 1);
    if (input.storeIds !== undefined && input.storeIds.length === 0) return { rows: [], total: 0 };
    const needle = input.q?.toLowerCase();
    const kstDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
    const matched = this.audits.filter((event) => {
      if (input.storeIds !== undefined && !(event.storeId && input.storeIds.includes(event.storeId))) return false;
      if (input.excludeSystem && event.actorRole === "system") return false;
      if (input.from || input.to) {
        const date = kstDate(event.occurredAt);
        if (input.from && date < input.from) return false;
        if (input.to && date > input.to) return false;
      }
      if (needle) {
        const haystack = [event.action, event.aggregateType, event.aggregateId, event.actorId, JSON.stringify(event.metadata)]
          .join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    const ordered = [...matched].reverse();
    return { total: ordered.length, rows: ordered.slice((page - 1) * limit, (page - 1) * limit + limit).map(clone) };
  }

  async transaction<T>(run: (repository: StateRepository) => Promise<T>): Promise<T> {
    if (this.transactionScoped) return run(this);
    const previous = this.transactionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.transactionTail = previous.then(() => current);
    await previous;
    try {
    const scoped = new MemoryRepository([], this.runtime);
    scoped.records = structuredClone(this.records);
    scoped.audits = structuredClone(this.audits);
    scoped.outbox = structuredClone(this.outbox);
    scoped.idempotency = structuredClone(this.idempotency);
    scoped.webhooks = structuredClone(this.webhooks);
    scoped.workerHeartbeats = structuredClone(this.workerHeartbeats);
    scoped.claims = structuredClone(this.claims);
    scoped.transactionTail = this.transactionTail;
    scoped.exclusiveTails = this.exclusiveTails;
    scoped.transactionScoped = true;
    const result = await run(scoped);
    this.records = scoped.records;
    this.audits = scoped.audits;
    this.outbox = scoped.outbox;
    this.idempotency = scoped.idempotency;
    this.webhooks = scoped.webhooks;
    this.workerHeartbeats = scoped.workerHeartbeats;
    this.claims = scoped.claims;
    return result;
    } finally {
      release();
    }
  }

  async exclusiveTransaction<T>(key: string, run: (repository: StateRepository) => Promise<T>): Promise<T> {
    if (this.transactionScoped) return run(this);
    const previous = this.exclusiveTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.exclusiveTails.set(key, tail);
    await previous;
    try {
      return await this.transaction(run);
    } finally {
      release();
      if (this.exclusiveTails.get(key) === tail) this.exclusiveTails.delete(key);
    }
  }

  async reserveIdempotency(actorId: string, key: string, requestHash: string, expiresAt: string): Promise<IdempotencyRecord | undefined> {
    const mapKey = `${actorId}:${key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing && new Date(existing.expiresAt) > new Date()) {
      if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
      return existing.statusCode > 0 ? clone(existing) : undefined;
    }
    this.idempotency.set(mapKey, { actorId, key, requestHash, statusCode: 0, response: null, expiresAt });
    return undefined;
  }

  async getIdempotency(actorId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.idempotency.get(`${actorId}:${key}`);
    if (!record || record.statusCode <= 0 || new Date(record.expiresAt) <= new Date()) return undefined;
    return clone(record);
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    const key = `${record.actorId}:${record.key}`;
    const existing = this.idempotency.get(key);
    if (existing && existing.requestHash !== record.requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
    }
    this.idempotency.set(key, clone(record));
  }

  async claimOutbox(limit: number, workerId = "memory-worker", maxAttempts = 12, leaseMs = 5 * 60_000): Promise<OutboxEvent[]> {
    const now = this.now();
    for (const event of this.outbox.values()) {
      const expired = event.status === "processing" && (!event.leaseExpiresAt || new Date(event.leaseExpiresAt) <= now);
      if (event.attempts >= maxAttempts && (event.status === "pending" || event.status === "failed" || expired)) {
        event.status = "dead_letter";
        event.deadLetterAt = now.toISOString();
        this.clearOutboxLease(event);
        this.outbox.set(event.id, event);
      }
    }
    const selected = [...this.outbox.values()]
      .filter((event) => event.attempts < maxAttempts && (((event.status === "pending" || event.status === "failed")
        && new Date(event.availableAt) <= now) || (event.status === "processing"
          && (!event.leaseExpiresAt || new Date(event.leaseExpiresAt) <= now))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const event of selected) {
      event.status = "processing";
      event.attempts += 1;
      event.lockedAt = now.toISOString();
      event.lockedBy = workerId;
      event.leaseToken = this.runtime.leaseToken?.() ?? randomUUID();
      event.leaseExpiresAt = new Date(now.valueOf() + leaseMs).toISOString();
      this.outbox.set(event.id, event);
    }
    return selected.map(clone);
  }

  async completeOutbox(id: string, workerId: string, leaseToken: string, error?: string, maxAttempts = 12): Promise<boolean> {
    const event = this.outbox.get(id);
    const now = this.now();
    if (!event || event.status !== "processing" || event.lockedBy !== workerId || event.leaseToken !== leaseToken
      || !event.leaseExpiresAt || new Date(event.leaseExpiresAt) <= now) return false;
    event.status = error ? (event.attempts >= maxAttempts ? "dead_letter" : "failed") : "completed";
    if (error) {
      event.lastError = error;
      delete event.processedAt;
      event.availableAt = new Date(now.valueOf() + outboxRetryDelayMs(event.topic, event.attempts,
        this.runtime.random?.() ?? Math.random())).toISOString();
    } else {
      delete event.lastError;
      event.processedAt = now.toISOString();
    }
    if (event.status === "dead_letter") event.deadLetterAt = now.toISOString();
    else delete event.deadLetterAt;
    this.clearOutboxLease(event);
    this.outbox.set(id, event);
    return true;
  }

  async requeueOutbox(id: string): Promise<OutboxEvent | undefined> {
    const event = this.outbox.get(id);
    if (!event || event.status !== "dead_letter") return undefined;
    event.status = "pending";
    event.attempts = 0;
    event.availableAt = this.now().toISOString();
    delete event.lastError;
    delete event.deadLetterAt;
    this.clearOutboxLease(event);
    this.outbox.set(id, event);
    return clone(event);
  }

  async recordWorkerHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    this.workerHeartbeats.set(heartbeat.workerId, clone(heartbeat));
  }

  async getWorkerHeartbeat(workerId: string): Promise<WorkerHeartbeat | undefined> {
    const heartbeat = this.workerHeartbeats.get(workerId);
    return heartbeat ? clone(heartbeat) : undefined;
  }

  async checkReadiness(_requiredMigrations: readonly RequiredMigration[], _now = this.now()): Promise<RepositoryReadiness> {
    return {
      ok: true,
      database: { ok: true, mode: "memory" },
      migrations: { ok: true, notRequired: true, expected: 0, applied: 0, missing: [], drifted: [], unexpected: [] },
      worker: { ok: true, notRequired: true },
    };
  }

  private now(): Date {
    return this.runtime.now?.() ?? new Date();
  }

  private clearOutboxLease(event: OutboxEvent): void {
    delete event.lockedAt;
    delete event.lockedBy;
    delete event.leaseToken;
    delete event.leaseExpiresAt;
  }

  async receiveWebhook(record: WebhookRecord): Promise<boolean> {
    const key = `${record.provider}:${record.eventId}`;
    if (this.webhooks.has(key)) return false;
    this.webhooks.set(key, clone(record));
    return true;
  }

  async close(): Promise<void> {}
}
