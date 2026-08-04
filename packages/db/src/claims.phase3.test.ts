import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "./memory-repository.ts";

test("정산별 결제요청은 하나만 원자적으로 생성된다", async () => {
  const repository = new MemoryRepository();
  const payment = (id: string) => ({ type: "payment_request" as const, id, storeId: "store-1", expectedVersion: null,
    value: { id, storeId: "store-1", settlementId: "settlement-1", amount: 10_000, dueDate: "2026-08-10",
      status: "pending", depositorHint: "대표", createdAt: "2026-08-01T00:00:00.000Z", version: 1 } });
  await repository.commit({ changes: [payment("payment-1")] });
  await assert.rejects(repository.commit({ changes: [payment("payment-2")] }), (error: any) =>
    error.code === "BUSINESS_KEY_CONFLICT" && error.details?.claimType === "payment.settlement");
});

test("원본 문서는 kind:aggregateId:sourceVersion 조합으로 중복 생성을 막는다", async () => {
  const repository = new MemoryRepository();
  const document = (id: string) => ({ type: "document" as const, id, storeId: "store-1", expectedVersion: null,
    value: { id, storeId: "store-1", kind: "tax_invoice", aggregateType: "tax_invoice", aggregateId: "invoice-1",
      sourceVersion: 3, objectKey: `documents/${id}.pdf`, objectVersionId: "v1", contentHashSha256: "a".repeat(64),
      mimeType: "application/pdf", fileName: "invoice.pdf", sizeBytes: 123, createdAt: "2026-08-01T00:00:00.000Z", version: 1 } });
  await repository.commit({ changes: [document("document-1")] });
  await assert.rejects(repository.commit({ changes: [document("document-2")] }), (error: any) =>
    error.code === "BUSINESS_KEY_CONFLICT" && error.details?.claimType === "document.source");
});

test("건별 정산은 같은 날 여러 건을 허용하고 월 정산만 기간을 유일하게 보장한다", async () => {
  const repository = new MemoryRepository();
  const settlement = (id: string, kind: "monthly" | "per_delivery", receiptId: string) => ({
    type: "settlement" as const, id, storeId: "store-1", expectedVersion: null,
    value: { id, storeId: "store-1", kind, periodStart: "2026-08-04", periodEnd: "2026-08-04",
      status: "draft", receiptIds: [receiptId], gross: 11_000, supply: 10_000, vat: 1_000, version: 1 },
  });
  await repository.commit({ changes: [settlement("delivery-1", "per_delivery", "receipt-1")] });
  await repository.commit({ changes: [settlement("delivery-2", "per_delivery", "receipt-2")] });
  await repository.commit({ changes: [settlement("monthly-1", "monthly", "receipt-3")] });
  await assert.rejects(repository.commit({ changes: [settlement("monthly-2", "monthly", "receipt-4")] }),
    (error: any) => error.code === "BUSINESS_KEY_CONFLICT" && error.details?.claimType === "settlement.period");
});
