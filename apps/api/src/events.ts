import { randomUUID } from "node:crypto";
import type { Actor, AuditEvent, OutboxEvent } from "@ofd/domain";

export function audit(actor: Actor, aggregateType: string, aggregateId: string, action: string, storeId: string | undefined,
  before: unknown, after: unknown, metadata: Record<string, unknown> = {}): AuditEvent {
  return { id: randomUUID(), aggregateType, aggregateId, action, actorId: actor.id, actorRole: actor.role, storeId,
    before, after, metadata, occurredAt: new Date().toISOString() };
}

export function outbox(topic: string, aggregateId: string, payload: unknown): OutboxEvent {
  const now = new Date().toISOString();
  return { id: randomUUID(), topic, aggregateId, payload, status: "pending", attempts: 0, availableAt: now, createdAt: now };
}
