import type { GoodsReceipt, PurchaseOrder, Settlement, Shipment, Store, TaxInvoice } from "@ofd/domain";
import { describe, expect, it } from "vitest";
import { buildMonthlySettlementSummary, kstDateOf } from "./monthly-settlement.ts";

const business = { businessNumber: "1234567890", legalName: "테스트", representativeName: "대표", address: "서울",
  businessType: "음식점업", businessCategory: "카페", email: "t@t.example" };

const store = (id: string, name: string, storeKind?: "직영" | "가맹", active = true): Store => ({
  id, code: id.toUpperCase(), name, business, billingCycle: "monthly", paymentMethod: "monthly_credit",
  notificationPhone: "01000000000", active, version: 1, ...(storeKind ? { storeKind } : {}) });

const order = (id: string, storeId: string, lines: Array<{ lineId: string; productId: string; quantity: number }>): PurchaseOrder => ({
  id, number: id.toUpperCase(), storeId, status: "approved", source: "native", requestedDeliveryDate: "2026-07-30", note: "",
  lines: lines.map((line) => ({ id: line.lineId, gross: 1_100, supply: 1_000, vat: 100, quantity: line.quantity,
    snapshot: { productId: line.productId, sku: line.productId, name: line.productId, unit: "EA", unitGross: 1_100, taxable: true, taxRate: 10 } })),
  gross: 1_100, supply: 1_000, vat: 100, createdBy: "owner", createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z", version: 1 });

const shipment = (id: string, orderId: string, storeId: string, lines: Array<{ orderLineId: string; quantity: number }>): Shipment => ({
  id, number: id.toUpperCase(), orderId, storeId, driverId: "driver", status: "delivered", lines, plannedDate: "2026-07-30", version: 1 });

const receipt = (id: string, shipmentId: string, orderId: string, storeId: string, confirmedAt: string, gross: number): GoodsReceipt => ({
  id, shipmentId, orderId, storeId, status: "confirmed", confirmedAt, confirmedBy: "driver",
  gross, supply: Math.round(gross / 1.1), vat: gross - Math.round(gross / 1.1) });

describe("월별 정산 집계 (V1 정산 탭 이식)", () => {
  it("KST 경계로 월을 귀속한다 — UTC 15시는 KST 다음날", () => {
    expect(kstDateOf("2026-07-31T15:30:00.000Z")).toBe("2026-08-01");
    expect(kstDateOf("2026-07-31T14:59:00.000Z")).toBe("2026-07-31");
    expect(kstDateOf("not-a-date")).toBe("");
  });

  it("확정 입고·정산·계산서·POS를 매장별로 합산하고 로스율을 상품 단위로 계산한다", () => {
    const doksan = store("doksan", "독산점", "가맹");
    const orders = [order("o1", "doksan", [
      { lineId: "o1-l1", productId: "brioche", quantity: 10 },
      { lineId: "o1-l2", productId: "bean", quantity: 5 },
    ])];
    const shipments = [shipment("sh1", "o1", "doksan", [
      { orderLineId: "o1-l1", quantity: 10 }, { orderLineId: "o1-l2", quantity: 5 },
    ])];
    const receipts = [
      receipt("r1", "sh1", "o1", "doksan", "2026-07-30T04:22:00.000Z", 110_000),
      receipt("r-out", "sh1", "o1", "doksan", "2026-06-30T04:22:00.000Z", 999_999), // 다른 달 — 제외
    ];
    const settlements: Settlement[] = [{ id: "s1", storeId: "doksan", kind: "monthly", periodStart: "2026-07-01",
      periodEnd: "2026-07-31", status: "draft", receiptIds: ["r1"], gross: 110_000, supply: 100_000, vat: 10_000, version: 1 }];
    const invoices = [{ id: "i1", storeId: "doksan", settlementId: "s1", status: "reviewed" } as TaxInvoice];
    const summary = buildMonthlySettlementSummary("2026-07", {
      stores: [doksan, store("closed", "폐점", undefined, false)],
      receipts, shipments, orders, settlements, invoices,
      posTotals: [{ storeId: "doksan", qty: 40, amount: 220_000 }],
      /* brioche는 8개 팔림(로스 2), bean은 판매 기록 없음(로스 5) → 로스 7/15 = 46.7% */
      posProductQty: [{ storeId: "doksan", productId: "brioche", qty: 8 }],
    });
    expect(summary.rows).toHaveLength(1); // 비활성 매장 제외
    const row = summary.rows[0]!;
    expect(row).toMatchObject({ name: "독산점", storeKind: "가맹", supplyConfirmed: 110_000, receiptCount: 1,
      settledGross: 110_000, settlementCount: 1, posRevenue: 220_000, posQty: 40,
      receivedQty: 15, soldQty: 8, wasteQty: 7, lossRate: 46.7, supplyToPosPct: 50 });
    expect(row.invoiceSummary).toEqual({ total: 1, ntsSuccess: 0, failed: 0, inProgress: 1 });
    expect(summary.totals).toMatchObject({ supplyConfirmed: 110_000, posRevenue: 220_000, wasteQty: 7, lossRate: 46.7 });
  });

  it("입고가 없는 매장은 로스율을 0으로 단정하지 않고 null로 둔다 (POS만 있는 파일럿 상태)", () => {
    const summary = buildMonthlySettlementSummary("2026-07", {
      stores: [store("mapdal", "맵달서울점", "직영")], receipts: [], shipments: [], orders: [], settlements: [], invoices: [],
      posTotals: [{ storeId: "mapdal", qty: 120, amount: 480_000 }], posProductQty: [],
    });
    const row = summary.rows[0]!;
    expect(row).toMatchObject({ supplyConfirmed: 0, receivedQty: null, wasteQty: null, lossRate: null,
      posRevenue: 480_000, supplyToPosPct: 0 });
    expect(summary.totals.lossRate).toBeNull();
    expect(summary.totals.receivedQty).toBeNull();
  });

  it("배송 라인이 발주 라인과 연결되지 않아도 입고 수량은 로스 분모에 남는다", () => {
    const summary = buildMonthlySettlementSummary("2026-07", {
      stores: [store("doksan", "독산점")],
      receipts: [receipt("r1", "sh1", "missing-order", "doksan", "2026-07-10T01:00:00.000Z", 55_000)],
      shipments: [shipment("sh1", "missing-order", "doksan", [{ orderLineId: "ghost", quantity: 20 }])],
      orders: [], settlements: [], invoices: [], posTotals: [], posProductQty: [],
    });
    expect(summary.rows[0]).toMatchObject({ receivedQty: 20, wasteQty: 20, lossRate: 100 });
  });
});
