import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "./memory-repository.ts";
import { outboxRetryDelayMs } from "./repository.ts";

const outbox = (id: string, topic = "internal.test") => ({
  id, topic, aggregateId: id, payload: {}, status: "pending" as const, attempts: 0,
  availableAt: "2026-08-04T00:00:00.000Z", createdAt: "2026-08-04T00:00:00.000Z",
});

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

test("order당 shipment, receipt당 settlement, invoice 생성 그룹·파트 business key를 경쟁 안전하게 선점한다", async () => {
  const repository = new MemoryRepository();
  await repository.commit({ changes: [
    { type: "shipment", id: "sh-1", expectedVersion: null, value: { id: "sh-1", orderId: "order-1", version: 1 } },
    { type: "settlement", id: "set-1", expectedVersion: null, value: { id: "set-1", storeId: "store-1", kind: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31", receiptIds: ["receipt-1"], version: 1 } },
    { type: "tax_invoice", id: "inv-1", expectedVersion: null, value: {
      id: "inv-1", settlementId: "set-1", invoiceGroupId: "group-1", partNumber: 1, issueType: "normal", version: 1,
    } },
  ] });
  await assert.rejects(repository.commit({ changes: [
    { type: "shipment", id: "sh-2", expectedVersion: null, value: { id: "sh-2", orderId: "order-1", version: 1 } },
  ] }), /중복 생성/);
  await assert.rejects(repository.commit({ changes: [
    { type: "settlement", id: "set-2", expectedVersion: null, value: { id: "set-2", storeId: "store-1", kind: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31", receiptIds: ["receipt-1"], version: 1 } },
  ] }), /중복 생성/);
  await assert.rejects(repository.commit({ changes: [
    { type: "tax_invoice", id: "inv-2", expectedVersion: null, value: {
      id: "inv-2", settlementId: "set-1", invoiceGroupId: "group-2", partNumber: 1, issueType: "normal", version: 1,
    } },
  ] }), /중복 생성/);
  await repository.commit({ changes: [
    { type: "tax_invoice", id: "inv-3", expectedVersion: null, value: {
      id: "inv-3", settlementId: "set-1", invoiceGroupId: "group-1", partNumber: 2, issueType: "normal", version: 1,
    } },
  ] });
  await assert.rejects(repository.commit({ changes: [
    { type: "tax_invoice", id: "inv-4", expectedVersion: null, value: {
      id: "inv-4", settlementId: "set-1", invoiceGroupId: "group-1", partNumber: 2, issueType: "normal", version: 1,
    } },
  ] }), /중복 생성/);
});

test("exclusiveTransaction은 동시 호출을 직렬화하고 잠금 획득 후 최신 상태를 다시 읽는다", async () => {
  const repository = new MemoryRepository([{ type: "admin_invariant", id: "counter", expectedVersion: null,
    value: { id: "counter", count: 0, version: 1 } }]);
  const increment = () => repository.exclusiveTransaction("counter", async (scoped) => {
    const current = (await scoped.get<{ id: string; count: number; version: number }>("admin_invariant", "counter"))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scoped.commit({ changes: [{ type: "admin_invariant", id: current.id, expectedVersion: current.version,
      value: { ...current, count: current.count + 1, version: current.version + 1 } }] });
  });
  await Promise.all([increment(), increment()]);
  assert.equal((await repository.get<{ count: number }>("admin_invariant", "counter"))?.count, 2);
});

test("outbox lease fencing rejects an expired owner after another worker reclaims the event", async () => {
  let now = new Date("2026-08-04T00:00:00.000Z");
  let token = 0;
  const repository = new MemoryRepository([], {
    now: () => now, random: () => 0.5, leaseToken: () => `lease-${++token}`,
  });
  await repository.commit({ changes: [], outbox: [outbox("lease-event")] });

  const first = (await repository.claimOutbox(1, "worker-a", 3, 1_000))[0]!;
  assert.equal(first.leaseToken, "lease-1");
  assert.equal(first.leaseExpiresAt, "2026-08-04T00:00:01.000Z");
  now = new Date("2026-08-04T00:00:01.001Z");
  const reclaimed = (await repository.claimOutbox(1, "worker-b", 3, 1_000))[0]!;
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.leaseToken, "lease-2");
  assert.equal(await repository.completeOutbox(first.id, "worker-a", first.leaseToken!), false);
  assert.equal(await repository.completeOutbox(reclaimed.id, "worker-b", reclaimed.leaseToken!), true);
});

test("a crashed final-attempt processing lease becomes dead-lettered instead of stuck", async () => {
  let now = new Date("2026-08-04T00:00:00.000Z");
  let token = 0;
  const repository = new MemoryRepository([], { now: () => now, leaseToken: () => `final-${++token}` });
  await repository.commit({ changes: [], outbox: [outbox("final-crash")] });
  await repository.claimOutbox(1, "worker-a", 2, 1_000);
  now = new Date("2026-08-04T00:00:01.001Z");
  const finalAttempt = (await repository.claimOutbox(1, "worker-b", 2, 1_000))[0]!;
  assert.equal(finalAttempt.attempts, 2);
  now = new Date("2026-08-04T00:00:02.002Z");
  assert.deepEqual(await repository.claimOutbox(1, "worker-c", 2, 1_000), []);
  assert.equal((await repository.requeueOutbox(finalAttempt.id))?.status, "pending");
});

test("outbox retry delay is topic-aware, exponential, jittered, and deterministic", async () => {
  assert.equal(outboxRetryDelayMs("invoice.issue.requested", 1, 0.5), 5 * 60_000);
  assert.equal(outboxRetryDelayMs("invoice.issue.requested", 8, 0.5), 6 * 60 * 60_000);
  assert.equal(outboxRetryDelayMs("internal.test", 1, 0.5), 2_000);
  assert.equal(outboxRetryDelayMs("internal.test", 12, 0.5), 5 * 60_000);
  assert.equal(outboxRetryDelayMs("internal.test", 2, 0), 3_000);
  assert.equal(outboxRetryDelayMs("internal.test", 2, 1), 5_000);

  let now = new Date("2026-08-04T00:00:00.000Z");
  const repository = new MemoryRepository([], { now: () => now, random: () => 0.5, leaseToken: () => "backoff-lease" });
  await repository.commit({ changes: [], outbox: [outbox("provider-backoff", "invoice.issue.requested")] });
  const claimed = (await repository.claimOutbox(1, "worker", 3, 10_000))[0]!;
  assert.equal(await repository.completeOutbox(claimed.id, "worker", claimed.leaseToken!, "temporary", 3), true);
  now = new Date("2026-08-04T00:04:59.999Z");
  assert.deepEqual(await repository.claimOutbox(1, "worker", 3, 10_000), []);
  now = new Date("2026-08-04T00:05:00.000Z");
  assert.equal((await repository.claimOutbox(1, "worker", 3, 10_000))[0]?.attempts, 2);
});

test("worker heartbeat is persisted with state and expiry", async () => {
  const repository = new MemoryRepository();
  const heartbeat = { workerId: "worker-heartbeat", state: "running" as const,
    observedAt: "2026-08-04T00:00:00.000Z", leaseExpiresAt: "2026-08-04T00:01:00.000Z" };
  await repository.recordWorkerHeartbeat(heartbeat);
  assert.deepEqual(await repository.getWorkerHeartbeat(heartbeat.workerId), heartbeat);
});

test("감사 검색은 키워드·KST 일자·시스템 제외·페이지네이션을 함께 적용한다", async () => {
  const repository = new MemoryRepository();
  const push = async (action: string, actorRole: string, occurredAt: string, storeId?: string) => {
    await repository.commit({
      changes: [{ type: "store", id: `s-${action}-${occurredAt}`, expectedVersion: null, value: { id: "x", version: 1 } }],
      audits: [{ id: `a-${action}-${occurredAt}`, aggregateType: "store", aggregateId: "x", action,
        actorId: actorRole === "system" ? "scheduler" : "master-1", actorRole: actorRole as "hq_master",
        ...(storeId ? { storeId } : {}), metadata: { note: action }, occurredAt }],
    });
  };
  await push("매장 등록", "hq_master", "2026-08-01T02:00:00.000Z", "store-1");
  await push("POS 자동 수집", "system", "2026-08-02T02:00:00.000Z", "store-1");
  await push("가맹점 오픈 등록", "hq_master", "2026-08-03T14:30:00.000Z", "store-2"); // KST 2026-08-03 23:30
  await push("숙려기간 미준수 사후기록", "hq_master", "2026-08-03T16:00:00.000Z", "store-2"); // KST 2026-08-04 01:00

  const all = await repository.searchAudit({});
  assert.equal(all.total, 4);
  assert.equal(all.rows[0]?.action, "숙려기간 미준수 사후기록", "최신순");

  assert.equal((await repository.searchAudit({ excludeSystem: true })).total, 3, "스케줄러 항목 제외");
  assert.equal((await repository.searchAudit({ q: "오픈" })).total, 1, "키워드는 action에 걸린다");
  assert.equal((await repository.searchAudit({ q: "scheduler" })).total, 1, "액터로도 찾는다");

  const kstDay = await repository.searchAudit({ from: "2026-08-03", to: "2026-08-03" });
  assert.equal(kstDay.total, 1, "16:00Z는 KST로 다음 날이므로 제외된다");
  assert.equal(kstDay.rows[0]?.action, "가맹점 오픈 등록");

  const paged = await repository.searchAudit({ limit: 2, page: 2 });
  assert.equal(paged.total, 4);
  assert.equal(paged.rows.length, 2);
  assert.equal(paged.rows[0]?.action, "POS 자동 수집", "2페이지는 3번째 항목부터");

  assert.deepEqual(await repository.searchAudit({ storeIds: [] }), { rows: [], total: 0 }, "빈 스코프는 즉시 차단");
  assert.equal((await repository.searchAudit({ storeIds: ["store-2"] })).total, 2);
});
