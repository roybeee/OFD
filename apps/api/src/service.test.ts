import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import type { Actor, GoodsReceipt, PurchaseOrder } from "@ofd/domain";
import { MockObjectStorage } from "@ofd/integrations";
import { describe, expect, it } from "vitest";
import { ProcurementService } from "./service.ts";

describe("ProcurementService accounting", () => {
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
});
