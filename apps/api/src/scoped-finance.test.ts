import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import type { Actor, OriginalDocument, Settlement, TaxInvoice } from "@ofd/domain";
import { MockObjectStorage } from "@ofd/integrations";
import { describe, expect, it } from "vitest";
import { ProcurementService } from "./service.ts";

async function fixture() {
  const repository = createDemoRepository();
  const finance = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
  return { repository, finance, service: new ProcurementService(repository, new MockObjectStorage(), "production") };
}

describe("Scoped finance partner access", () => {
  it("scopes all bootstrap financial collections and never returns headquarters bank feeds", async () => {
    const { repository, finance, service } = await fixture();
    const partner = { ...finance, storeIds: [DEMO_IDS.storeHapjeong] };
    const data = await service.bootstrap(partner) as Record<string, unknown>;
    expect(data.stores).toEqual([expect.objectContaining({ id: DEMO_IDS.storeHapjeong })]);
    for (const key of ["orders", "shipments", "receipts", "paymentRequests", "settlements", "taxInvoices", "documents"]) {
      const rows = data[key] as Array<{ storeId: string }>;
      expect(rows.every((row) => row.storeId === DEMO_IDS.storeHapjeong)).toBe(true);
    }
    expect(data.settlements).toEqual([]);
    expect(data.taxInvoices).toEqual([]);
    expect(data.bankTransactions).toEqual([]);
    expect(data.manualMatchCandidates).toEqual([]);
    expect(data.capabilities).not.toContain("hq.payments.reconcile");
    expect(data.capabilities).not.toContain("hq.pos.read");
    expect(data.capabilities).toContain("oda.finance.read");
    const global = await service.bootstrap(finance) as Record<string, unknown>;
    expect((global.stores as unknown[]).length).toBeGreaterThan(1);
    expect((global.bankTransactions as unknown[]).length).toBe((await repository.list("bank_transaction")).length);
  });

  it("rejects cross-store settlement, invoice and evidence operations before exposing record state", async () => {
    const { repository, finance, service } = await fixture();
    const partner = { ...finance, storeIds: [DEMO_IDS.storeHapjeong] };
    const settlement = (await repository.list<Settlement>("settlement", [DEMO_IDS.storeDoksan]))[0]!;
    const invoice = (await repository.list<TaxInvoice>("tax_invoice", [DEMO_IDS.storeDoksan]))[0]!;
    const document: OriginalDocument = {
      id: "cross-store-document", storeId: DEMO_IDS.storeDoksan, kind: "tax_invoice", aggregateType: "tax_invoice", aggregateId: invoice.id,
      sourceVersion: invoice.version, fileName: "private.pdf", mimeType: "application/pdf", sizeBytes: 20,
      objectKey: "private/cross-store.pdf", objectVersionId: "v1", contentHashSha256: "a".repeat(64),
      createdAt: "2026-09-01T00:00:00.000Z", version: 1,
    };
    await repository.commit({ changes: [{ type: "document", id: document.id, storeId: document.storeId, expectedVersion: null, value: document }] });
    const operations = [
      () => service.draftSettlement(partner, { storeId: DEMO_IDS.storeDoksan, periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
      () => service.reviewSettlement(partner, settlement.id, settlement.version),
      () => service.createInvoiceDraft(partner, settlement.id),
      () => service.reviewInvoice(partner, invoice.id, invoice.version),
      () => service.createModifiedInvoice(partner, invoice.id, "01"),
      () => service.approveInvoice(partner, invoice.id, invoice.version),
      () => service.retryInvoice(partner, invoice.id, invoice.version),
      () => service.downloadDocument(partner, document.id),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED", statusCode: 403 });
  });

  it("allows finance work in the assigned store while denying all unscoped bank effects", async () => {
    const { repository, finance, service } = await fixture();
    const partner = { ...finance, storeIds: [DEMO_IDS.storeDoksan] };
    const base = (await repository.list<TaxInvoice>("tax_invoice", [DEMO_IDS.storeDoksan]))[0]!;
    const invoice: TaxInvoice = { ...base, status: "draft", version: base.version + 1 };
    await repository.commit({ changes: [{ type: "tax_invoice", id: invoice.id, storeId: invoice.storeId, expectedVersion: base.version, value: invoice }] });
    await expect(service.reviewInvoice(partner, invoice.id, invoice.version)).resolves.toMatchObject({ invoice: { status: "reviewed", reviewedBy: partner.id } });
    await expect(service.autoMatchPayments(partner)).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED" });
    await expect(service.manualMatchPayment(partner, "any-payment", "any-bank", 1)).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED" });
    await expect(service.reversePaymentMatch(partner, "any-payment", 1, "사유 입력")).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED" });
    await expect(service.requestBankSync(partner, "2026-09-01", "2026-09-14")).rejects.toMatchObject({ code: "STORE_SCOPE_DENIED" });
  });
});
