import type { GoodsReceipt, PurchaseOrder, Settlement, Shipment, Store, TaxInvoice } from "@ofd/domain";

/* ── V1 정산(본사) 탭 이식 — 월별 매장 집계 ──
 * V1: 공급 매출(출고·완료 발주 승인 스냅샷) × 매장 매출(마감/POS) × 로스율.
 * V2 최적화: 공급의 권위는 검수 확정 입고(goods receipt), 매장 매출은 토스플레이스 POS 실측,
 * 로스는 확정 입고 수량 − POS 판매 수량(상품 매칭 기준). 입고가 없는 달은 단정하지 않고 null(N/A). */

export interface PosStoreMonthTotal { storeId: string; qty: number; amount: number }
export interface PosStoreProductQty { storeId: string; productId: string; qty: number }

export interface MonthlySettlementRow {
  storeId: string;
  code: string;
  name: string;
  storeKind: "직영" | "가맹" | null;
  /** 해당 월(KST) 검수 확정 입고 합계 (VAT 포함) — V1 '공급 매출'에 대응 */
  supplyConfirmed: number;
  receiptCount: number;
  /** periodStart가 해당 월인 정산서 합계 (VAT 포함) */
  settledGross: number;
  settlementCount: number;
  invoiceSummary: { total: number; ntsSuccess: number; failed: number; inProgress: number };
  /** POS 실측 매장 매출 (해당 월) */
  posRevenue: number;
  posQty: number;
  /** 공급/매출 비율(%) — POS 매출이 없으면 null */
  supplyToPosPct: number | null;
  /** 확정 입고 수량 — 입고가 없으면 null */
  receivedQty: number | null;
  /** POS에서 상품 매칭된 판매 수량 */
  soldQty: number;
  /** 로스 수량 = Σ상품별 max(0, 입고−판매) — 입고가 없으면 null */
  wasteQty: number | null;
  /** 로스율(%) = max(0, 입고−판매)/입고 — 입고가 없으면 null */
  lossRate: number | null;
}

export interface MonthlySettlementSummary {
  month: string;
  rows: MonthlySettlementRow[];
  totals: {
    supplyConfirmed: number; receiptCount: number; settledGross: number; settlementCount: number;
    posRevenue: number; posQty: number; receivedQty: number | null; soldQty: number; wasteQty: number | null; lossRate: number | null;
    invoiceSummary: { total: number; ntsSuccess: number; failed: number; inProgress: number };
  };
}

const KST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

/** ISO 시각 → KST 달력 일자(YYYY-MM-DD). 파싱 불가 값은 빈 문자열(어느 달에도 속하지 않음). */
export function kstDateOf(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.valueOf()) ? "" : KST_DATE.format(time);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

const INVOICE_TERMINAL_FAILED = new Set(["failed"]);
const INVOICE_TERMINAL_SUCCESS = new Set(["nts_success"]);

export function buildMonthlySettlementSummary(month: string, input: {
  stores: Store[];
  receipts: GoodsReceipt[];
  shipments: Shipment[];
  orders: PurchaseOrder[];
  settlements: Settlement[];
  invoices: TaxInvoice[];
  posTotals: PosStoreMonthTotal[];
  posProductQty: PosStoreProductQty[];
}): MonthlySettlementSummary {
  const shipmentById = new Map(input.shipments.map((shipment) => [shipment.id, shipment]));
  const orderById = new Map(input.orders.map((order) => [order.id, order]));
  const posByStore = new Map<string, PosStoreMonthTotal>();
  for (const total of input.posTotals) {
    const current = posByStore.get(total.storeId) ?? { storeId: total.storeId, qty: 0, amount: 0 };
    current.qty += total.qty;
    current.amount += total.amount;
    posByStore.set(total.storeId, current);
  }
  const soldByStoreProduct = new Map<string, number>();
  for (const sold of input.posProductQty) {
    const key = `${sold.storeId}|${sold.productId}`;
    soldByStoreProduct.set(key, (soldByStoreProduct.get(key) ?? 0) + sold.qty);
  }

  const rows = input.stores
    .filter((store) => store.active)
    .map((store) => {
      const confirmed = input.receipts.filter((receipt) => receipt.storeId === store.id
        && receipt.status === "confirmed" && kstDateOf(receipt.confirmedAt).slice(0, 7) === month);
      const supplyConfirmed = confirmed.reduce((sum, receipt) => sum + receipt.gross, 0);

      /* 입고 수량: 입고 → 배송 라인 → 발주 라인 스냅샷의 상품으로 귀속.
       * 연결이 끊긴 라인도 수량은 로스 분모에 남긴다(전용 버킷) — 놓치는 것보다 보수적으로 계산. */
      const receivedByProduct = new Map<string, number>();
      for (const receipt of confirmed) {
        const shipment = shipmentById.get(receipt.shipmentId);
        if (!shipment) continue;
        const order = orderById.get(receipt.orderId);
        for (const line of shipment.lines) {
          const productId = order?.lines.find((orderLine) => orderLine.id === line.orderLineId)?.snapshot.productId
            ?? `#unlinked:${line.orderLineId}`;
          receivedByProduct.set(productId, (receivedByProduct.get(productId) ?? 0) + line.quantity);
        }
      }
      const receivedQty = confirmed.length > 0
        ? [...receivedByProduct.values()].reduce((sum, quantity) => sum + quantity, 0) : null;
      let waste = 0;
      for (const [productId, quantity] of receivedByProduct) {
        const sold = productId.startsWith("#unlinked:") ? 0 : soldByStoreProduct.get(`${store.id}|${productId}`) ?? 0;
        waste += Math.max(0, quantity - sold);
      }
      const lossRate = receivedQty !== null && receivedQty > 0 ? round1((waste / receivedQty) * 100) : null;

      const monthSettlements = input.settlements.filter((settlement) => settlement.storeId === store.id
        && settlement.periodStart.slice(0, 7) === month);
      const settlementIds = new Set(monthSettlements.map((settlement) => settlement.id));
      const monthInvoices = input.invoices.filter((invoice) => invoice.storeId === store.id
        && invoice.settlementId !== undefined && settlementIds.has(invoice.settlementId));
      const invoiceSummary = {
        total: monthInvoices.length,
        ntsSuccess: monthInvoices.filter((invoice) => INVOICE_TERMINAL_SUCCESS.has(invoice.status)).length,
        failed: monthInvoices.filter((invoice) => INVOICE_TERMINAL_FAILED.has(invoice.status)).length,
        inProgress: monthInvoices.filter((invoice) => !INVOICE_TERMINAL_SUCCESS.has(invoice.status)
          && !INVOICE_TERMINAL_FAILED.has(invoice.status)).length,
      };

      const pos = posByStore.get(store.id) ?? { qty: 0, amount: 0 };
      const totalSold = [...soldByStoreProduct.entries()]
        .filter(([key]) => key.startsWith(`${store.id}|`))
        .reduce((sum, [, quantity]) => sum + quantity, 0);
      return {
        storeId: store.id, code: store.code, name: store.name, storeKind: store.storeKind ?? null,
        supplyConfirmed, receiptCount: confirmed.length,
        settledGross: monthSettlements.reduce((sum, settlement) => sum + settlement.gross, 0),
        settlementCount: monthSettlements.length,
        invoiceSummary,
        posRevenue: pos.amount, posQty: pos.qty,
        supplyToPosPct: pos.amount > 0 ? round1((supplyConfirmed / pos.amount) * 100) : null,
        receivedQty, soldQty: totalSold, wasteQty: receivedQty !== null ? waste : null, lossRate,
      } satisfies MonthlySettlementRow;
    })
    .sort((left, right) => left.name.localeCompare(right.name, "ko"));

  const withReceipts = rows.filter((row) => row.receivedQty !== null);
  const receivedTotal = withReceipts.reduce((sum, row) => sum + (row.receivedQty ?? 0), 0);
  const wasteTotal = withReceipts.reduce((sum, row) => sum + (row.wasteQty ?? 0), 0);
  const totals = {
    supplyConfirmed: rows.reduce((sum, row) => sum + row.supplyConfirmed, 0),
    receiptCount: rows.reduce((sum, row) => sum + row.receiptCount, 0),
    settledGross: rows.reduce((sum, row) => sum + row.settledGross, 0),
    settlementCount: rows.reduce((sum, row) => sum + row.settlementCount, 0),
    posRevenue: rows.reduce((sum, row) => sum + row.posRevenue, 0),
    posQty: rows.reduce((sum, row) => sum + row.posQty, 0),
    receivedQty: withReceipts.length > 0 ? receivedTotal : null,
    soldQty: rows.reduce((sum, row) => sum + row.soldQty, 0),
    wasteQty: withReceipts.length > 0 ? wasteTotal : null,
    lossRate: withReceipts.length > 0 && receivedTotal > 0 ? round1((wasteTotal / receivedTotal) * 100) : null,
    invoiceSummary: {
      total: rows.reduce((sum, row) => sum + row.invoiceSummary.total, 0),
      ntsSuccess: rows.reduce((sum, row) => sum + row.invoiceSummary.ntsSuccess, 0),
      failed: rows.reduce((sum, row) => sum + row.invoiceSummary.failed, 0),
      inProgress: rows.reduce((sum, row) => sum + row.invoiceSummary.inProgress, 0),
    },
  };
  return { month, rows, totals };
}
