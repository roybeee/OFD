import { createDemoRepository, DEMO_IDS, MemoryRepository } from "@ofd/db";
import {
  DomainError,
  type
  BankTransaction,
  GoodsReceipt,
  OriginalDocument,
  OutboxEvent,
  PaymentRequest,
  PurchaseOrder,
  Settlement,
  Store,
  TaxInvoice,
} from "@ofd/domain";
import { MockEmailProvider, MockObjectStorage, MockPopbillProvider, readProviderConfig, type PopbillProvider } from "@ofd/integrations";
import { describe, expect, it } from "vitest";
import { OfdWorker } from "./worker.ts";

function event(id: string, topic: string, aggregateId: string, payload: unknown): OutboxEvent {
  return {
    id,
    topic,
    aggregateId,
    payload,
    status: "pending",
    attempts: 0,
    availableAt: "2026-08-02T00:00:00.000Z",
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

const testConfig = readProviderConfig({ APP_MODE: "test", PROVIDER_MODE: "mock", RECONCILIATION_ACCOUNT_ID: "ofd-main" });
const productionMockConfig = {
  ...testConfig,
  appMode: "production" as const,
  providerMode: "mock" as const,
  taxInvoiceEnabled: true,
  bankSyncEnabled: true,
  smsEnabled: true,
};

const store: Store = {
  id: "store-worker-1",
  code: "WORKER-1",
  name: "자동매칭점",
  business: {
    businessNumber: "2012345678",
    legalName: "자동매칭점",
    representativeName: "홍길동",
    address: "서울",
    businessType: "도소매",
    businessCategory: "식자재",
    email: "store@example.com",
  },
  billingCycle: "monthly",
  paymentMethod: "monthly_credit",
  notificationPhone: "01012345678",
  active: true,
  version: 1,
};

function provider(overrides: Partial<PopbillProvider> = {}): PopbillProvider {
  const mock = new MockPopbillProvider();
  return {
    issueTaxInvoice: overrides.issueTaxInvoice ?? ((invoice) => mock.issueTaxInvoice(invoice)),
    getTaxInvoiceStatus: overrides.getTaxInvoiceStatus ?? ((invoice) => mock.getTaxInvoiceStatus(invoice)),
    getTaxInvoiceOriginal: overrides.getTaxInvoiceOriginal ?? ((invoice) => mock.getTaxInvoiceOriginal(invoice)),
    fetchBankTransactions: overrides.fetchBankTransactions ?? (async () => []),
    sendSms: overrides.sendSms ?? (async () => ({ receiptId: "mock-sms" })),
  };
}

function approvedSettlement(id = "settlement-worker-1"): Settlement {
  return {
    id,
    storeId: store.id,
    kind: "monthly",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    status: "approved",
    receiptIds: [],
    gross: 22_000,
    supply: 20_000,
    vat: 2_000,
    reviewedBy: "finance",
    reviewedAt: "2026-08-01T00:00:00.000Z",
    approvedBy: "master",
    approvedAt: "2026-08-01T01:00:00.000Z",
    version: 3,
  };
}

function approvedInvoice(partNumber: number, partCount: number, settlementId = "settlement-worker-1"): TaxInvoice {
  return {
    id: `invoice-worker-${partNumber}`,
    storeId: store.id,
    settlementId,
    invoiceGroupId: "invoice-group-worker-1",
    partNumber,
    partCount,
    providerManagementKey: `OFDWORKER${String(partNumber).padStart(14, "0")}`,
    issueType: "normal",
    status: "approved",
    issueDate: "2026-07-31",
    dueDate: "2026-08-10",
    supplier: { ...store.business, businessNumber: "1234567890", legalName: "OFD 본사" },
    recipient: store.business,
    gross: 11_000,
    supply: 10_000,
    vat: 1_000,
    preparedBy: "finance",
    reviewedBy: "finance",
    approvedBy: "master",
    lines: [{ id: `line-${partNumber}`, description: "식자재", quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000 }],
    version: 3,
  };
}

describe("OFD worker production pipeline", () => {
  it("imports a bank transaction and atomically auto-matches the only eligible payment as system automation", async () => {
    const payment: PaymentRequest = {
      id: "payment-worker-1",
      storeId: store.id,
      amount: 55_000,
      dueDate: "2026-08-10",
      status: "pending",
      depositorHint: "홍길동",
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "payment_request", id: payment.id, storeId: store.id, expectedVersion: null, value: payment },
    ]);
    const bank: BankTransaction = {
      id: "bank-worker-1",
      providerId: "provider-bank-worker-1",
      accountId: "ofd-main",
      occurredAt: "2026-08-02T01:00:00.000Z",
      amount: 55_000,
      direction: "credit",
      memo: "홍길동 자동매칭점",
      matched: false,
      version: 1,
    };
    await repository.commit({ changes: [], outbox: [event("bank-sync-worker-1", "bank.sync.requested", "2026-08-02", { from: "2026-08-02", to: "2026-08-02" })] });
    const worker = new OfdWorker(repository, provider({ fetchBankTransactions: async () => [bank] }), new MockEmailProvider(), testConfig);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.get<PaymentRequest>("payment_request", payment.id)).toMatchObject({ status: "paid", matchedBankTransactionId: bank.id, version: 2 });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: true, version: 2 });
    expect(await repository.listAudit()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "payment.auto_matched_by_system", actorRole: "system", actorId: DEMO_IDS.system }),
    ]));
  });

  it("recomputes the complete stored and imported match graph inside the shared account lock", async () => {
    const payment: PaymentRequest = {
      id: "payment-ambiguous-graph",
      storeId: store.id,
      amount: 77_000,
      dueDate: "2026-08-10",
      status: "pending",
      depositorHint: "workerowner",
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const existingBank: BankTransaction = {
      id: "bank-existing-graph",
      providerId: "provider-existing-graph",
      accountId: "ofd-main",
      occurredAt: "2026-08-02T01:00:00.000Z",
      amount: 77_000,
      direction: "credit",
      memo: "workerowner",
      matched: false,
      version: 1,
    };
    const importedBank: BankTransaction = {
      ...existingBank,
      id: "bank-imported-graph",
      providerId: "provider-imported-graph",
      occurredAt: "2026-08-02T02:00:00.000Z",
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "payment_request", id: payment.id, storeId: store.id, expectedVersion: null, value: payment },
      { type: "bank_transaction", id: existingBank.id, expectedVersion: null, value: existingBank },
    ]);
    const lockKeys: string[] = [];
    const originalExclusive = repository.exclusiveTransaction.bind(repository);
    repository.exclusiveTransaction = async (key, run) => {
      lockKeys.push(key);
      return originalExclusive(key, run);
    };
    await repository.commit({ changes: [], outbox: [event("bank-sync-ambiguous", "bank.sync.requested", "2026-08-02", {
      from: "2026-08-02",
      to: "2026-08-02",
    })] });
    const worker = new OfdWorker(repository, provider({ fetchBankTransactions: async () => [importedBank] }), new MockEmailProvider(), testConfig);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(lockKeys).toContain("payment-auto-match:ofd-main");
    expect(await repository.get<PaymentRequest>("payment_request", payment.id)).toMatchObject({ status: "manual_review", version: 2 });
    expect((await repository.list<BankTransaction>("bank_transaction")).every((transaction) => !transaction.matched)).toBe(true);
  });

  it("never treats an empty normalized depositor or store reference as a match", async () => {
    const punctuationStore: Store = {
      ...store,
      id: "store-empty-reference",
      name: "---",
      business: { ...store.business, representativeName: "---" },
    };
    const payment: PaymentRequest = {
      id: "payment-empty-reference",
      storeId: punctuationStore.id,
      amount: 88_000,
      dueDate: "2026-08-10",
      status: "pending",
      depositorHint: "---",
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const bank: BankTransaction = {
      id: "bank-empty-reference",
      providerId: "provider-empty-reference",
      accountId: "ofd-main",
      occurredAt: "2026-08-02T01:00:00.000Z",
      amount: 88_000,
      direction: "credit",
      memo: "unrelated transfer",
      matched: false,
      version: 1,
    };
    const repository = new MemoryRepository([
      { type: "store", id: punctuationStore.id, storeId: punctuationStore.id, expectedVersion: null, value: punctuationStore },
      { type: "payment_request", id: payment.id, storeId: punctuationStore.id, expectedVersion: null, value: payment },
    ]);
    await repository.commit({ changes: [], outbox: [event("bank-sync-empty-reference", "bank.sync.requested", "2026-08-02", {
      from: "2026-08-02",
      to: "2026-08-02",
    })] });
    const worker = new OfdWorker(repository, provider({ fetchBankTransactions: async () => [bank] }), new MockEmailProvider(), testConfig);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.get<PaymentRequest>("payment_request", payment.id)).toMatchObject({ status: "manual_review" });
    expect(await repository.get<BankTransaction>("bank_transaction", bank.id)).toMatchObject({ matched: false });
  });

  it("stores versioned immutable originals and their readable integrity metadata", async () => {
    const repository = createDemoRepository();
    const storage = new MockObjectStorage();
    const deliveredShipmentId = "00000000-0000-4000-8000-000000004002";
    const receiptId = "00000000-0000-4000-8000-000000005001";
    const settlementId = "00000000-0000-4000-8000-000000007001";
    const paymentId = "00000000-0000-4000-8000-000000006001";
    await repository.commit({ changes: [], outbox: [
      event("doc-delivery-1", "shipment.delivered", deliveredShipmentId, { shipmentId: deliveredShipmentId, receiptId, storeId: DEMO_IDS.storeDoksan }),
      event("doc-settlement-1", "settlement.drafted", settlementId, { settlementId, storeId: DEMO_IDS.storeDoksan }),
      event("doc-payment-1", "payment.requested", paymentId, { paymentRequestId: paymentId, storeId: DEMO_IDS.storeDoksan }),
    ] });
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig, storage);

    expect(await worker.processOnce(10)).toMatchObject({ claimed: 3, completed: 3, failed: 0 });
    const documents = await repository.list<OriginalDocument>("document");
    expect(documents.map((document) => document.kind)).toEqual(expect.arrayContaining(["delivery_statement", "monthly_statement", "payment_request"]));
    const delivery = documents.find((document) => document.kind === "delivery_statement")!;
    const object = await storage.getImmutableObject(delivery.objectKey, delivery.objectVersionId);
    expect(object.contentHashSha256).toBe(delivery.contentHashSha256);
    expect(object.sizeBytes).toBe(delivery.sizeBytes);
    expect(new TextDecoder().decode(object.bytes).startsWith("%PDF-1.4")).toBe(true);
  });

  it("does not lock a multipart settlement on partial success and locks only after the failed part recovers", async () => {
    const settlement = approvedSettlement();
    const first = approvedInvoice(1, 2);
    const second = approvedInvoice(2, 2);
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: first.id, storeId: store.id, expectedVersion: null, value: first },
      { type: "tax_invoice", id: second.id, storeId: store.id, expectedVersion: null, value: second },
    ]);
    let secondAttempts = 0;
    const invoiceProvider = provider({
      issueTaxInvoice: async (invoice) => {
        if (invoice.partNumber === 2 && secondAttempts++ === 0) throw new Error("temporary provider failure");
        return { receiptId: `receipt-${invoice.partNumber}`, serialNumber: `20260802000000000000000${invoice.partNumber}`, issuedAt: new Date().toISOString(), ntsStatus: "success" };
      },
      getTaxInvoiceOriginal: async (invoice) => ({
        bytes: new TextEncoder().encode(`%PDF-1.4\ninvoice ${invoice.partNumber}\n%%EOF\n`),
        mimeType: "application/pdf",
        fileName: `${invoice.providerManagementKey}.pdf`,
      }),
    });
    await repository.commit({ changes: [], outbox: [
      event("issue-part-1", "invoice.issue.requested", first.id, { invoiceId: first.id }),
      event("issue-part-2", "invoice.issue.requested", second.id, { invoiceId: second.id }),
    ] });
    const storage = new MockObjectStorage();
    const worker = new OfdWorker(repository, invoiceProvider, new MockEmailProvider(), testConfig, storage);

    expect(await worker.processOnce(10)).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
    expect(await repository.get<Settlement>("settlement", settlement.id)).toMatchObject({ status: "approved", version: 3 });
    expect(await repository.get<TaxInvoice>("tax_invoice", first.id)).toMatchObject({ status: "nts_success" });
    expect(await repository.get<TaxInvoice>("tax_invoice", second.id)).toMatchObject({ status: "failed" });

    await repository.commit({ changes: [], outbox: [event("retry-part-2", "invoice.retry.requested", second.id, { invoiceId: second.id })] });
    expect(await worker.processOnce(10)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.get<TaxInvoice>("tax_invoice", second.id)).toMatchObject({ status: "nts_success", retryCount: 1 });
    expect(await repository.get<Settlement>("settlement", settlement.id)).toMatchObject({ status: "locked", version: 4 });
    const lockedOriginal = (await repository.list<OriginalDocument>("document")).find((document) =>
      document.kind === "monthly_statement" && document.aggregateId === settlement.id && document.sourceVersion === 4);
    expect(lockedOriginal).toBeDefined();
    expect((await storage.getImmutableObject(lockedOriginal!.objectKey, lockedOriginal!.objectVersionId)).sizeBytes).toBeGreaterThan(0);
  });

  it("rejects an inconsistent multipart invoice group instead of locking its settlement", async () => {
    const settlement = approvedSettlement("settlement-inconsistent-1");
    const first: TaxInvoice = { ...approvedInvoice(1, 2, settlement.id), status: "nts_success", version: 7 };
    const second: TaxInvoice = { ...approvedInvoice(2, 3, settlement.id), status: "nts_success", version: 7 };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: first.id, storeId: store.id, expectedVersion: null, value: first },
      { type: "tax_invoice", id: second.id, storeId: store.id, expectedVersion: null, value: second },
    ]);
    await repository.commit({ changes: [], outbox: [
      event("inconsistent-part-1", "invoice.issue.requested", first.id, { invoiceId: first.id }),
      event("inconsistent-part-2", "invoice.issue.requested", second.id, { invoiceId: second.id }),
    ] });
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig);

    expect(await worker.processOnce(10)).toMatchObject({ claimed: 2, completed: 0, failed: 2 });
    expect(await repository.get<Settlement>("settlement", settlement.id)).toMatchObject({ status: "approved", version: 3 });
  });

  it("keeps an unknown Popbill outcome queued and retries with the same management key", async () => {
    const settlement = approvedSettlement("settlement-outcome-unknown");
    const invoice: TaxInvoice = {
      ...approvedInvoice(1, 1, settlement.id),
      id: "invoice-outcome-unknown",
      invoiceGroupId: "invoice-group-outcome-unknown",
      providerManagementKey: "OFDOUTCOMEUNKNOWN000001",
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: invoice.id, storeId: store.id, expectedVersion: null, value: invoice },
    ]);
    const seenKeys: string[] = [];
    let attempts = 0;
    const invoiceProvider = provider({
      issueTaxInvoice: async (current) => {
        seenKeys.push(current.providerManagementKey);
        attempts += 1;
        if (attempts === 1) {
          throw new DomainError("POPBILL_OUTCOME_UNKNOWN", "provider outcome is not visible yet", 503);
        }
        return {
          receiptId: "receipt-outcome-unknown",
          serialNumber: "202608020000000000000001",
          issuedAt: new Date().toISOString(),
          ntsStatus: "success",
        };
      },
    });
    await repository.commit({ changes: [], outbox: [event("issue-outcome-unknown", "invoice.issue.requested", invoice.id, {
      invoiceId: invoice.id,
    })] });
    const worker = new OfdWorker(repository, invoiceProvider, new MockEmailProvider(), testConfig);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(await repository.get<TaxInvoice>("tax_invoice", invoice.id)).toMatchObject({
      status: "queued",
      providerManagementKey: invoice.providerManagementKey,
      version: 4,
    });

    await repository.commit({ changes: [], outbox: [event("retry-outcome-unknown", "invoice.issue.requested", invoice.id, {
      invoiceId: invoice.id,
    })] });
    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.get<TaxInvoice>("tax_invoice", invoice.id)).toMatchObject({
      status: "nts_success",
      providerManagementKey: invoice.providerManagementKey,
    });
    expect(seenKeys).toEqual([invoice.providerManagementKey, invoice.providerManagementKey]);
  });

  it("bounds a hanging Popbill issue call and preserves the same queued management key", async () => {
    const settlement = approvedSettlement("settlement-provider-timeout");
    const invoice: TaxInvoice = {
      ...approvedInvoice(1, 1, settlement.id),
      id: "invoice-provider-timeout",
      invoiceGroupId: "invoice-group-provider-timeout",
      providerManagementKey: "OFDPROVIDERTIMEOUT00001",
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: invoice.id, storeId: store.id, expectedVersion: null, value: invoice },
    ]);
    await repository.commit({ changes: [], outbox: [event("issue-provider-timeout", "invoice.issue.requested", invoice.id, {
      invoiceId: invoice.id,
    })] });
    const hangingProvider = provider({ issueTaxInvoice: () => new Promise(() => undefined) });
    const worker = new OfdWorker(repository, hangingProvider, new MockEmailProvider(), testConfig, new MockObjectStorage(),
      () => false, "timeout-worker", 3, 1_000, 5);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 0, failed: 1, fenced: 0 });
    expect(await repository.get<TaxInvoice>("tax_invoice", invoice.id)).toMatchObject({
      status: "queued",
      providerManagementKey: invoice.providerManagementKey,
    });
  });

  it("persists the worker heartbeat lease", async () => {
    const repository = new MemoryRepository();
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig, new MockObjectStorage(),
      () => false, "heartbeat-worker", 3, 1_000, 100, 60_000);
    await worker.heartbeat("running", new Date("2026-08-04T00:00:00.000Z"));
    expect(await repository.getWorkerHeartbeat("heartbeat-worker")).toEqual({
      workerId: "heartbeat-worker",
      state: "running",
      observedAt: "2026-08-04T00:00:00.000Z",
      leaseExpiresAt: "2026-08-04T00:01:00.000Z",
    });
  });

  it("periodically converges nts_pending invoices to provider truth and stores the original before locking", async () => {
    const settlement = approvedSettlement("settlement-reconcile-1");
    const pending: TaxInvoice = {
      ...approvedInvoice(1, 1, settlement.id),
      id: "invoice-reconcile-1",
      invoiceGroupId: "invoice-group-reconcile-1",
      providerManagementKey: "OFDRECONCILE00000000001",
      status: "nts_pending",
      providerReceiptId: "receipt-reconcile-1",
      version: 5,
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: pending.id, storeId: store.id, expectedVersion: null, value: pending },
    ]);
    const storage = new MockObjectStorage();
    const invoiceProvider = provider({
      getTaxInvoiceStatus: async () => ({ receiptId: "receipt-reconcile-1", serialNumber: "202608021234567890123456", issuedAt: new Date().toISOString(), ntsStatus: "success" }),
      getTaxInvoiceOriginal: async (invoice) => ({ bytes: new TextEncoder().encode(`%PDF-1.4\n${invoice.id}\n%%EOF\n`), mimeType: "application/pdf", fileName: `${invoice.id}.pdf` }),
    });
    const worker = new OfdWorker(repository, invoiceProvider, new MockEmailProvider(), testConfig, storage);

    await worker.runScheduled(new Date("2026-08-02T00:10:00.000Z"));
    expect(await worker.processOnce(10)).toMatchObject({ claimed: 3, completed: 3, failed: 0 });
    expect(await repository.get<TaxInvoice>("tax_invoice", pending.id)).toMatchObject({ status: "nts_success", serialNumber: "202608021234567890123456" });
    expect(await repository.get<Settlement>("settlement", settlement.id)).toMatchObject({ status: "locked" });
    const original = (await repository.list<OriginalDocument>("document")).find((document) => document.aggregateId === pending.id)!;
    expect((await storage.getImmutableObject(original.objectKey, original.objectVersionId)).contentHashSha256).toBe(original.contentHashSha256);
  });

  it("persists the prepaid payment request original carried by order.approved", async () => {
    const prepaidStore: Store = { ...store, id: "store-prepaid-original", paymentMethod: "prepaid" };
    const payment: PaymentRequest = {
      id: "payment-prepaid-original",
      storeId: prepaidStore.id,
      amount: 33_000,
      dueDate: "2026-08-02",
      status: "pending",
      depositorHint: "owner",
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const repository = new MemoryRepository([
      { type: "store", id: prepaidStore.id, storeId: prepaidStore.id, expectedVersion: null, value: prepaidStore },
      { type: "payment_request", id: payment.id, storeId: prepaidStore.id, expectedVersion: null, value: payment },
    ]);
    await repository.commit({ changes: [], outbox: [event("prepaid-approved", "order.approved", "order-prepaid", {
      storeId: prepaidStore.id,
      paymentRequestId: payment.id,
    })] });
    const storage = new MockObjectStorage();
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig, storage);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.list<OriginalDocument>("document")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "payment_request", aggregateId: payment.id, sourceVersion: 1 }),
    ]));
  });

  it("uses the shared holiday calendar for settlement payment deadlines", async () => {
    const settlement: Settlement = {
      id: "settlement-holiday-deadline",
      storeId: store.id,
      kind: "monthly",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      status: "draft",
      receiptIds: [],
      gross: 11_000,
      supply: 10_000,
      vat: 1_000,
      version: 1,
    };
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
    ]);
    await repository.commit({ changes: [], outbox: [event("holiday-settlement", "settlement.drafted", settlement.id, {
      settlementId: settlement.id,
      storeId: store.id,
    })] });
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig, new MockObjectStorage(),
      (date) => date === "2026-08-10");

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const payment = (await repository.list<PaymentRequest>("payment_request", [store.id])).find((item) => item.settlementId === settlement.id);
    expect(payment).toMatchObject({ dueDate: "2026-08-11", status: "pending" });
  });
});

describe("OFD worker safety", () => {
  it("does not issue external invoices through a mock provider in production but still generates internal statements", async () => {
    const settlement = approvedSettlement("settlement-production-mock");
    const external = { ...approvedInvoice(1, 1, settlement.id), id: "invoice-production-mock", invoiceGroupId: "group-production-mock" };
    const externalRepository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: external.id, storeId: store.id, expectedVersion: null, value: external },
    ]);
    await externalRepository.commit({ changes: [], outbox: [event("production-mock-issue", "invoice.issue.requested", external.id, {
      invoiceId: external.id,
    })] });
    let issueCalls = 0;
    const guardedProvider = provider({ issueTaxInvoice: async (invoice) => {
      issueCalls += 1;
      return new MockPopbillProvider().issueTaxInvoice(invoice);
    } });
    const externalWorker = new OfdWorker(externalRepository, guardedProvider, new MockEmailProvider(), productionMockConfig);

    expect(await externalWorker.processOnce()).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(issueCalls).toBe(0);
    expect(await externalRepository.get<TaxInvoice>("tax_invoice", external.id)).toMatchObject({ status: "approved", version: external.version });

    const internalRepository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
      { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
      { type: "tax_invoice", id: "internal-production", storeId: store.id, expectedVersion: null,
        value: { ...external, id: "internal-production", issueType: "internal_statement", providerManagementKey: "INTERNALPRODUCTION000001" } },
    ]);
    await internalRepository.commit({ changes: [], outbox: [event("production-internal", "statement.generate", "internal-production", {
      invoiceId: "internal-production",
    })] });
    const internalWorker = new OfdWorker(internalRepository, guardedProvider, new MockEmailProvider(), productionMockConfig);
    expect(await internalWorker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await internalRepository.get<TaxInvoice>("tax_invoice", "internal-production")).toMatchObject({ status: "issued" });
    expect(issueCalls).toBe(0);
  });

  it("neither schedules nor executes mock bank synchronization in production", async () => {
    const scheduledRepository = new MemoryRepository();
    const scheduledWorker = new OfdWorker(scheduledRepository, provider(), new MockEmailProvider(), productionMockConfig);
    await scheduledWorker.runScheduled(new Date("2026-08-04T00:01:00.000Z"));
    const scheduled = await scheduledRepository.claimOutbox(10, "production-schedule-inspector", 12);
    expect(scheduled.map(({ topic }) => topic)).not.toContain("bank.sync.requested");

    const runRepository = new MemoryRepository();
    await runRepository.commit({ changes: [], outbox: [event("production-mock-bank", "bank.sync.requested", "2026-08-04", {
      from: "2026-08-04", to: "2026-08-04",
    })] });
    let bankCalls = 0;
    const worker = new OfdWorker(runRepository, provider({ fetchBankTransactions: async () => { bankCalls += 1; return []; } }),
      new MockEmailProvider(), productionMockConfig);
    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(bankCalls).toBe(0);
    expect(await runRepository.list<BankTransaction>("bank_transaction")).toEqual([]);
  });

  it("does not create or mark mock SMS notifications as sent in production", async () => {
    const repository = new MemoryRepository([
      { type: "store", id: store.id, storeId: store.id, expectedVersion: null, value: store },
    ]);
    await repository.commit({ changes: [], outbox: [event("production-mock-sms", "order.cancelled", "order-production-sms", {
      storeId: store.id, orderNumber: "OFD-PRODUCTION-SMS",
    })] });
    let smsCalls = 0;
    const worker = new OfdWorker(repository, provider({ sendSms: async () => { smsCalls += 1; return { receiptId: "should-not-exist" }; } }),
      new MockEmailProvider(), productionMockConfig);
    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(smsCalls).toBe(0);
    expect((await repository.list<{ channel: string; status: string }>("notification"))
      .filter(({ channel }) => channel === "sms")).toEqual([]);
  });

  it("중첩 webhook payload를 꺼내 issued 문서를 nts_pending을 거쳐 국세청 성공으로 전이한다", async () => {
    const repository = createDemoRepository();
    const invoiceId = "00000000-0000-4000-8000-000000008001";
    const current = (await repository.get<TaxInvoice>("tax_invoice", invoiceId))!;
    const issued: TaxInvoice = {
      ...current,
      status: "issued",
      providerReceiptId: "popbill-item-1",
      version: current.version + 1,
    };
    await repository.commit({
      changes: [{ type: "tax_invoice", id: issued.id, storeId: issued.storeId, expectedVersion: current.version, value: issued }],
      outbox: [event("webhook-event-1", "popbill.webhook.received", issued.id, {
        eventId: "MID-1",
        payload: {
          headers: { mid: "MID-1", corpNum: "1234567890" },
          bodies: [{ corpNum: "1234567890", itemKey: "popbill-item-1", stateCode: 304, ntsconfirmNum: "202608028888888800000001" }],
        },
      })],
    });
    const config = readProviderConfig({ APP_MODE: "test", PROVIDER_MODE: "mock" });
    const worker = new OfdWorker(repository, new MockPopbillProvider(), new MockEmailProvider(), config);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.get<TaxInvoice>("tax_invoice", invoiceId)).toMatchObject({
      status: "nts_success",
      serialNumber: "202608028888888800000001",
      version: issued.version + 2,
    });
  });

  it("서울 날짜로 일일 계좌 수집을 한 번만 실행한다", async () => {
    const repository = createDemoRepository();
    const calls: Array<[string, string]> = [];
    const popbill: PopbillProvider = {
      issueTaxInvoice: (invoice) => new MockPopbillProvider().issueTaxInvoice(invoice),
      getTaxInvoiceStatus: async () => undefined,
      getTaxInvoiceOriginal: async () => undefined,
      fetchBankTransactions: async (from, to): Promise<BankTransaction[]> => { calls.push([from, to]); return []; },
      sendSms: async () => ({ receiptId: "mock" }),
    };
    const config = readProviderConfig({ APP_MODE: "test", PROVIDER_MODE: "mock" });
    const worker = new OfdWorker(repository, popbill, new MockEmailProvider(), config);

    const seoulAugustFirst = new Date("2026-07-31T15:30:00.000Z");
    await worker.runScheduled(seoulAugustFirst);
    await worker.runScheduled(new Date("2026-07-31T23:59:00.000Z"));
    expect(await worker.processOnce(10)).toMatchObject({ claimed: 3, completed: 3, failed: 0 });

    expect(calls).toEqual([["2026-08-01", "2026-08-01"]]);
    const ledgers = await repository.list<{ scheduleKey: string }>("admin_invariant");
    expect(ledgers.map((ledger) => ledger.scheduleKey)).toEqual(expect.arrayContaining([
      "monthly-close:2026-07",
      "bank-sync:2026-08-01",
      "invoice-reconcile:2026-07-31T15:30",
    ]));
  });

  it("enqueues prior-month close on any Seoul calendar day and persists its idempotency ledger", async () => {
    const repository = new MemoryRepository();
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig);
    const middleOfMonth = new Date("2026-07-15T03:01:00.000Z");

    await worker.runScheduled(middleOfMonth);
    await worker.runScheduled(middleOfMonth);

    const ledgers = await repository.list<{ scheduleKey: string; topic: string }>("admin_invariant");
    expect(ledgers.filter((ledger) => ledger.scheduleKey === "monthly-close:2026-06")).toEqual([
      expect.objectContaining({ topic: "settlement.monthly_close.requested" }),
    ]);
    const scheduled = await repository.claimOutbox(20, "schedule-test-worker", 12);
    expect(scheduled.filter((item) => item.topic === "settlement.monthly_close.requested")).toHaveLength(1);
  });

  it("closes the exact prior-month period carried by the durable schedule event", async () => {
    const monthlyStore: Store = { ...store, id: "store-monthly-close", paymentMethod: "prepaid" };
    const order: PurchaseOrder = {
      id: "order-monthly-close",
      number: "OFD-202607-001",
      storeId: monthlyStore.id,
      status: "approved",
      source: "native",
      requestedDeliveryDate: "2026-07-15",
      note: "",
      lines: [],
      gross: 11_000,
      supply: 10_000,
      vat: 1_000,
      createdBy: "store-owner",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      version: 1,
    };
    const receipt: GoodsReceipt = {
      id: "receipt-monthly-close",
      shipmentId: "shipment-monthly-close",
      orderId: order.id,
      storeId: monthlyStore.id,
      status: "confirmed",
      confirmedAt: "2026-07-15T02:00:00.000Z",
      confirmedBy: "driver",
      gross: 11_000,
      supply: 10_000,
      vat: 1_000,
    };
    const repository = new MemoryRepository([
      { type: "store", id: monthlyStore.id, storeId: monthlyStore.id, expectedVersion: null, value: monthlyStore },
      { type: "order", id: order.id, storeId: monthlyStore.id, expectedVersion: null, value: order },
      { type: "receipt", id: receipt.id, storeId: monthlyStore.id, expectedVersion: null, value: receipt },
    ]);
    await repository.commit({ changes: [], outbox: [event("close-july", "settlement.monthly_close.requested", "monthly-close:2026-07", {
      year: 2026,
      month: 7,
    })] });
    const worker = new OfdWorker(repository, provider(), new MockEmailProvider(), testConfig);

    expect(await worker.processOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await repository.list<Settlement>("settlement", [monthlyStore.id])).toEqual([
      expect.objectContaining({ kind: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31", receiptIds: [receipt.id] }),
    ]);
  });
});
