import type { AuditEvent, OutboxEvent } from "@ofd/domain";

export type AggregateType =
  | "actor"
  | "legal_entity"
  | "store"
  | "product"
  | "order"
  | "shipment"
  | "receipt"
  | "payment_request"
  | "bank_transaction"
  | "settlement"
  | "tax_invoice"
  | "notification"
  | "document"
  | "upload_session"
  | "credential"
  | "admin_invariant";

export interface AggregateChange<T = unknown> {
  type: AggregateType;
  id: string;
  storeId?: string;
  expectedVersion: number | null;
  value: T;
}

export interface CommitRequest {
  changes: AggregateChange[];
  audits?: AuditEvent[];
  outbox?: OutboxEvent[];
}

export interface IdempotencyRecord {
  actorId: string;
  key: string;
  requestHash: string;
  statusCode: number;
  response: unknown;
  expiresAt: string;
}

export interface WebhookRecord {
  provider: string;
  eventId: string;
  payload: unknown;
  status: "received" | "processed" | "failed";
  receivedAt: string;
  processedAt?: string;
  lastError?: string;
}

export interface WorkerHeartbeat {
  workerId: string;
  state: "running" | "stopping";
  observedAt: string;
  leaseExpiresAt: string;
}

export interface RequiredMigration {
  version: string;
  checksumSha256: string;
}

export interface RepositoryReadiness {
  ok: boolean;
  database: { ok: boolean; mode: "memory" | "postgres"; code?: string };
  migrations: {
    ok: boolean;
    notRequired?: boolean;
    expected: number;
    applied: number;
    missing: string[];
    drifted: string[];
    unexpected: string[];
    code?: string;
  };
  worker: {
    ok: boolean;
    notRequired?: boolean;
    state?: WorkerHeartbeat["state"];
    observedAt?: string;
    leaseExpiresAt?: string;
    code?: string;
  };
}

export interface StateRepository {
  get<T>(type: AggregateType, id: string): Promise<T | undefined>;
  list<T>(type: AggregateType, storeIds?: string[]): Promise<T[]>;
  commit(request: CommitRequest): Promise<void>;
  listAudit(limit?: number, storeIds?: string[]): Promise<AuditEvent[]>;
  transaction<T>(run: (repository: StateRepository) => Promise<T>): Promise<T>;
  /** Runs against freshly-read state while holding a process/distributed exclusive lock for the supplied business key. */
  exclusiveTransaction<T>(key: string, run: (repository: StateRepository) => Promise<T>): Promise<T>;
  reserveIdempotency(actorId: string, key: string, requestHash: string, expiresAt: string): Promise<IdempotencyRecord | undefined>;
  getIdempotency(actorId: string, key: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<void>;
  claimOutbox(limit: number, workerId?: string, maxAttempts?: number, leaseMs?: number): Promise<OutboxEvent[]>;
  /** Returns false when the owner/token/expiry fence no longer authorizes completion. */
  completeOutbox(id: string, workerId: string, leaseToken: string, error?: string, maxAttempts?: number): Promise<boolean>;
  requeueOutbox(id: string): Promise<OutboxEvent | undefined>;
  recordWorkerHeartbeat(heartbeat: WorkerHeartbeat): Promise<void>;
  getWorkerHeartbeat(workerId: string): Promise<WorkerHeartbeat | undefined>;
  checkReadiness(requiredMigrations: readonly RequiredMigration[], now?: Date): Promise<RepositoryReadiness>;
  receiveWebhook(record: WebhookRecord): Promise<boolean>;
  close(): Promise<void>;
}

const providerTopics = new Set([
  "invoice.issue.requested",
  "invoice.retry.requested",
  "invoice.reconcile.requested",
  "bank.sync.requested",
]);

export function isProviderOutboxTopic(topic: string): boolean {
  return providerTopics.has(topic);
}

/** Topic-aware exponential retry delay with bounded multiplicative jitter. */
export function outboxRetryDelayMs(topic: string, attempts: number, jitterUnit: number): number {
  const provider = isProviderOutboxTopic(topic);
  const base = provider ? 5 * 60_000 : 2_000;
  const cap = provider ? 6 * 60 * 60_000 : 5 * 60_000;
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  const exponential = Math.min(cap, base * 2 ** exponent);
  const normalizedJitter = Math.max(0, Math.min(1, jitterUnit));
  return Math.max(1_000, Math.round(exponential * (0.75 + normalizedJitter * 0.5)));
}

export function deterministicOutboxJitter(id: string, attempts: number): number {
  let hash = 2_166_136_261;
  for (const character of `${id}:${attempts}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}
