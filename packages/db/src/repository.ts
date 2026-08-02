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
  | "upload_session"
  | "credential";

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

export interface StateRepository {
  get<T>(type: AggregateType, id: string): Promise<T | undefined>;
  list<T>(type: AggregateType, storeIds?: string[]): Promise<T[]>;
  commit(request: CommitRequest): Promise<void>;
  listAudit(limit?: number, storeIds?: string[]): Promise<AuditEvent[]>;
  transaction<T>(run: (repository: StateRepository) => Promise<T>): Promise<T>;
  reserveIdempotency(actorId: string, key: string, requestHash: string, expiresAt: string): Promise<IdempotencyRecord | undefined>;
  getIdempotency(actorId: string, key: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<void>;
  claimOutbox(limit: number, workerId?: string, maxAttempts?: number): Promise<OutboxEvent[]>;
  completeOutbox(id: string, error?: string, maxAttempts?: number): Promise<void>;
  requeueOutbox(id: string): Promise<OutboxEvent | undefined>;
  receiveWebhook(record: WebhookRecord): Promise<boolean>;
  close(): Promise<void>;
}
