import {
  splitVatInclusive,
  hashPassword,
  popbillManagementKey,
  type Actor,
  type BankTransaction,
  type GoodsReceipt,
  type LegalEntitySnapshot,
  type Notification,
  type PaymentRequest,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Settlement,
  type Shipment,
  type Store,
  type TaxInvoice,
  type UserCredential,
} from "@ofd/domain";
import { MemoryRepository } from "./memory-repository.ts";
import type { AggregateChange } from "./repository.ts";

export const DEMO_IDS = {
  hq: "00000000-0000-4000-8000-000000000001",
  storeDoksan: "00000000-0000-4000-8000-000000001001",
  storeHapjeong: "00000000-0000-4000-8000-000000001002",
  storeDirect: "00000000-0000-4000-8000-000000001003",
  owner: "00000000-0000-4000-8000-000000000101",
  staff: "00000000-0000-4000-8000-000000000102",
  ops: "00000000-0000-4000-8000-000000000103",
  finance: "00000000-0000-4000-8000-000000000104",
  master: "00000000-0000-4000-8000-000000000105",
  driver: "00000000-0000-4000-8000-000000000106",
  system: "00000000-0000-4000-8000-000000000107",
  auditor: "00000000-0000-4000-8000-000000000108",
  productBrioche: "00000000-0000-4000-8000-000000002001",
  productBean: "00000000-0000-4000-8000-000000002002",
  productCup: "00000000-0000-4000-8000-000000002003",
  productMilk: "00000000-0000-4000-8000-000000002004",
} as const;

const hqBusiness: LegalEntitySnapshot = {
  businessNumber: "1234567890",
  legalName: "오픈프롬데이 주식회사",
  representativeName: "김오픈",
  address: "서울특별시 성동구 성수이로 88",
  businessType: "도소매업",
  businessCategory: "식자재·프랜차이즈",
  email: "finance@ofd.example",
};

const stores: Store[] = [
  {
    id: DEMO_IDS.storeDoksan, code: "DOKSAN", name: "독산점",
    business: { businessNumber: "2012345678", legalName: "오픈프롬데이 독산", representativeName: "박독산", address: "서울특별시 금천구 독산로 27", businessType: "음식점업", businessCategory: "카페", email: "doksan@ofd.example" },
    billingCycle: "monthly", paymentMethod: "monthly_credit", notificationPhone: "01012345678", active: true, version: 1,
  },
  {
    id: DEMO_IDS.storeHapjeong, code: "HAPJEONG", name: "합정점",
    business: { businessNumber: "3012345678", legalName: "오픈프롬데이 합정", representativeName: "이합정", address: "서울특별시 마포구 양화로 42", businessType: "음식점업", businessCategory: "카페", email: "hapjeong@ofd.example" },
    billingCycle: "per_delivery", paymentMethod: "prepaid", notificationPhone: "01023456789", active: true, version: 1,
  },
  {
    id: DEMO_IDS.storeDirect, code: "SEONGSU", name: "성수 직영점",
    business: { ...hqBusiness }, billingCycle: "monthly", paymentMethod: "monthly_credit", notificationPhone: "01034567890", active: true, version: 1,
  },
];

const actors: Actor[] = [
  { id: DEMO_IDS.owner, name: "박독산 점주", role: "store_owner", storeIds: [DEMO_IDS.storeDoksan], active: true, authVersion: 1 },
  { id: DEMO_IDS.staff, name: "최스태프", role: "store_staff", storeIds: [DEMO_IDS.storeDoksan], active: true, authVersion: 1 },
  { id: DEMO_IDS.ops, name: "김운영", role: "hq_ops", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString() },
  { id: DEMO_IDS.finance, name: "윤재무", role: "hq_finance", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString() },
  { id: DEMO_IDS.master, name: "정마스터", role: "hq_master", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString() },
  { id: DEMO_IDS.driver, name: "한배송", role: "driver", storeIds: [], active: true, authVersion: 1 },
  { id: DEMO_IDS.system, name: "OFD 자동화", role: "system", storeIds: [], active: true, authVersion: 1 },
  { id: DEMO_IDS.auditor, name: "서감사", role: "auditor", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString() },
];

const demoPasswordHash = hashPassword("OFD-demo-2026!", Buffer.alloc(16, 7));
const credentials: UserCredential[] = actors.filter((actor) => actor.role !== "system").map((actor, index) => ({
  id: `00000000-0000-4000-8000-${String(5000 + index).padStart(12, "0")}`,
  actorId: actor.id,
  email: `${actor.role.replaceAll("_", ".")}@ofd.local`,
  passwordHash: demoPasswordHash,
  failedAttempts: 0,
  version: 1,
}));

const products: Product[] = [
  { id: DEMO_IDS.productBrioche, sku: "BRI-12", name: "버터 브리오슈 12입", unit: "박스", unitGross: 37_800, taxable: true, taxRate: 10, active: true },
  { id: DEMO_IDS.productBean, sku: "BEAN-1K", name: "시그니처 원두 1kg", unit: "봉", unitGross: 28_600, taxable: true, taxRate: 10, active: true },
  { id: DEMO_IDS.productCup, sku: "CUP-13", name: "테이크아웃 컵 13oz 1,000개", unit: "박스", unitGross: 68_200, taxable: true, taxRate: 10, active: true },
  { id: DEMO_IDS.productMilk, sku: "MLK-12", name: "바리스타 우유 1L 12입", unit: "박스", unitGross: 32_400, taxable: true, taxRate: 10, active: true },
];

function makeOrder(input: {
  id: string; number: string; storeId: string; status: PurchaseOrder["status"]; source?: PurchaseOrder["source"];
  date: string; requested: string; items: Array<[Product, number]>; createdBy?: string;
}): PurchaseOrder {
  const lineGross = input.items.map(([product, quantity], index) => ({ id: `${input.id}-line-${index + 1}`, gross: product.unitGross * quantity }));
  const vat = splitVatInclusive(lineGross);
  const lines: PurchaseOrderLine[] = input.items.map(([product, quantity], index) => {
    const pricedLine = lineGross[index];
    const vatLine = vat.lines[index];
    if (!pricedLine || !vatLine) throw new Error("주문 품목의 부가세 배분 결과가 누락되었습니다.");
    return {
      ...vatLine,
      snapshot: { productId: product.id, sku: product.sku, name: product.name, unit: product.unit, unitGross: product.unitGross, taxable: true, taxRate: 10 },
      quantity,
    };
  });
  const time = `${input.date}T09:20:00.000Z`;
  return {
    id: input.id, number: input.number, storeId: input.storeId, status: input.status, source: input.source ?? "native",
    requestedDeliveryDate: input.requested, note: input.status === "submitted" ? "오전 입고 부탁드립니다." : "",
    lines, gross: vat.gross, supply: vat.supply, vat: vat.vat, createdBy: input.createdBy ?? DEMO_IDS.owner,
    ...(input.status !== "draft" ? { submittedAt: time } : {}),
    ...(input.status === "approved" ? { approvedBy: DEMO_IDS.ops, approvedAt: `${input.date}T10:10:00.000Z` } : {}),
    createdAt: time, updatedAt: time, version: 1,
  };
}

export function createDemoSeed(now = new Date("2026-08-02T05:30:00.000Z")): AggregateChange[] {
  const iso = now.toISOString();
  const [brioche, bean, cup, milk] = products;
  const doksanStore = stores[0];
  if (!brioche || !bean || !cup || !milk || !doksanStore) throw new Error("데모 기준정보가 누락되었습니다.");
  const submitted = makeOrder({
    id: "00000000-0000-4000-8000-000000003001", number: "PO-202608-0142", storeId: DEMO_IDS.storeDoksan,
    status: "submitted", date: "2026-08-02", requested: "2026-08-04", items: [[brioche, 3], [bean, 4]],
  });
  const approved = makeOrder({
    id: "00000000-0000-4000-8000-000000003002", number: "PO-202608-0141", storeId: DEMO_IDS.storeDoksan,
    status: "approved", date: "2026-08-01", requested: "2026-08-02", items: [[cup, 1], [milk, 2]],
  });
  const deliveredOrder = makeOrder({
    id: "00000000-0000-4000-8000-000000003003", number: "PO-202607-0130", storeId: DEMO_IDS.storeDoksan,
    status: "approved", date: "2026-07-28", requested: "2026-07-30", items: [[brioche, 2], [bean, 2]],
  });
  const legacyOrder = makeOrder({
    id: "00000000-0000-4000-8000-000000003004", number: "LEGACY-2026-0029", storeId: DEMO_IDS.storeHapjeong,
    status: "approved", source: "legacy_unverified", date: "2026-07-25", requested: "2026-07-26", items: [[brioche, 1]], createdBy: DEMO_IDS.ops,
  });
  const shipment: Shipment = {
    id: "00000000-0000-4000-8000-000000004001", number: "SHP-202608-0068", orderId: approved.id, storeId: approved.storeId,
    driverId: DEMO_IDS.driver, status: "out_for_delivery", lines: approved.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })),
    plannedDate: "2026-08-02", version: 2,
  };
  const deliveredShipment: Shipment = {
    id: "00000000-0000-4000-8000-000000004002", number: "SHP-202607-0061", orderId: deliveredOrder.id, storeId: deliveredOrder.storeId,
    driverId: DEMO_IDS.driver, status: "delivered", lines: deliveredOrder.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })),
    plannedDate: "2026-07-30", deliveredAt: "2026-07-30T04:22:00.000Z", version: 3,
    proof: { id: "00000000-0000-4000-8000-000000004102", shipmentId: "00000000-0000-4000-8000-000000004002",
      photoObjectKey: "demo/delivery-0061.jpg", objectVersionId: "demo-v1", etag: "demo-etag", checksumSha256: "demo-checksum",
      recipientName: "박독산", note: "카운터 옆 전달", capturedAt: "2026-07-30T04:22:00.000Z", uploadedBy: DEMO_IDS.driver },
  };
  const receipt: GoodsReceipt = {
    id: "00000000-0000-4000-8000-000000005001", shipmentId: deliveredShipment.id, orderId: deliveredOrder.id,
    storeId: deliveredOrder.storeId, status: "confirmed", confirmedAt: deliveredShipment.deliveredAt!, confirmedBy: DEMO_IDS.driver,
    gross: deliveredOrder.gross, supply: deliveredOrder.supply, vat: deliveredOrder.vat,
  };
  const paymentRequest: PaymentRequest = {
    id: "00000000-0000-4000-8000-000000006001", storeId: DEMO_IDS.storeDoksan, amount: 154_300,
    dueDate: "2026-08-10", status: "pending", depositorHint: "박독산", version: 1, createdAt: "2026-08-01T00:00:00.000Z",
  };
  const bankTransaction: BankTransaction = {
    id: "00000000-0000-4000-8000-000000006101", providerId: "demo-bank-20260802-01", accountId: "ofd-main",
    occurredAt: "2026-08-02T01:18:00.000Z", amount: 154_300, direction: "credit", memo: "박독산", matched: false,
    version: 1,
  };
  const ambiguousTransaction: BankTransaction = {
    id: "00000000-0000-4000-8000-000000006102", providerId: "demo-bank-20260802-02", accountId: "ofd-main",
    occurredAt: "2026-08-02T02:03:00.000Z", amount: 68_200, direction: "credit", memo: "OFD", matched: false,
    version: 1,
  };
  const settlement: Settlement = {
    id: "00000000-0000-4000-8000-000000007001", storeId: DEMO_IDS.storeDoksan, kind: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31",
    status: "draft", receiptIds: [receipt.id], gross: receipt.gross, supply: receipt.supply, vat: receipt.vat, version: 1,
  };
  const invoice: TaxInvoice = {
    id: "00000000-0000-4000-8000-000000008001", storeId: DEMO_IDS.storeDoksan, settlementId: settlement.id,
    invoiceGroupId: "00000000-0000-4000-8000-000000008000", partNumber: 1, partCount: 1,
    providerManagementKey: popbillManagementKey("00000000-0000-4000-8000-000000008001"),
    issueType: "normal", status: "reviewed", issueDate: "2026-07-31", dueDate: "2026-08-10",
    supplier: hqBusiness, recipient: doksanStore.business,
    gross: settlement.gross, supply: settlement.supply, vat: settlement.vat, preparedBy: DEMO_IDS.finance,
    reviewedBy: DEMO_IDS.finance, lines: [{ id: receipt.id, description: "식자재 공급", quantity: 1,
      gross: settlement.gross, supply: settlement.supply, vat: settlement.vat }], version: 2,
  };
  const settlementPaymentRequest: PaymentRequest = {
    id: "00000000-0000-4000-8000-000000006002", storeId: DEMO_IDS.storeDoksan, settlementId: settlement.id,
    amount: settlement.gross, dueDate: "2026-08-10", status: "paid", depositorHint: "박독산", version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const notification: Notification = {
    id: "00000000-0000-4000-8000-000000009001", actorId: DEMO_IDS.owner, storeId: DEMO_IDS.storeDoksan,
    channel: "app", template: "order_received", title: "발주서가 접수되었습니다", body: `${submitted.number}을 본사에서 확인하고 있습니다.`, status: "sent", createdAt: iso, version: 1,
  };

  return [
    { type: "legal_entity", id: DEMO_IDS.hq, expectedVersion: null, value: { id: DEMO_IDS.hq, isHeadquarters: true, ...hqBusiness } },
    ...actors.map((value) => ({ type: "actor" as const, id: value.id, expectedVersion: null, value })),
    ...credentials.map((value) => ({ type: "credential" as const, id: value.id, expectedVersion: null, value })),
    ...stores.map((value) => ({ type: "store" as const, id: value.id, storeId: value.id, expectedVersion: null, value })),
    ...products.map((value) => ({ type: "product" as const, id: value.id, expectedVersion: null, value })),
    ...[submitted, approved, deliveredOrder, legacyOrder].map((value) => ({ type: "order" as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })),
    { type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: null, value: shipment },
    { type: "shipment", id: deliveredShipment.id, storeId: deliveredShipment.storeId, expectedVersion: null, value: deliveredShipment },
    { type: "receipt", id: receipt.id, storeId: receipt.storeId, expectedVersion: null, value: receipt },
    { type: "payment_request", id: paymentRequest.id, storeId: paymentRequest.storeId, expectedVersion: null, value: paymentRequest },
    { type: "payment_request", id: settlementPaymentRequest.id, storeId: settlementPaymentRequest.storeId, expectedVersion: null, value: settlementPaymentRequest },
    { type: "bank_transaction", id: bankTransaction.id, expectedVersion: null, value: bankTransaction },
    { type: "bank_transaction", id: ambiguousTransaction.id, expectedVersion: null, value: ambiguousTransaction },
    { type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement },
    { type: "tax_invoice", id: invoice.id, storeId: invoice.storeId, expectedVersion: null, value: invoice },
    { type: "notification", id: notification.id, storeId: DEMO_IDS.storeDoksan, expectedVersion: null, value: notification },
  ];
}

export function createDemoRepository(): MemoryRepository {
  return new MemoryRepository(createDemoSeed());
}

export const demoHeadquarters = hqBusiness;
