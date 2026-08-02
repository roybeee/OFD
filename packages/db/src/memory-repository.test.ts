import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "./memory-repository.ts";

test("optimistic lock이 오래된 쓰기를 거부하고 원본을 보존한다", async () => {
  const repository = new MemoryRepository([{ type: "order", id: "o1", storeId: "s1", expectedVersion: null, value: { id: "o1", version: 1, status: "draft" } }]);
  await assert.rejects(repository.commit({ changes: [{
    type: "order", id: "o1", storeId: "s1", expectedVersion: 0, value: { id: "o1", version: 1, status: "submitted" },
  }] }), /먼저 변경/);
  assert.equal((await repository.get<{ status: string }>("order", "o1"))?.status, "draft");
});

test("트랜잭션 중 한 변경이 실패하면 모든 변경을 롤백한다", async () => {
  const repository = new MemoryRepository([{ type: "order", id: "o1", expectedVersion: null, value: { id: "o1", version: 1 } }]);
  await assert.rejects(repository.commit({ changes: [
    { type: "shipment", id: "sh1", expectedVersion: null, value: { id: "sh1", version: 1 } },
    { type: "order", id: "o1", expectedVersion: 7, value: { id: "o1", version: 8 } },
  ] }));
  assert.equal(await repository.get("shipment", "sh1"), undefined);
});

test("webhook inbox가 동일 provider event를 한 번만 받는다", async () => {
  const repository = new MemoryRepository();
  const record = { provider: "popbill", eventId: "evt-1", payload: {}, status: "received" as const, receivedAt: new Date().toISOString() };
  assert.equal(await repository.receiveWebhook(record), true);
  assert.equal(await repository.receiveWebhook(record), false);
});

test("빈 매장 범위는 전체 데이터가 아니라 빈 결과를 반환한다", async () => {
  const repository = new MemoryRepository([
    { type: "order", id: "o1", storeId: "s1", expectedVersion: null, value: { id: "o1", version: 1 } },
  ]);
  assert.deepEqual(await repository.list("order", []), []);
  assert.deepEqual(await repository.listAudit(100, []), []);
});

test("도메인 저장 직후 장애가 나면 idempotency 예약과 도메인 변경을 함께 롤백한다", async () => {
  const repository = new MemoryRepository();
  await assert.rejects(repository.transaction(async (scoped) => {
    await scoped.reserveIdempotency("actor-1", "request-key", "hash-1", new Date(Date.now() + 60_000).toISOString());
    await scoped.commit({ changes: [{ type: "order", id: "o-crash", expectedVersion: null, value: { id: "o-crash", version: 1 } }] });
    throw new Error("simulated crash");
  }), /simulated crash/);
  assert.equal(await repository.get("order", "o-crash"), undefined);
  assert.equal(await repository.getIdempotency("actor-1", "request-key"), undefined);

  await repository.transaction(async (scoped) => {
    const existing = await scoped.reserveIdempotency("actor-1", "request-key", "hash-1", new Date(Date.now() + 60_000).toISOString());
    assert.equal(existing, undefined);
    await scoped.commit({ changes: [{ type: "order", id: "o-crash", expectedVersion: null, value: { id: "o-crash", version: 1 } }] });
    await scoped.saveIdempotency({ actorId: "actor-1", key: "request-key", requestHash: "hash-1", statusCode: 201,
      response: { id: "o-crash" }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  });
  assert.deepEqual(await repository.getIdempotency("actor-1", "request-key"), {
    actorId: "actor-1", key: "request-key", requestHash: "hash-1", statusCode: 201,
    response: { id: "o-crash" }, expiresAt: (await repository.getIdempotency("actor-1", "request-key"))!.expiresAt,
  });
});

test("order당 shipment, receipt당 settlement, settlement당 invoice business key를 경쟁 안전하게 선점한다", async () => {
  const repository = new MemoryRepository();
  await repository.commit({ changes: [
    { type: "shipment", id: "sh-1", expectedVersion: null, value: { id: "sh-1", orderId: "order-1", version: 1 } },
    { type: "settlement", id: "set-1", expectedVersion: null, value: { id: "set-1", storeId: "store-1", periodStart: "2026-07-01", periodEnd: "2026-07-31", receiptIds: ["receipt-1"], version: 1 } },
    { type: "tax_invoice", id: "inv-1", expectedVersion: null, value: { id: "inv-1", settlementId: "set-1", version: 1 } },
  ] });
  await assert.rejects(repository.commit({ changes: [
    { type: "shipment", id: "sh-2", expectedVersion: null, value: { id: "sh-2", orderId: "order-1", version: 1 } },
  ] }), /중복 생성/);
  await assert.rejects(repository.commit({ changes: [
    { type: "settlement", id: "set-2", expectedVersion: null, value: { id: "set-2", storeId: "store-1", periodStart: "2026-08-01", periodEnd: "2026-08-31", receiptIds: ["receipt-1"], version: 1 } },
  ] }), /중복 생성/);
  await assert.rejects(repository.commit({ changes: [
    { type: "tax_invoice", id: "inv-2", expectedVersion: null, value: { id: "inv-2", settlementId: "set-1", version: 1 } },
  ] }), /중복 생성/);
});
