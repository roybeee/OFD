import { createHash } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import { DomainError, invariant, type Actor } from "@ofd/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

export async function idempotentMutation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: StateRepository,
  actor: Actor,
  statusCode: number,
  run: (repository: StateRepository) => Promise<T>,
): Promise<T | void> {
  const rawKey = request.headers["idempotency-key"];
  invariant(typeof rawKey === "string" && rawKey.length >= 8 && rawKey.length <= 128,
    "IDEMPOTENCY_KEY_REQUIRED", "변경 요청에는 8~128자의 Idempotency-Key가 필요합니다.", 428);
  const requestHash = createHash("sha256").update(JSON.stringify({ method: request.method, url: request.url, body: request.body })).digest("hex");
  const result = await repository.transaction(async (scoped) => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const existing = await scoped.reserveIdempotency(actor.id, rawKey, requestHash, expiresAt);
    if (existing) return { replayed: true as const, statusCode: existing.statusCode, response: existing.response as T };
    const response = await run(scoped);
    await scoped.saveIdempotency({ actorId: actor.id, key: rawKey, requestHash, statusCode, response, expiresAt });
    return { replayed: false as const, statusCode, response };
  });
  if (result.replayed) reply.header("Idempotency-Replayed", "true");
  reply.code(result.statusCode);
  return result.response;
}
