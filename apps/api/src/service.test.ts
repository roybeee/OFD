import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import { popbillManagementKey, type Actor, type BankTransaction, type GoodsReceipt, type OriginalDocument,
  type PaymentRequest, type PurchaseOrder, type Settlement, type Shipment, type TaxInvoice } from "@ofd/domain";
import { MockObjectStorage } from "@ofd/integrations";
import { describe, expect, it } from "vitest";
import { ProcurementService } from "./service.ts";

describe("ProcurementService accounting", () => {
  it("최고관리자 bootstrap에 계정관리 capability를 제공한다", async () => {
    const repository = createDemoRepository();
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    const bootstrap = await service.bootstrap(master) as { capabilities: string[] };
    expect(bootstrap.capabilities).toContain("hq.accounts.manage");
  });

  it("월 합산 정산의 VAT를 영수증별 합이 아닌 문서 총액 100/110으로 다시 계산한다", async () => {
    const repository = createDemoRepository();
    const orders: PurchaseOrder[] = ["a", "b"].map((suffix) => ({
      id: `tiny-order-${suffix}`, number: `TINY-${suffix}`, storeId: DEMO_IDS.storeDoksan, status: "approved", source: "native",
      requestedDeliveryDate: "2026-06-01", note: "", lines: [], gross: 6, supply: 5, vat: 1,
      createdBy: DEMO_IDS.owner, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 1,
    }));
    const receipts: GoodsReceipt[] = orders.map((order, index) => ({
      id: `tiny-receipt-${index}`, shipmentId: `tiny-shipment-${index}`, orderId: order.id, storeId: order.storeId,
      status: "confirmed", confirmedAt: `2026-06-0${index + 1}T00:00:00.000Z`, confirmedBy: DEMO_IDS.driver,
      gross: 6, supply: 5, vat: 1,
    }));
    await repository.commit({ changes: [
      ...orders.map((value) => ({ type: "order" as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })),
      ...receipts.map((value) => ({ type: "receipt" as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })),
    ] });
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    const { settlement } = await service.draftSettlement(finance, {
      storeId: DEMO_IDS.storeDoksan, periodStart: "2026-06-01", periodEnd: "2026-06-30",
    });
    expect(settlement).toMatchObject({ gross: 12, supply: 11, vat: 1 });
  });

  it("마스터도 정산 초안을 작성할 수 있다 — 검토(재무)·승인(마스터, 검토자≠승인자) 분리는 유지", async () => {
    const repository = createDemoRepository();
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const owner = (await repository.get<Actor>("actor", DEMO_IDS.owner))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    /* 데모 시드의 확정 입고(2026-07-30)는 기존 정산에 묶여 있어 8월 기간으로는 초안 불가 → 새 입고를 만든다 */
    const receipt: GoodsReceipt = { id: "master-draft-receipt", shipmentId: "master-draft-shipment", orderId: "00000000-0000-4000-8000-000000003003",
      storeId: DEMO_IDS.storeDoksan, status: "confirmed", confirmedAt: "2026-08-05T02:00:00.000Z", confirmedBy: DEMO_IDS.driver,
      gross: 33_000, supply: 30_000, vat: 3_000 };
    await repository.commit({ changes: [{ type: "receipt", id: receipt.id, storeId: receipt.storeId, expectedVersion: null, value: receipt }] });
    const { settlement } = await service.draftSettlement(master, {
      storeId: DEMO_IDS.storeDoksan, periodStart: "2026-08-01", periodEnd: "2026-08-31", receiptIds: [receipt.id],
    });
    expect(settlement).toMatchObject({ status: "draft", gross: 33_000 });
    /* 점주는 여전히 불가 */
    await expect(service.draftSettlement(owner, { storeId: DEMO_IDS.storeDoksan, periodStart: "2026-08-01", periodEnd: "2026-08-31" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("creates a monthly-credit payment request atomically and blocks settlement review before payment", async () => {
    const repository = createDemoRepository();
    const order: PurchaseOrder = {
      id: "phase3-order", number: "PHASE3", storeId: DEMO_IDS.storeDoksan, status: "approved", source: "native",
      requestedDeliveryDate: "2026-08-03", note: "", lines: [], gross: 110_000, supply: 100_000, vat: 10_000,
      createdBy: DEMO_IDS.owner, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", version: 1,
    };
    const receipt: GoodsReceipt = { id: "phase3-receipt", shipmentId: "phase3-shipment", orderId: order.id, storeId: order.storeId,
      status: "confirmed", confirmedAt: "2026-08-03T02:00:00.000Z", confirmedBy: DEMO_IDS.driver,
      gross: order.gross, supply: order.supply, vat: order.vat };
    await repository.commit({ changes: [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order },
      { type: "receipt", id: receipt.id, storeId: receipt.storeId, expectedVersion: null, value: receipt },
    ] });
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test", "ofd-main", "mock", false,
      () => new Date("2026-08-04T00:00:00.000Z"), (date) => date === "2026-09-10");
    const created = await service.draftSettlement(finance, {
      storeId: DEMO_IDS.storeDoksan, periodStart: "2026-08-01", periodEnd: "2026-08-31", receiptIds: [receipt.id],
    });
    expect(created.paymentRequest).toMatchObject({ settlementId: created.settlement.id, amount: 110_000, dueDate: "2026-09-11", status: "pending" });
    await expect(service.reviewSettlement(finance, created.settlement.id, created.settlement.version))
      .rejects.toMatchObject({ code: "SETTLEMENT_PAYMENT_REQUIRED", statusCode: 409 });

    const bank: BankTransaction = { id: "phase3-bank", providerId: "phase3-bank-provider", accountId: "ofd-main",
      occurredAt: "2026-09-09T01:00:00.000Z", amount: 110_000, direction: "credit", memo: "박독산", matched: false, version: 1 };
    await repository.commit({ changes: [{ type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank }] });
    await service.manualMatchPayment(finance, created.paymentRequest!.id, bank.id, created.paymentRequest!.version);
    const reviewed = await service.reviewSettlement(finance, created.settlement.id, created.settlement.version);
    expect(reviewed.settlement).toMatchObject({ status: "reviewed", reviewedBy: finance.id, reviewedAt: expect.any(String) });
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const approved = await service.approveSettlement(master, reviewed.settlement.id, reviewed.settlement.version);
    expect(approved.settlement).toMatchObject({ status: "approved", approvedBy: master.id, approvedAt: expect.any(String) });
    await expect(service.createInvoiceDraft(finance, approved.settlement.id)).resolves.toMatchObject({ deadline: "2026-09-11" });
  });

  it("returns a reversed match to pending so it is immediately matchable", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    const matched = await service.manualMatchPayment(finance, "00000000-0000-4000-8000-000000006001",
      "00000000-0000-4000-8000-000000006101", 1);
    const reversed = await service.reversePaymentMatch(finance, matched.paymentRequest.id, matched.paymentRequest.version, "wrong depositor");
    expect(reversed.paymentRequest).toMatchObject({ status: "pending" });
    expect(reversed.paymentRequest.matchedBankTransactionId).toBeUndefined();
    expect(reversed.bankTransaction.matched).toBe(false);
  });

  it("creates a fresh business retry event for a failed invoice", async () => {
    const repository = createDemoRepository();
    const invoice = (await repository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
    const failed: TaxInvoice = { ...invoice, status: "failed", failureReason: "provider timeout", providerReceiptId: "provider-old",
      serialNumber: "123456789012345678901234", retryCount: 0, version: invoice.version + 1 };
    await repository.commit({ changes: [{ type: "tax_invoice", id: failed.id, storeId: failed.storeId, expectedVersion: invoice.version, value: failed }] });
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    const result = await service.retryInvoice(finance, failed.id, failed.version);
    expect(result.invoice).toMatchObject({ status: "queued", retryCount: 1, lastRetriedAt: expect.any(String) });
    expect(result.invoice.providerManagementKey).toBe(popbillManagementKey(failed.id, 1));
    expect(result.invoice.failureReason).toBeUndefined();
    expect(result.invoice.providerReceiptId).toBeUndefined();
    expect(result.invoice.serialNumber).toBeUndefined();
    const events = await repository.claimOutbox(10);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "invoice.retry.requested", aggregateId: failed.id })]));
  });

  it("선결제 승인 시 결제요청 원본 생성 이벤트를 함께 발행한다", async () => {
    const repository = createDemoRepository();
    const order: PurchaseOrder = { id: "prepaid-approved-order", number: "PREPAID-1", storeId: DEMO_IDS.storeHapjeong,
      status: "submitted", source: "native", requestedDeliveryDate: "2026-08-10", note: "", lines: [],
      gross: 11_000, supply: 10_000, vat: 1_000, createdBy: DEMO_IDS.owner, submittedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: 1 };
    await repository.commit({ changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order }] });
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const result = await new ProcurementService(repository, new MockObjectStorage(), "test").approveOrder(ops, order.id, 1);
    expect(result.paymentRequest).toMatchObject({ orderId: order.id, status: "pending" });
    const events = await repository.claimOutbox(10);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "order.approved", aggregateId: order.id }),
      expect.objectContaining({ topic: "payment.requested", aggregateId: result.paymentRequest!.id }),
    ]));
  });

  it("배송 또는 재무 확정 후에는 입금 대사 취소를 차단한다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    const prepaidOrder: PurchaseOrder = { id: "reversal-prepaid-order", number: "REV-PRE", storeId: DEMO_IDS.storeHapjeong,
      status: "approved", source: "native", requestedDeliveryDate: "2026-08-04", note: "", lines: [], gross: 11_000,
      supply: 10_000, vat: 1_000, createdBy: DEMO_IDS.owner, createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const shipment: Shipment = { id: "reversal-shipment", number: "REV-SHP", orderId: prepaidOrder.id,
      storeId: prepaidOrder.storeId, driverId: DEMO_IDS.driver, status: "out_for_delivery", plannedDate: "2026-08-04",
      lines: [], version: 2 };
    const prepaidBank: BankTransaction = { id: "reversal-prepaid-bank", providerId: "reversal-prepaid-provider",
      accountId: "ofd-main", occurredAt: "2026-08-03T00:00:00.000Z", amount: 11_000, direction: "credit", memo: "합정",
      matched: true, version: 1 };
    const prepaid: PaymentRequest = { id: "reversal-prepaid", storeId: prepaidOrder.storeId, orderId: prepaidOrder.id,
      amount: 11_000, dueDate: "2026-08-04", status: "paid", depositorHint: "이합정",
      matchedBankTransactionId: prepaidBank.id, createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const settlement: Settlement = { id: "reversal-settlement", storeId: DEMO_IDS.storeDoksan, kind: "monthly",
      periodStart: "2026-05-01", periodEnd: "2026-05-31", status: "reviewed", receiptIds: [], gross: 22_000,
      supply: 20_000, vat: 2_000, reviewedBy: finance.id, version: 1 };
    const monthlyBank: BankTransaction = { id: "reversal-monthly-bank", providerId: "reversal-monthly-provider",
      accountId: "ofd-main", occurredAt: "2026-08-03T00:00:00.000Z", amount: 22_000, direction: "credit", memo: "독산",
      matched: true, version: 1 };
    const monthly: PaymentRequest = { id: "reversal-monthly", storeId: settlement.storeId, settlementId: settlement.id,
      amount: 22_000, dueDate: "2026-08-10", status: "paid", depositorHint: "박독산",
      matchedBankTransactionId: monthlyBank.id, createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    await repository.commit({ changes: [
      { type: "order", id: prepaidOrder.id, storeId: prepaidOrder.storeId, expectedVersion: null, value: prepaidOrder },
      { type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: null, value: shipment },
      { type: "bank_transaction", id: prepaidBank.id, expectedVersion: null, value: prepaidBank },
      { type: "payment_request", id: prepaid.id, storeId: prepaid.storeId, expectedVersion: null, value: prepaid },
      { type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement },
      { type: "bank_transaction", id: monthlyBank.id, expectedVersion: null, value: monthlyBank },
      { type: "payment_request", id: monthly.id, storeId: monthly.storeId, expectedVersion: null, value: monthly },
    ] });
    await expect(service.reversePaymentMatch(finance, prepaid.id, 1, "배송 후 취소 시도"))
      .rejects.toMatchObject({ code: "PAYMENT_REVERSAL_BLOCKED", statusCode: 409 });
    await expect(service.reversePaymentMatch(finance, monthly.id, 1, "정산 후 취소 시도"))
      .rejects.toMatchObject({ code: "PAYMENT_REVERSAL_BLOCKED", statusCode: 409 });
  });

  it("월후불 결제가 미납으로 돌아가면 계산서 생성과 승인을 모두 방어적으로 차단한다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const settlement: Settlement = { id: "unpaid-invoice-settlement", storeId: DEMO_IDS.storeDoksan, kind: "monthly",
      periodStart: "2026-06-01", periodEnd: "2026-06-30", status: "approved", receiptIds: [], gross: 11_000,
      supply: 10_000, vat: 1_000, reviewedBy: finance.id, approvedBy: master.id, version: 1 };
    const payment: PaymentRequest = { id: "unpaid-invoice-payment", storeId: settlement.storeId, settlementId: settlement.id,
      amount: 11_000, dueDate: "2026-07-10", status: "pending", depositorHint: "박독산",
      createdAt: "2026-07-01T00:00:00.000Z", version: 1 };
    const template = (await repository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
    const invoice: TaxInvoice = { ...template, id: "unpaid-reviewed-invoice", settlementId: settlement.id,
      invoiceGroupId: "unpaid-reviewed-group", providerManagementKey: popbillManagementKey("unpaid-reviewed-invoice"),
      status: "reviewed", reviewedBy: finance.id, version: 1 };
    await repository.commit({ changes: [
      { type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement },
      { type: "payment_request", id: payment.id, storeId: payment.storeId, expectedVersion: null, value: payment },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await expect(service.createInvoiceDraft(finance, settlement.id))
      .rejects.toMatchObject({ code: "SETTLEMENT_PAYMENT_REQUIRED", statusCode: 409 });
    await repository.commit({ changes: [{ type: "tax_invoice", id: invoice.id, storeId: invoice.storeId, expectedVersion: null, value: invoice }] });
    await expect(service.approveInvoice(master, invoice.id, 1))
      .rejects.toMatchObject({ code: "SETTLEMENT_PAYMENT_REQUIRED", statusCode: 409 });
  });

  it("동시 자동대사는 동일 은행 거래를 한 번만 소비하고 두 호출 모두 일관된 결과로 끝난다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const request: PaymentRequest = { id: "concurrent-match-payment", storeId: DEMO_IDS.storeDoksan, amount: 99_001,
      dueDate: "2026-08-10", status: "pending", depositorHint: "동시대사", createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const bank: BankTransaction = { id: "concurrent-match-bank", providerId: "concurrent-match-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: request.amount, direction: "credit", memo: "동시대사",
      matched: false, version: 1 };
    await repository.commit({ changes: [
      { type: "payment_request", id: request.id, storeId: request.storeId, expectedVersion: null, value: request },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
    ] });
    const services = [1, 2].map(() => new ProcurementService(repository, new MockObjectStorage(), "test"));
    const results = await Promise.all(services.map((service) => service.autoMatchPayments(finance)));
    expect(results.flatMap((result) => result.paid).filter((payment) => payment.id === request.id)).toHaveLength(1);
    expect(await repository.get<PaymentRequest>("payment_request", request.id)).toMatchObject({ status: "paid",
      matchedBankTransactionId: bank.id, version: 2 });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: true, version: 2 });
  });

  it("결제요청 생성과 자동대사가 경쟁해도 하나의 직렬 실행 순서와 일치한다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const order: PurchaseOrder = { id: "creation-race-order", number: "CREATION-RACE", storeId: DEMO_IDS.storeHapjeong,
      status: "submitted", source: "native", requestedDeliveryDate: "2026-08-05", note: "", lines: [], gross: 77_001,
      supply: 70_001, vat: 7_000, createdBy: DEMO_IDS.owner, submittedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const existing: PaymentRequest = { id: "creation-race-existing", storeId: order.storeId, amount: order.gross,
      dueDate: order.requestedDeliveryDate, status: "pending", depositorHint: "이합정",
      createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const bank: BankTransaction = { id: "creation-race-bank", providerId: "creation-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: order.gross, direction: "credit", memo: "이합정",
      matched: false, version: 1 };
    await repository.commit({ changes: [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order },
      { type: "payment_request", id: existing.id, storeId: existing.storeId, expectedVersion: null, value: existing },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await Promise.all([service.approveOrder(ops, order.id, 1), service.autoMatchPayments(finance)]);
    const candidates = (await repository.list<PaymentRequest>("payment_request", [order.storeId]))
      .filter((payment) => payment.amount === order.gross);
    const matchedBank = (await repository.get<BankTransaction>("bank_transaction", bank.id))!;
    const statuses = candidates.map((payment) => payment.status).sort();
    expect(statuses).toEqual(matchedBank.matched
      ? ["paid", "pending"]
      : ["manual_review", "manual_review"]);
  });

  it("정규화한 입금자·매장 참조가 비어 있으면 자동대사하지 않는다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const request: PaymentRequest = { id: "blank-reference-payment", storeId: "missing-store", amount: 88_001,
      dueDate: "2026-08-10", status: "pending", depositorHint: " - ", createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const bank: BankTransaction = { id: "blank-reference-bank", providerId: "blank-reference-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: request.amount, direction: "credit", memo: "전혀다른입금자",
      matched: false, version: 1 };
    await repository.commit({ changes: [
      { type: "payment_request", id: request.id, storeId: request.storeId, expectedVersion: null, value: request },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
    ] });
    const result = await new ProcurementService(repository, new MockObjectStorage(), "test").autoMatchPayments(finance);
    expect(result.paid.map((payment) => payment.id)).not.toContain(request.id);
    expect(await repository.get<PaymentRequest>("payment_request", request.id)).toMatchObject({ status: "manual_review" });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: false });
  });

  it("수동대사와 자동대사가 경쟁해도 같은 계좌 잠금에서 최신 상태를 읽는다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const request: PaymentRequest = { id: "manual-auto-race-payment", storeId: DEMO_IDS.storeDoksan, amount: 88_002,
      dueDate: "2026-08-10", status: "pending", depositorHint: "수동자동경쟁", createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const bank: BankTransaction = { id: "manual-auto-race-bank", providerId: "manual-auto-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: request.amount, direction: "credit", memo: "수동자동경쟁",
      matched: false, version: 1 };
    await repository.commit({ changes: [
      { type: "payment_request", id: request.id, storeId: request.storeId, expectedVersion: null, value: request },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await expect(Promise.all([
      service.manualMatchPayment(finance, request.id, bank.id, 1),
      service.autoMatchPayments(finance),
    ])).resolves.toHaveLength(2);
    expect(await repository.get<PaymentRequest>("payment_request", request.id)).toMatchObject({ status: "paid",
      matchedBankTransactionId: bank.id, version: 2 });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: true, version: 2 });
  });

  it("대사취소와 자동대사가 경쟁하면 취소 결과를 재조회해 모호한 요청을 검토 상태로 둔다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const bank: BankTransaction = { id: "reverse-auto-race-bank", providerId: "reverse-auto-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: 88_003, direction: "credit", memo: "취소자동경쟁",
      matched: true, version: 1 };
    const paid: PaymentRequest = { id: "reverse-auto-race-paid", storeId: DEMO_IDS.storeDoksan, amount: bank.amount,
      dueDate: "2026-08-10", status: "paid", depositorHint: "취소자동경쟁", matchedBankTransactionId: bank.id,
      createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const pending: PaymentRequest = { id: "reverse-auto-race-pending", storeId: DEMO_IDS.storeDoksan, amount: bank.amount,
      dueDate: "2026-08-10", status: "pending", depositorHint: "취소자동경쟁",
      createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    await repository.commit({ changes: [
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
      { type: "payment_request", id: paid.id, storeId: paid.storeId, expectedVersion: null, value: paid },
      { type: "payment_request", id: pending.id, storeId: pending.storeId, expectedVersion: null, value: pending },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await expect(Promise.all([
      service.reversePaymentMatch(finance, paid.id, 1, "중복 입금 취소"),
      service.autoMatchPayments(finance),
    ])).resolves.toHaveLength(2);
    expect(await repository.get<PaymentRequest>("payment_request", paid.id)).toMatchObject({ status: "manual_review", version: 3 });
    expect(await repository.get<PaymentRequest>("payment_request", pending.id)).toMatchObject({ status: "manual_review", version: 2 });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: false, version: 2 });
  });

  it("선결제 주문 취소와 자동대사가 경쟁해도 취소된 요청은 매칭 그래프에서 제외한다", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const order: PurchaseOrder = { id: "cancel-auto-race-order", number: "CANCEL-AUTO", storeId: DEMO_IDS.storeHapjeong,
      status: "approved", source: "native", requestedDeliveryDate: "2026-08-05", note: "", lines: [], gross: 88_004,
      supply: 80_004, vat: 8_000, createdBy: DEMO_IDS.owner, createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const payment: PaymentRequest = { id: "cancel-auto-race-payment", storeId: order.storeId, orderId: order.id,
      amount: order.gross, dueDate: order.requestedDeliveryDate, status: "pending", depositorHint: "취소자동대사",
      createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const bank: BankTransaction = { id: "cancel-auto-race-bank", providerId: "cancel-auto-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-02T00:00:00.000Z", amount: order.gross, direction: "credit", memo: "취소자동대사",
      matched: false, version: 1 };
    await repository.commit({ changes: [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order },
      { type: "payment_request", id: payment.id, storeId: payment.storeId, expectedVersion: null, value: payment },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await expect(Promise.all([
      service.cancelOrder(ops, order.id, 1, "운영 취소 처리"),
      service.autoMatchPayments(finance),
    ])).resolves.toHaveLength(2);
    expect(await repository.get<PurchaseOrder>("order", order.id)).toMatchObject({ status: "cancelled", version: 2 });
    expect(await repository.get<PaymentRequest>("payment_request", payment.id)).toMatchObject({ status: "cancelled", version: 2 });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: false, version: 1 });
  });

  it("serializes prepaid dispatch with payment reversal", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const order: PurchaseOrder = {
      id: "dispatch-reversal-race-order", number: "DISPATCH-REVERSAL", storeId: DEMO_IDS.storeHapjeong,
      status: "approved", source: "native", requestedDeliveryDate: "2026-08-04", note: "", lines: [],
      gross: 44_000, supply: 40_000, vat: 4_000, createdBy: DEMO_IDS.owner,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: 1,
    };
    const shipment: Shipment = {
      id: "dispatch-reversal-race-shipment", number: "SHP-DISPATCH-REVERSAL", orderId: order.id,
      storeId: order.storeId, driverId: DEMO_IDS.driver, status: "preparing", plannedDate: "2026-08-04",
      lines: [], version: 1,
    };
    const bank: BankTransaction = {
      id: "dispatch-reversal-race-bank", providerId: "dispatch-reversal-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-03T00:00:00.000Z", amount: order.gross, direction: "credit", memo: "dispatch race",
      matched: true, version: 1,
    };
    const payment: PaymentRequest = {
      id: "dispatch-reversal-race-payment", storeId: order.storeId, orderId: order.id, amount: order.gross,
      dueDate: "2026-08-04", status: "paid", depositorHint: "dispatch race",
      matchedBankTransactionId: bank.id, createdAt: "2026-08-01T00:00:00.000Z", version: 1,
    };
    await repository.commit({ changes: [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order },
      { type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: null, value: shipment },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
      { type: "payment_request", id: payment.id, storeId: payment.storeId, expectedVersion: null, value: payment },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test", "ofd-main", "mock", false,
      () => new Date("2026-08-03T15:30:00.000Z"));

    const results = await Promise.allSettled([
      service.dispatchShipment(ops, shipment.id, shipment.version),
      service.reversePaymentMatch(finance, payment.id, payment.version, "concurrent reversal"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const finalShipment = (await repository.get<Shipment>("shipment", shipment.id))!;
    const finalPayment = (await repository.get<PaymentRequest>("payment_request", payment.id))!;
    expect(finalShipment.status === "out_for_delivery" && finalPayment.status === "pending").toBe(false);
    expect((finalShipment.status === "out_for_delivery" && finalPayment.status === "paid")
      || (finalShipment.status === "preparing" && finalPayment.status === "pending")).toBe(true);
  });

  it("serializes settlement review with payment reversal", async () => {
    const repository = createDemoRepository();
    const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    const settlement: Settlement = {
      id: "review-reversal-race-settlement", storeId: DEMO_IDS.storeDoksan, kind: "monthly",
      periodStart: "2099-01-01", periodEnd: "2099-01-31", status: "draft", receiptIds: [],
      gross: 55_000, supply: 50_000, vat: 5_000, version: 1,
    };
    const bank: BankTransaction = {
      id: "review-reversal-race-bank", providerId: "review-reversal-race-provider", accountId: "ofd-main",
      occurredAt: "2026-08-03T00:00:00.000Z", amount: settlement.gross, direction: "credit", memo: "review race",
      matched: true, version: 1,
    };
    const payment: PaymentRequest = {
      id: "review-reversal-race-payment", storeId: settlement.storeId, settlementId: settlement.id,
      amount: settlement.gross, dueDate: "2026-08-10", status: "paid", depositorHint: "review race",
      matchedBankTransactionId: bank.id, createdAt: "2026-08-01T00:00:00.000Z", version: 1,
    };
    await repository.commit({ changes: [
      { type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement },
      { type: "bank_transaction", id: bank.id, expectedVersion: null, value: bank },
      { type: "payment_request", id: payment.id, storeId: payment.storeId, expectedVersion: null, value: payment },
    ] });
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");

    const results = await Promise.allSettled([
      service.reviewSettlement(finance, settlement.id, settlement.version),
      service.reversePaymentMatch(finance, payment.id, payment.version, "concurrent reversal"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const finalSettlement = (await repository.get<Settlement>("settlement", settlement.id))!;
    const finalPayment = (await repository.get<PaymentRequest>("payment_request", payment.id))!;
    expect(finalSettlement.status === "reviewed" && finalPayment.status === "pending").toBe(false);
    expect((finalSettlement.status === "reviewed" && finalPayment.status === "paid")
      || (finalSettlement.status === "draft" && finalPayment.status === "pending")).toBe(true);
  });

  it("hides storage keys and enforces store scope for document downloads", async () => {
    const repository = createDemoRepository();
    const document: OriginalDocument = { id: "phase3-document", storeId: DEMO_IDS.storeHapjeong, kind: "tax_invoice",
      aggregateType: "tax_invoice", aggregateId: "invoice-hapjeong", sourceVersion: 1, objectKey: "private/tax.pdf",
      objectVersionId: "version-1", contentHashSha256: "a".repeat(64), mimeType: "application/pdf", fileName: "tax.pdf",
      sizeBytes: 321, createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    await repository.commit({ changes: [{ type: "document", id: document.id, storeId: document.storeId, expectedVersion: null, value: document }] });
    const owner = (await repository.get<Actor>("actor", DEMO_IDS.owner))!;
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test");
    await expect(service.downloadDocument(owner, document.id)).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED", statusCode: 403 });
    const result = await service.downloadDocument(master, document.id);
    expect(result).toMatchObject({ document: { id: document.id, fileName: "tax.pdf" }, expiresInSeconds: 900,
      downloadUrl: expect.stringContaining("versionId=version-1") });
    expect(JSON.stringify(result)).not.toContain(document.objectKey);
  });
});

describe("ProcurementService driver route security", () => {
  const operationalNow = () => new Date("2026-08-03T15:30:00.000Z"); // 2026-08-04 KST

  function routeOrder(id: string): PurchaseOrder {
    return {
      id, number: `PO-${id}`, storeId: DEMO_IDS.storeDoksan, status: "approved", source: "native",
      requestedDeliveryDate: "2026-08-04", note: "후문 전달", gross: 28_600, supply: 26_000, vat: 2_600,
      lines: [{ id: `${id}-line`, snapshot: { productId: DEMO_IDS.productBean, sku: "BEAN-1K", name: "원두", unit: "봉",
        unitGross: 28_600, taxable: true, taxRate: 10 }, quantity: 2, gross: 57_200, supply: 52_000, vat: 5_200 }],
      createdBy: DEMO_IDS.owner, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", version: 1,
    };
  }

  it("returns only today's price-free operational projection to the assigned driver", async () => {
    const repository = createDemoRepository();
    const todayOrder = routeOrder("driver-today-order");
    const tomorrowOrder = routeOrder("driver-tomorrow-order");
    const todayShipment: Shipment = {
      id: "driver-today-shipment", number: "SHP-TODAY", orderId: todayOrder.id, storeId: todayOrder.storeId,
      driverId: DEMO_IDS.driver, status: "delivered", plannedDate: "2026-08-04", routeSequence: 2,
      deliveryWindow: { start: "10:00", end: "11:30" }, lines: [{ orderLineId: todayOrder.lines[0]!.id, quantity: 2 }],
      deliveredAt: "2026-08-04T02:00:00.000Z", proof: { id: "proof-1", shipmentId: "driver-today-shipment",
        photoObjectKey: "private/proof.jpg", objectVersionId: "v1", etag: "etag", checksumSha256: "checksum",
        recipientName: "점주", note: "", capturedAt: "2026-08-04T02:00:00.000Z", uploadedBy: DEMO_IDS.driver }, version: 3,
    };
    const tomorrowShipment: Shipment = {
      id: "driver-tomorrow-shipment", number: "SHP-TOMORROW", orderId: tomorrowOrder.id, storeId: tomorrowOrder.storeId,
      driverId: DEMO_IDS.driver, status: "preparing", plannedDate: "2026-08-05", routeSequence: 1,
      deliveryWindow: { start: "09:00", end: "10:00" }, lines: [{ orderLineId: tomorrowOrder.lines[0]!.id, quantity: 2 }], version: 1,
    };
    await repository.commit({ changes: [
      ...[todayOrder, tomorrowOrder].map((value) => ({ type: "order" as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })),
      ...[todayShipment, tomorrowShipment].map((value) => ({ type: "shipment" as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })),
    ] });
    const driver = (await repository.get<Actor>("actor", DEMO_IDS.driver))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "production", "ofd-main", "mock", false, operationalNow);
    const bootstrap = await service.bootstrap(driver) as any;

    expect(bootstrap.orders).toEqual([]);
    expect(bootstrap.stores).toEqual([]);
    expect(bootstrap.shipments).toHaveLength(1);
    expect(bootstrap.shipments[0]).toEqual({
      id: todayShipment.id, status: "delivered", plannedDate: "2026-08-04", routeSequence: 2,
      deliveryWindow: { start: "10:00", end: "11:30" }, version: 3,
      destination: expect.objectContaining({ name: expect.any(String), address: expect.any(String), phone: expect.any(String) }),
      items: [{ name: "원두", unit: "봉", quantity: 2 }], deliveryNote: "후문 전달",
      proof: { recipientName: "점주", capturedAt: "2026-08-04T02:00:00.000Z" },
    });
    const serialized = JSON.stringify(bootstrap);
    for (const forbidden of ["businessNumber", "billingCycle", "paymentMethod", "unitGross", "gross", "supply", "vat", "photoObjectKey"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }

    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const hqBootstrap = await service.bootstrap(ops) as any;
    expect(hqBootstrap.routeDates[0]).toBe("2026-08-04");
    expect(hqBootstrap.routeDates).toEqual(expect.arrayContaining(["2026-08-04", "2026-08-05"]));
  });

  it("requires the shipment date to match the approved order requested delivery date", async () => {
    const repository = createDemoRepository();
    const order = routeOrder("shipment-date-order");
    await repository.commit({ changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order }] });
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test", "ofd-main", "mock", false, operationalNow);

    await expect(service.createShipment(ops, order.id, DEMO_IDS.driver, "2026-08-05", 1, { start: "09:00", end: "10:00" }))
      .rejects.toMatchObject({ code: "SHIPMENT_DATE_MISMATCH", statusCode: 409 });
  });

  it("rejects inactive drivers and rejects proof/delivery outside the KST operational date", async () => {
    const repository = createDemoRepository();
    const driver = (await repository.get<Actor>("actor", DEMO_IDS.driver))!;
    await repository.commit({ changes: [{ type: "actor", id: driver.id, expectedVersion: driver.authVersion,
      value: { ...driver, active: false, authVersion: driver.authVersion + 1 } }] });
    const order = routeOrder("inactive-driver-order");
    await repository.commit({ changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order }] });
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const service = new ProcurementService(repository, new MockObjectStorage(), "test", "ofd-main", "mock", false, operationalNow);
    await expect(service.createShipment(ops, order.id, driver.id, "2026-08-04", 1, { start: "09:00", end: "10:00" }))
      .rejects.toMatchObject({ code: "DRIVER_INACTIVE" });

    const activeDriver = { ...driver, active: true };
    const legacyService = new ProcurementService(createDemoRepository(), new MockObjectStorage(), "test", "ofd-main", "mock", false, operationalNow);
    await expect(legacyService.createDeliveryUpload(activeDriver, "00000000-0000-4000-8000-000000004001", "image/jpeg"))
      .rejects.toMatchObject({ code: "NOT_OPERATIONAL_DATE" });
    await expect(legacyService.completeDelivery(activeDriver, "00000000-0000-4000-8000-000000004001", {
      expectedVersion: 2, photoKey: "unused", recipientName: "점주",
    })).rejects.toMatchObject({ code: "NOT_OPERATIONAL_DATE" });
  });

  it("fails closed for normal and modified invoice approval/retry when production external issuance is not ready", async () => {
    const configurations = [
      { providerMode: "mock" as const, externalIssueEnabled: true },
      { providerMode: "production" as const, externalIssueEnabled: false },
    ];
    for (const issueType of ["normal", "modified"] as const) {
      for (const operation of ["approve", "retry"] as const) {
        for (const configuration of configurations) {
          const repository = createDemoRepository();
          const current = (await repository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
          const status = operation === "approve" ? "reviewed" as const : "failed" as const;
          const guarded: TaxInvoice = {
            ...current,
            issueType,
            status,
            ...(issueType === "modified" ? {
              originalInvoiceId: "external-original-invoice",
              originalNtsConfirmNumber: "123456789012345678901234",
              modificationReasonCode: "01" as const,
            } : {}),
            ...(status === "failed" ? { failureReason: "provider unavailable" } : {}),
            version: current.version + 1,
          };
          await repository.commit({ changes: [{
            type: "tax_invoice", id: guarded.id, storeId: guarded.storeId, expectedVersion: current.version, value: guarded,
          }] });
          const service = new ProcurementService(repository, new MockObjectStorage(), "production", "ofd-main",
            configuration.providerMode, configuration.externalIssueEnabled);
          const actor = (await repository.get<Actor>("actor", operation === "approve" ? DEMO_IDS.master : DEMO_IDS.finance))!;
          const action = operation === "approve"
            ? service.approveInvoice(actor, guarded.id, guarded.version)
            : service.retryInvoice(actor, guarded.id, guarded.version);

          await expect(action).rejects.toMatchObject({ code: "EXTERNAL_INVOICE_ISSUANCE_DISABLED", statusCode: 503 });
          expect(await repository.get<TaxInvoice>("tax_invoice", guarded.id)).toMatchObject({ status, version: guarded.version });
        }
      }
    }
  });

  it("allows internal statements in production without an external provider", async () => {
    const approvedRepository = createDemoRepository();
    const reviewed = (await approvedRepository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
    const internalReviewed: TaxInvoice = { ...reviewed, issueType: "internal_statement", status: "reviewed", version: reviewed.version + 1 };
    await approvedRepository.commit({ changes: [{
      type: "tax_invoice", id: internalReviewed.id, storeId: internalReviewed.storeId,
      expectedVersion: reviewed.version, value: internalReviewed,
    }] });
    const master = (await approvedRepository.get<Actor>("actor", DEMO_IDS.master))!;
    const approved = await new ProcurementService(approvedRepository, new MockObjectStorage(), "production", "ofd-main", "mock", false)
      .approveInvoice(master, internalReviewed.id, internalReviewed.version);
    expect(approved.invoice.status).toBe("approved");
    expect(await approvedRepository.claimOutbox(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "statement.generate", aggregateId: internalReviewed.id }),
    ]));

    const retryRepository = createDemoRepository();
    const retryBase = (await retryRepository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
    const failedInternal: TaxInvoice = {
      ...retryBase, issueType: "internal_statement", status: "failed", failureReason: "render failed", version: retryBase.version + 1,
    };
    await retryRepository.commit({ changes: [{
      type: "tax_invoice", id: failedInternal.id, storeId: failedInternal.storeId,
      expectedVersion: retryBase.version, value: failedInternal,
    }] });
    const finance = (await retryRepository.get<Actor>("actor", DEMO_IDS.finance))!;
    const retried = await new ProcurementService(retryRepository, new MockObjectStorage(), "production", "ofd-main", "mock", false)
      .retryInvoice(finance, failedInternal.id, failedInternal.version);
    expect(retried.invoice).toMatchObject({ status: "queued", retryCount: 1 });
  });
});
