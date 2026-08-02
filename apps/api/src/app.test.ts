import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import { MockObjectStorage } from "@ofd/integrations";
import { generateTotp } from "@ofd/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";

const openApps: FastifyInstance[] = [];
function todayInSeoul() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
async function demoApp(): Promise<FastifyInstance> {
  const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false });
  openApps.push(app);
  return app;
}
afterEach(async () => Promise.all(openApps.splice(0).map((app) => app.close())));

describe("OFD v2 API", () => {
  it("health와 demo bootstrap을 무인증으로 제공한다", async () => {
    const app = await demoApp();
    const health = await app.inject({ method: "GET", url: "/api/v2/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mode: "test", providerMode: "mock" });
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().currentActor.id).toBe(DEMO_IDS.owner);
    expect(bootstrap.json().products.length).toBeGreaterThan(0);
    expect(JSON.stringify(bootstrap.json())).not.toContain("passwordHash");
  });

  it("개인 이메일 로그인은 HttpOnly 세션을 발급하고 본사 계정은 MFA를 거친다", async () => {
    const app = await demoApp();
    const storeLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } });
    expect(storeLogin.statusCode).toBe(200);
    expect(storeLogin.json()).toMatchObject({ authenticated: true, mfaRequired: false });
    expect(storeLogin.headers["set-cookie"]).toContain("HttpOnly");
    expect(storeLogin.headers["set-cookie"]).toContain("SameSite=Strict");

    const hqLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.finance@ofd.local", password: "OFD-demo-2026!" } });
    expect(hqLogin.json()).toMatchObject({ authenticated: false, mfaRequired: true });
    const mfa = await app.inject({ method: "POST", url: "/api/v2/auth/mfa",
      payload: { challengeToken: hqLogin.json().challengeToken, code: generateTotp("JBSWY3DPEHPK3PXP") } });
    expect(mfa.statusCode).toBe(200);
    expect(mfa.headers["set-cookie"]).toContain("HttpOnly");
  });

  it("배송 기사 bootstrap은 배정 배송에 필요한 정보 외 재무·타매장 정보를 노출하지 않는다", async () => {
    const app = await demoApp();
    const response = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.driver } });
    const body = response.json();
    expect(body.shipments.every((shipment: { driverId: string }) => shipment.driverId === DEMO_IDS.driver)).toBe(true);
    expect(body.bankTransactions).toEqual([]);
    expect(body.paymentRequests).toEqual([]);
    expect(body.settlements).toEqual([]);
    expect(body.taxInvoices).toEqual([]);
    expect(body.receipts).toEqual([]);
    const assignedOrderIds = new Set(body.shipments.map((shipment: { orderId: string }) => shipment.orderId));
    expect(body.orders.every((order: { id: string }) => assignedOrderIds.has(order.id))).toBe(true);
  });

  it("감사자는 MFA로 로그인해 전 매장 원장과 감사 이벤트를 읽되 운영 mutation은 수행하지 못한다", async () => {
    const app = await demoApp();
    const login = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "auditor@ofd.local", password: "OFD-demo-2026!" } });
    expect(login.json()).toMatchObject({ authenticated: false, mfaRequired: true });
    const mfa = await app.inject({ method: "POST", url: "/api/v2/auth/mfa",
      payload: { challengeToken: login.json().challengeToken, code: generateTotp("JBSWY3DPEHPK3PXP") } });
    expect(mfa.statusCode).toBe(200);

    const headers = { "x-demo-actor-id": DEMO_IDS.auditor };
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().capabilities).toContain("hq.audit.read");
    expect(bootstrap.json().bankTransactions.length).toBeGreaterThan(0);
    expect(bootstrap.json().taxInvoices.length).toBeGreaterThan(0);
    expect(bootstrap.json().auditEvents).toBeDefined();

    const denied = await app.inject({ method: "POST", url: "/api/v2/orders/00000000-0000-4000-8000-000000003001/approve",
      headers: { ...headers, "idempotency-key": "auditor-cannot-approve" }, payload: { expectedVersion: 1 } });
    expect(denied.statusCode).toBe(403);
  });

  it("발주 생성과 멱등 재시도를 한 번만 처리한다", async () => {
    const app = await demoApp();
    const payload = {
      storeId: DEMO_IDS.storeDoksan, requestedDeliveryDate: "2026-08-05",
      items: [{ productId: DEMO_IDS.productBean, quantity: 2 }],
    };
    const headers = { "idempotency-key": "create-order-test" };
    const first = await app.inject({ method: "POST", url: "/api/v2/orders", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/orders", headers, payload });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.id).toBe(first.json().order.id);
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    expect(bootstrap.json().orders.filter((order: { id: string }) => order.id === first.json().order.id)).toHaveLength(1);
  });

  it("새 발주 생성과 제출을 하나의 멱등 트랜잭션으로 처리해 네트워크 재시도에도 draft나 중복 주문을 남기지 않는다", async () => {
    const app = await demoApp();
    const bootstrapBefore = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const requestedDeliveryDate = bootstrapBefore.json().allowedDeliveryDates[0];
    const existingIds = new Set(bootstrapBefore.json().orders.map((order: { id: string }) => order.id));
    const payload = {
      storeId: DEMO_IDS.storeDoksan,
      requestedDeliveryDate,
      items: [{ productId: DEMO_IDS.productBean, quantity: 2 }],
    };
    const headers = { "idempotency-key": "submit-new-order-test" };

    const first = await app.inject({ method: "POST", url: "/api/v2/orders/submit-new", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/orders/submit-new", headers, payload });

    expect(first.statusCode).toBe(201);
    expect(first.json().order).toMatchObject({ status: "submitted", version: 2 });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.id).toBe(first.json().order.id);
    const bootstrapAfter = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const created = bootstrapAfter.json().orders.filter((order: { id: string }) => !existingIds.has(order.id));
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("submitted");
  });

  it("미업로드 사진으로 배송 완료를 위조할 수 없고 실제 mock 업로드 후에만 입고 확정한다", async () => {
    const app = await demoApp();
    const shipmentId = "00000000-0000-4000-8000-000000004001";
    const actorHeaders = { "x-demo-actor-id": DEMO_IDS.driver };
    const ticketResponse = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/proof-upload`,
      headers: { ...actorHeaders, "idempotency-key": "proof-ticket-test" }, payload: { contentType: "image/jpeg" },
    });
    expect(ticketResponse.statusCode).toBe(201);
    const ticket = ticketResponse.json();
    const deliveryPayload = { expectedVersion: 2, photoKey: ticket.objectKey, recipientName: "박독산", capturedAt: "2026-08-02T06:00:00.000Z" };
    const forged = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/deliver`,
      headers: { ...actorHeaders, "idempotency-key": "deliver-before-upload" }, payload: deliveryPayload,
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error.code).toBe("PHOTO_NOT_UPLOADED");

    const upload = await app.inject({ method: "PUT", url: ticket.uploadUrl, headers: { "content-type": "image/jpeg" }, payload: Buffer.from([0xff, 0xd8, 0xff, 0x00]) });
    expect(upload.statusCode).toBe(204);
    const completed = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/deliver`,
      headers: { ...actorHeaders, "idempotency-key": "deliver-after-upload" }, payload: deliveryPayload,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().shipment.status).toBe("delivered");
    expect(completed.json().receipt.status).toBe("confirmed");
    expect(completed.json().shipment.proof.photoUrl).toBeUndefined();
    expect(completed.json().proofUrl).toMatch(/^\/api\/v2\/mock-files/);
  });

  it("점주는 본사 승인할 수 없고 운영 담당자는 수동 승인한다", async () => {
    const app = await demoApp();
    const orderId = "00000000-0000-4000-8000-000000003001";
    const denied = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/approve`, headers: { "idempotency-key": "owner-approve-test" }, payload: { expectedVersion: 1 },
    });
    expect(denied.statusCode).toBe(403);
    const approved = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/approve`,
      headers: { "x-demo-actor-id": DEMO_IDS.ops, "idempotency-key": "ops-approve-test" }, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().order.status).toBe("approved");
  });

  it("변경 요청을 받은 점주는 최신 가격으로 수정해 재제출하고 네트워크 재시도에도 한 번만 반영한다", async () => {
    const app = await demoApp();
    const orderId = "00000000-0000-4000-8000-000000003001";
    const changed = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/change-request`,
      headers: { "x-demo-actor-id": DEMO_IDS.ops, "idempotency-key": "request-order-change" },
      payload: { expectedVersion: 1, reason: "원두 수량과 입고일을 다시 확인해 주세요." },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().order).toMatchObject({
      status: "change_requested", version: 2,
      changeRequest: { reason: "원두 수량과 입고일을 다시 확인해 주세요.", requestedBy: DEMO_IDS.ops },
    });
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const requestedDeliveryDate = bootstrap.json().allowedDeliveryDates[1];
    const headers = { "idempotency-key": "resubmit-changed-order" };
    const payload = {
      expectedVersion: 2, requestedDeliveryDate, note: "수량 수정 완료",
      items: [{ productId: DEMO_IDS.productBean, quantity: 3 }],
    };
    const first = await app.inject({ method: "POST", url: `/api/v2/orders/${orderId}/resubmit`, headers, payload });
    const replay = await app.inject({ method: "POST", url: `/api/v2/orders/${orderId}/resubmit`, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().order).toMatchObject({ status: "submitted", version: 3, requestedDeliveryDate, note: "수량 수정 완료" });
    expect(first.json().order.lines).toHaveLength(1);
    expect(first.json().order.lines[0]).toMatchObject({ quantity: 3, snapshot: { productId: DEMO_IDS.productBean, unitGross: 28_600 } });
    expect(first.json().order.changeRequest).toBeUndefined();
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.version).toBe(3);
  });

  it("점주 취소는 처리 전 주문만 허용하고 이미 배송이 생성된 주문은 차단한다", async () => {
    const app = await demoApp();
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const created = await app.inject({
      method: "POST", url: "/api/v2/orders/submit-new", headers: { "idempotency-key": "new-order-for-cancel" },
      payload: { storeId: DEMO_IDS.storeDoksan, requestedDeliveryDate: bootstrap.json().allowedDeliveryDates[0], items: [{ productId: DEMO_IDS.productBean, quantity: 1 }] },
    });
    const cancelled = await app.inject({
      method: "POST", url: `/api/v2/orders/${created.json().order.id}/cancel`, headers: { "idempotency-key": "cancel-before-fulfillment" },
      payload: { expectedVersion: 2, reason: "중복 발주 취소" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().order).toMatchObject({ status: "cancelled", version: 3 });

    const blocked = await app.inject({
      method: "POST", url: "/api/v2/orders/00000000-0000-4000-8000-000000003002/cancel",
      headers: { "idempotency-key": "cancel-after-shipment" }, payload: { expectedVersion: 1, reason: "잘못된 취소 요청" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("ORDER_FULFILLMENT_STARTED");
  });

  it("재무 담당자는 MFA 후 잘못 연결한 입금 대사를 사유와 함께 되돌린다", async () => {
    const app = await demoApp();
    const financeHeaders = { "x-demo-actor-id": DEMO_IDS.finance };
    const paymentId = "00000000-0000-4000-8000-000000006001";
    const transactionId = "00000000-0000-4000-8000-000000006101";
    const matched = await app.inject({
      method: "POST", url: `/api/v2/payments/${paymentId}/manual-match`,
      headers: { ...financeHeaders, "idempotency-key": "match-before-reverse" },
      payload: { expectedVersion: 1, bankTransactionId: transactionId },
    });
    expect(matched.statusCode).toBe(200);
    const reversed = await app.inject({
      method: "POST", url: `/api/v2/payments/${paymentId}/reverse-match`,
      headers: { ...financeHeaders, "idempotency-key": "reverse-wrong-match" },
      payload: { expectedVersion: 2, reason: "다른 매장 입금으로 확인" },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().paymentRequest).toMatchObject({ status: "reversed", version: 3 });
    expect(reversed.json().paymentRequest.matchedBankTransactionId).toBeUndefined();
    expect(reversed.json().bankTransaction).toMatchObject({ matched: false, version: 3 });
  });

  it("재무 검토자와 다른 MFA 마스터만 세금계산서 발행을 승인한다", async () => {
    const app = await demoApp();
    const invoiceId = "00000000-0000-4000-8000-000000008001";
    const approved = await app.inject({
      method: "POST", url: `/api/v2/invoices/${invoiceId}/approve`,
      headers: { "x-demo-actor-id": DEMO_IDS.master, "idempotency-key": "master-invoice-approve" }, payload: { expectedVersion: 2 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().invoice).toMatchObject({ status: "approved", approvedBy: DEMO_IDS.master });
  });

  it("계좌 거래 수동 새로고침은 API에서 외부 호출하지 않고 worker outbox에 한 번만 예약한다", async () => {
    const repository = createDemoRepository();
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, repository, logger: false });
    openApps.push(app);
    const headers = { "x-demo-actor-id": DEMO_IDS.finance, "idempotency-key": "bank-sync-request-test" };
    const date = todayInSeoul();
    const payload = { from: date, to: date };
    const first = await app.inject({ method: "POST", url: "/api/v2/bank-sync", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/bank-sync", headers, payload });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    const events = await repository.claimOutbox(10);
    expect(events.filter((event) => event.topic === "bank.sync.requested")).toHaveLength(1);
  });

  it("Popbill webhook API key·MID·CorpNum을 검증하고 중복을 멱등 수신한다", async () => {
    const app = await buildApp({ env: {
      APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent", POPBILL_WEBHOOK_API_KEY: "test-webhook-key",
    }, logger: false });
    openApps.push(app);
    const headers = { "x-api-key": "test-webhook-key", "pb-webhook-mid": "MID-20260802-1", "pb-webhook-corpnum": "1234567890" };
    const payload = { corpNum: "1234567890", stateCode: 300, invoicerMgtKey: "OFD012345678901234567890" };
    const accepted = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers, payload });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    const duplicate = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers, payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ accepted: false });
    const forged = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers: { ...headers, "x-api-key": "wrong", "pb-webhook-mid": "MID-2" }, payload });
    expect(forged.statusCode).toBe(401);
    const missingMid = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers: { "x-api-key": "test-webhook-key", "pb-webhook-corpnum": "1234567890" }, payload });
    expect(missingMid.statusCode).toBe(400);
    const otherCorp = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-3", "pb-webhook-corpnum": "9999999999" }, payload: { ...payload, corpNum: "9999999999" } });
    expect(otherCorp.statusCode).toBe(403);

    const nested = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-NESTED" },
      payload: { header: { QMNum: "202608028888888800000001" }, body: { ...payload, stateCode: 304 } } });
    expect(nested.statusCode).toBe(202);

    const bulk = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-BULK" },
      payload: [
        { header: { QMNum: "202608028888888800000002" }, body: { ...payload, itemKey: "item-1", stateCode: 304 } },
        { header: { QMNum: "202608028888888800000003" }, body: { ...payload, itemKey: "item-2", stateCode: 305 } },
      ] });
    expect(bulk.statusCode).toBe(202);
  });

  it("production mock-provider 배포에서는 Popbill webhook endpoint를 닫는다", async () => {
    const app = await buildApp({
      env: { NODE_ENV: "production", APP_MODE: "production", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
        SESSION_SECRET: "a-secure-session-secret-that-is-long-enough", WEB_ORIGIN: "https://ofd.example",
        ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        STORAGE_MODE: "s3", S3_REGION: "ap-northeast-2", S3_BUCKET: "ofd", S3_KMS_KEY_ID: "kms-key",
        EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com" },
      repository: createDemoRepository(), storage: new MockObjectStorage(), logger: false,
    });
    openApps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", payload: { MID: "fake", CorpNum: "1234567890" } });
    expect(response.statusCode).toBe(404);
  });
});
