import { createDemoRepository } from "@ofd/db";
import type { BankTransaction, OutboxEvent, TaxInvoice } from "@ofd/domain";
import { MockEmailProvider, MockPopbillProvider, readProviderConfig, type PopbillProvider } from "@ofd/integrations";
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

describe("OFD worker safety", () => {
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
      fetchBankTransactions: async (from, to): Promise<BankTransaction[]> => { calls.push([from, to]); return []; },
      sendSms: async () => ({ receiptId: "mock" }),
    };
    const config = readProviderConfig({ APP_MODE: "test", PROVIDER_MODE: "mock" });
    const worker = new OfdWorker(repository, popbill, new MockEmailProvider(), config);

    const seoulSeptemberFirst = new Date("2026-08-31T15:30:00.000Z");
    await worker.runScheduled(seoulSeptemberFirst);
    await worker.runScheduled(new Date("2026-08-31T23:59:00.000Z"));

    expect(calls).toEqual([["2026-09-01", "2026-09-01"]]);
  });
});
