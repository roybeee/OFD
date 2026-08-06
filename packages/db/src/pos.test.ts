import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPosStore, type PosSaleRow } from "./pos.ts";

const ROWS: PosSaleRow[] = [
  { date: "2026-08-03", rawName: "우유크림도넛", qty: 5, amount: 21_000 },
  { date: "2026-08-03", rawName: "아메리카노", qty: 1, amount: 4_000 },
  { date: "2026-08-04", rawName: "버터피스타치오", qty: 1, amount: 5_800 },
];

const linkInput = (merchantId = "521445", storeId = "store-mapdal") => ({
  storeId, merchantId, accessKeyEnc: "p1:enc", secretKeyEnc: "p1:enc", status: "active" as const,
});

test("merchantId 기준으로 링크를 멱등 저장한다", async () => {
  const store = new MemoryPosStore();
  const first = await store.upsertLink(linkInput());
  const second = await store.upsertLink({ ...linkInput(), accessKeyEnc: "p1:rotated" });
  assert.equal(second.id, first.id, "같은 merchantId는 새 링크를 만들지 않는다");
  assert.equal(second.accessKeyEnc, "p1:rotated", "키 교체는 반영된다");
  assert.equal((await store.listLinks()).length, 1);
  assert.equal((await store.findLinkByMerchant("521445"))?.storeId, "store-mapdal");
  assert.equal(await store.findLinkByMerchant("없음"), null);
});

test("재수집은 중복이 아니라 덮어쓰기로 처리한다", async () => {
  const store = new MemoryPosStore();
  await store.recordSales("store-mapdal", ROWS, "backfill");
  await store.recordSales("store-mapdal", ROWS, "sync");
  const totals = await store.dailyTotals("2026-08-03", "2026-08-04");
  assert.equal(totals.length, 2);
  assert.deepEqual(totals.find((t) => t.date === "2026-08-03"), { storeId: "store-mapdal", date: "2026-08-03", qty: 6, amount: 25_000 });
});

test("수정된 수량으로 재수집하면 최신값이 남는다", async () => {
  const store = new MemoryPosStore();
  await store.recordSales("store-mapdal", ROWS, "sync");
  await store.recordSales("store-mapdal", [{ date: "2026-08-03", rawName: "우유크림도넛", qty: 4, amount: 16_800 }], "sync");
  const totals = await store.dailyTotals("2026-08-03", "2026-08-03");
  assert.equal(totals[0]?.qty, 5, "4 + 아메리카노 1");
  assert.equal(totals[0]?.amount, 20_800);
});

test("매장을 구분해 합계를 낸다", async () => {
  const store = new MemoryPosStore();
  await store.recordSales("store-mapdal", ROWS, "sync");
  await store.recordSales("store-doksan", [{ date: "2026-08-03", rawName: "우유크림도넛", qty: 2, amount: 8_400 }], "sync");
  const totals = await store.dailyTotals("2026-08-03", "2026-08-03");
  assert.equal(totals.length, 2);
  assert.equal(totals.find((t) => t.storeId === "store-doksan")?.amount, 8_400);
});

test("구간 밖 일자는 합계와 품목 조회에서 제외한다", async () => {
  const store = new MemoryPosStore();
  await store.recordSales("store-mapdal", ROWS, "sync");
  assert.equal((await store.dailyTotals("2026-08-04", "2026-08-04")).length, 1);
  const rows = await store.itemRows("store-mapdal", "2026-08-03", "2026-08-03");
  assert.deepEqual(rows.map((r) => r.rawName), ["아메리카노", "우유크림도넛"]);
});

test("동기화 시각과 수집 이력을 기록한다", async () => {
  const store = new MemoryPosStore();
  const link = await store.upsertLink(linkInput());
  assert.equal(link.lastSyncAt, null);
  await store.touchLinkSynced(link.id, new Date("2026-08-04T12:00:00.000Z"));
  assert.equal((await store.findLinkByMerchant("521445"))?.lastSyncAt, "2026-08-04T12:00:00.000Z");
  await store.recordRun({ storeId: link.storeId, from: "2026-08-04", to: "2026-08-04", rows: 3, status: "ok" });
  await store.recordRun({ storeId: link.storeId, from: "2026-08-04", to: "2026-08-04", rows: 0, status: "error", error: "HTTP 401" });
  await store.recordWebhookInbox("tossplace", { merchantId: 521_445 });
  await store.close();
});

test("빈 행 배열은 아무것도 저장하지 않는다", async () => {
  const store = new MemoryPosStore();
  assert.equal(await store.recordSales("store-mapdal", [], "sync"), 0);
  assert.deepEqual(await store.dailyTotals("2026-01-01", "2026-12-31"), []);
});

/* ── 2단계: 상품·별칭 ── */

test("이름 직결 매칭: 매장 전용 상품이 공통 상품보다 우선한다", async () => {
  const store = new MemoryPosStore();
  const common = await store.createProduct({ name: "아메리카노", category: "음료", storeId: null, consumerPrice: 4_500 });
  const exclusive = await store.createProduct({ name: "아메리카노", category: "음료", storeId: "store-mapdal", consumerPrice: 5_000 });
  await store.recordSales("store-mapdal", [{ date: "2026-08-03", rawName: "아메리카노", qty: 1, amount: 5_000 }], "sync");
  await store.recordSales("store-doksan", [{ date: "2026-08-03", rawName: "아메리카노", qty: 1, amount: 4_500 }], "sync");
  assert.equal(await store.resolveUnmatched(), 2);
  const unmatched = await store.listUnmatched("2026-08-03", "2026-08-03");
  assert.equal(unmatched.length, 0);
  const dev = await store.priceDeviations("2026-08-03", "2026-08-03", 0);
  assert.equal(dev.find((d) => d.storeId === "store-mapdal")?.productId, exclusive.id, "맵달은 전용 상품으로");
  assert.equal(dev.find((d) => d.storeId === "store-doksan")?.productId, common.id, "독산은 공통 상품으로");
});

test("전용 상품 별칭은 그 매장 매출만 소급 매핑한다 (오귀속 차단)", async () => {
  const store = new MemoryPosStore();
  const exclusive = await store.createProduct({ name: "콜드브루", category: "음료", storeId: "store-mapdal", consumerPrice: 5_500 });
  const rows = [{ date: "2026-08-03", rawName: "ICE 브루잉커피", qty: 2, amount: 11_000 }];
  await store.recordSales("store-mapdal", rows, "sync");
  await store.recordSales("store-doksan", rows, "sync");
  const { scopeStoreId, relinked } = await store.upsertAlias("ICE 브루잉커피", exclusive.id);
  assert.equal(scopeStoreId, "store-mapdal");
  assert.equal(relinked, 1, "타 매장 동명 매출은 건드리지 않는다");
  const unmatched = await store.listUnmatched("2026-08-03", "2026-08-03");
  assert.deepEqual(unmatched.map((u) => u.storeId), ["store-doksan"]);
});

test("별칭 해제는 해당 스코프만 미매칭으로 원복한다", async () => {
  const store = new MemoryPosStore();
  const product = await store.createProduct({ name: "봉투포장", category: "기타", storeId: null, consumerPrice: 100 });
  await store.recordSales("store-mapdal", [{ date: "2026-08-03", rawName: "봉투", qty: 3, amount: 300 }], "sync");
  const { aliasId, relinked } = await store.upsertAlias("봉투", product.id);
  assert.equal(relinked, 1);
  const removed = await store.removeAlias(aliasId);
  assert.deepEqual(removed, { reverted: 1 });
  assert.equal((await store.listUnmatched("2026-08-03", "2026-08-03")).length, 1);
  assert.equal(await store.removeAlias(aliasId), null, "이미 지운 별칭은 null");
});

test("정규화: 공백·대소문자가 달라도 같은 별칭으로 본다", async () => {
  const store = new MemoryPosStore();
  const product = await store.createProduct({ name: "1 DONUT + 1 COFFEE", category: "세트", storeId: null, consumerPrice: 7_000 });
  await store.recordSales("store-mapdal", [{ date: "2026-08-03", rawName: "1 donut + 1 coffee", qty: 1, amount: 7_000 }], "sync");
  assert.equal(await store.resolveUnmatched(), 1, "이름 직결도 정규화 기준으로 매칭");
  assert.equal((await store.upsertAlias("1 DONUT + 1 COFFEE", product.id)).relinked, 1);
});

test("유사도 제안: 타 매장 전용 상품은 제안에서 제외한다", async () => {
  const store = new MemoryPosStore();
  await store.createProduct({ name: "그린티초코", category: "도넛", storeId: "store-doksan", consumerPrice: 4_100 });
  await store.recordSales("store-mapdal", [{ date: "2026-08-03", rawName: "그린티초코도넛", qty: 1, amount: 4_100 }], "sync");
  const [item] = await store.listUnmatched("2026-08-03", "2026-08-03");
  assert.equal(item?.suggestion, null, "독산 전용 상품을 맵달 미매칭에 제안하면 안 된다");
  await store.createProduct({ name: "그린티초코", category: "도넛", storeId: null, consumerPrice: 4_100 });
  const [again] = await store.listUnmatched("2026-08-03", "2026-08-03");
  assert.ok((again?.suggestion?.similarity ?? 0) >= 60, "공통 상품은 제안된다");
});

test("가격 편차: 임계값 이상만, 절대값 내림차순", async () => {
  const store = new MemoryPosStore();
  const cinnamon = await store.createProduct({ name: "시나몬슈가", category: "도넛", storeId: null, consumerPrice: 3_400 });
  const plain = await store.createProduct({ name: "플레인", category: "도넛", storeId: null, consumerPrice: 3_000 });
  await store.recordSales("store-doksan", [
    { date: "2026-08-03", rawName: "시나몬슈가", qty: 10, amount: 37_130 }, /* +9.2% */
    { date: "2026-08-03", rawName: "플레인", qty: 10, amount: 30_000 },    /* 0% */
  ], "sync");
  await store.resolveUnmatched();
  const deviations = await store.priceDeviations("2026-08-03", "2026-08-03", 3);
  assert.equal(deviations.length, 1);
  assert.equal(deviations[0]?.productId, cinnamon.id);
  assert.equal(deviations[0]?.deviationPct, 9.2);
  assert.equal((await store.priceDeviations("2026-08-03", "2026-08-03", 0)).find((d) => d.productId === plain.id)?.deviationPct, 0);
});

test("상품 수정: 카테고리·스코프·소비자가", async () => {
  const store = new MemoryPosStore();
  const product = await store.createProduct({ name: "냉동 고메도넛 세트", category: "도넛", storeId: null, consumerPrice: 23_100 });
  const updated = await store.updateProduct(product.id, { category: "세트", storeId: "store-mapdal", consumerPrice: 22_000 });
  assert.equal(updated?.category, "세트");
  assert.equal(updated?.storeId, "store-mapdal");
  assert.equal(updated?.consumerPrice, 22_000);
  assert.equal(await store.updateProduct("없는-id", { category: "도넛" }), null);
});

/* ── 3단계: 매출현황 리포트 ── */

test("주 단위 버킷은 KST 월요일에서 시작한다 (일요일은 전주)", async () => {
  const { weekStartMonday } = await import("./pos.ts");
  assert.equal(weekStartMonday("2026-08-03"), "2026-08-03", "월요일은 자기 자신");
  assert.equal(weekStartMonday("2026-08-02"), "2026-07-27", "일요일은 전주 월요일");
  assert.equal(weekStartMonday("2026-08-09"), "2026-08-03", "다음 일요일도 같은 주");
});

test("리포트: 매장 피벗·품목 드릴다운 합계가 행 합계와 일치한다", async () => {
  const store = new MemoryPosStore();
  const donut = await store.createProduct({ name: "우유크림도넛", category: "도넛", storeId: null, consumerPrice: 4_200 });
  await store.recordSales("store-mapdal", [
    { date: "2026-08-03", rawName: "우유크림도넛", qty: 5, amount: 21_000 },
    { date: "2026-08-03", rawName: "미확인신메뉴", qty: 1, amount: 3_000 },
  ], "sync");
  await store.recordSales("store-doksan", [
    { date: "2026-08-03", rawName: "우유크림도넛", qty: 2, amount: 8_400 },
    { date: "2026-08-04", rawName: "우유크림도넛", qty: 1, amount: 4_200 },
  ], "sync");
  await store.resolveUnmatched();
  const report = await store.report("2026-08-03", "2026-08-04", "day");
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0]?.bucket, "2026-08-04", "최신 우선 정렬");
  const day3 = report.rows[1]!;
  assert.deepEqual(day3.total, { qty: 8, amount: 32_400 });
  assert.deepEqual(day3.perStore["store-mapdal"], { qty: 6, amount: 24_000 });
  const mixSum = day3.mix.reduce((a, m) => a + m.amount, 0);
  assert.equal(mixSum, day3.total.amount, "드릴다운 합 = 행 합");
  const donutMix = day3.mix.find((m) => m.productId === donut.id)!;
  assert.equal(donutMix.name, "우유크림도넛");
  assert.deepEqual(donutMix.stores.find((s2) => s2.storeId === "store-doksan"), { storeId: "store-doksan", qty: 2, amount: 8_400 });
  assert.equal(day3.mix.find((m) => m.productId === null)?.name, "미매칭(기타)");
});

test("리포트: 주 단위 집계와 매장·품목 필터", async () => {
  const store = new MemoryPosStore();
  const donut = await store.createProduct({ name: "우유크림도넛", category: "도넛", storeId: null, consumerPrice: 4_200 });
  await store.recordSales("store-mapdal", [
    { date: "2026-08-02", rawName: "우유크림도넛", qty: 1, amount: 4_200 }, /* 일요일 → 07-27 주 */
    { date: "2026-08-03", rawName: "우유크림도넛", qty: 2, amount: 8_400 }, /* 월요일 → 08-03 주 */
    { date: "2026-08-03", rawName: "미확인", qty: 1, amount: 1_000 },
  ], "sync");
  await store.recordSales("store-doksan", [
    { date: "2026-08-03", rawName: "우유크림도넛", qty: 3, amount: 12_600 },
  ], "sync");
  await store.resolveUnmatched();
  const weekly = await store.report("2026-08-01", "2026-08-09", "week");
  assert.deepEqual(weekly.rows.map((r) => r.bucket), ["2026-08-03", "2026-07-27"]);
  assert.equal(weekly.rows[0]?.label, "08/03~08/09");
  const filtered = await store.report("2026-08-01", "2026-08-09", "day",
    { storeIds: ["store-mapdal"], productIds: [donut.id] });
  assert.deepEqual(filtered.storeIds, ["store-mapdal"]);
  assert.equal(filtered.rows.reduce((a, r) => a + r.total.qty, 0), 3, "타 매장·미매칭 제외");
  const monthly = await store.report("2026-08-01", "2026-08-09", "month");
  assert.equal(monthly.rows[0]?.bucket, "2026-08");
});

/* ── 4단계: 폐기 산출 (입고 − 판매) ── */

const wasteFixture = async () => {
  const store = new MemoryPosStore();
  const donut = await store.createProduct({ name: "우유크림도넛", category: "도넛", storeId: null, consumerPrice: 4_200 });
  const pistachio = await store.createProduct({ name: "버터피스타치오", category: "도넛", storeId: null, consumerPrice: 5_800 });
  await store.recordSales("store-doksan", [
    { date: "2026-08-03", rawName: "우유크림도넛", qty: 60, amount: 252_000 },
    { date: "2026-08-03", rawName: "버터피스타치오", qty: 30, amount: 174_000 },
  ], "sync");
  await store.resolveUnmatched();
  return { store, donut, pistachio };
};

test("입고 기록이 없으면 폐기·폐기율·로스를 N/A(null)로 둔다", async () => {
  const { store } = await wasteFixture();
  const report = await store.wasteReport("store-doksan", "2026-08-03");
  assert.equal(report.hasReceipt, false);
  assert.equal(report.hasPos, true);
  assert.equal(report.totals.received, null);
  assert.equal(report.totals.waste, null);
  assert.equal(report.totals.wasteRatePct, null);
  assert.equal(report.totals.lossAmount, null);
  assert.equal(report.totals.sold, 90, "판매는 아는 값이므로 그대로 보고한다");
  assert.ok(report.items.every((i) => i.received === null && i.waste === null && i.wasteRatePct === null));
});

test("폐기 = 입고 − 판매, 로스는 공급단가 스냅샷으로 평가한다", async () => {
  const { store, donut, pistachio } = await wasteFixture();
  store.seedReceipt("store-doksan", "2026-08-03", [
    { productId: donut.id, productName: "우유크림도넛", quantity: 70, unitSupply: 2_016 },
    { productId: pistachio.id, productName: "버터피스타치오", quantity: 30, unitSupply: 2_784 },
  ]);
  const report = await store.wasteReport("store-doksan", "2026-08-03");
  const donutRow = report.items.find((i) => i.productId === donut.id)!;
  assert.deepEqual(
    { received: donutRow.received, sold: donutRow.sold, waste: donutRow.waste, rate: donutRow.wasteRatePct, loss: donutRow.lossAmount },
    { received: 70, sold: 60, waste: 10, rate: 14.3, loss: 20_160 });
  assert.equal(report.items.find((i) => i.productId === pistachio.id)?.waste, 0, "정확히 소진되면 폐기 0");
  assert.deepEqual(report.totals, { received: 100, sold: 90, waste: 10, wasteRatePct: 10, lossAmount: 20_160 });
  assert.equal(report.items[0]?.productId, donut.id, "로스 금액 내림차순");
});

test("판매가 입고를 초과하면 폐기 0·초과분을 이상신호로 표기한다", async () => {
  const { store, donut } = await wasteFixture();
  store.seedReceipt("store-doksan", "2026-08-03", [
    { productId: donut.id, productName: "우유크림도넛", quantity: 50, unitSupply: 2_016 },
  ]);
  const report = await store.wasteReport("store-doksan", "2026-08-03");
  const donutRow = report.items.find((i) => i.productId === donut.id)!;
  assert.equal(donutRow.waste, 0);
  assert.equal(donutRow.over, 10, "전일 재고 이월 또는 기록 오류 신호");
  assert.equal(donutRow.lossAmount, 0);
  const pistachioRow = report.items.find((i) => i.productId !== donut.id)!;
  assert.equal(pistachioRow.received, null, "입고 라인이 없는 품목은 개별 N/A");
  assert.equal(pistachioRow.waste, null);
});

test("입고만 있고 판매가 없으면 전량 폐기로 계산한다", async () => {
  const store = new MemoryPosStore();
  const product = await store.createProduct({ name: "신메뉴", category: "도넛", storeId: null, consumerPrice: 4_000 });
  store.seedReceipt("store-mapdal", "2026-08-04", [
    { productId: product.id, productName: "신메뉴", quantity: 12, unitSupply: 1_900 },
  ]);
  const report = await store.wasteReport("store-mapdal", "2026-08-04");
  assert.equal(report.hasPos, false);
  assert.deepEqual(report.totals, { received: 12, sold: 0, waste: 12, wasteRatePct: 100, lossAmount: 22_800 });
});

test("다른 매장·다른 일자의 입고가 섞이지 않는다", async () => {
  const { store, donut } = await wasteFixture();
  store.seedReceipt("store-mapdal", "2026-08-03", [
    { productId: donut.id, productName: "우유크림도넛", quantity: 999, unitSupply: 2_016 },
  ]);
  store.seedReceipt("store-doksan", "2026-08-04", [
    { productId: donut.id, productName: "우유크림도넛", quantity: 888, unitSupply: 2_016 },
  ]);
  const report = await store.wasteReport("store-doksan", "2026-08-03");
  assert.equal(report.hasReceipt, false, "해당 매장·일자 입고만 본다");
});

test("productTotals는 상품 매칭된 판매만 매장×상품으로 합산한다 (월별 정산 로스 계산용)", async () => {
  const store = new MemoryPosStore();
  await store.recordSales("store-mapdal", ROWS, "sync");
  await store.recordSales("store-doksan", [{ date: "2026-08-03", rawName: "우유크림도넛", qty: 3, amount: 12_600 }], "sync");
  assert.deepEqual(await store.productTotals("2026-08-01", "2026-08-31"), [], "매칭 전에는 비어 있다");
  const donut = await store.createProduct({ name: "우유크림도넛", category: "도넛", storeId: null, consumerPrice: 4_200 });
  await store.resolveUnmatched();
  const totals = await store.productTotals("2026-08-01", "2026-08-31");
  assert.equal(totals.length, 2, "두 매장 각각 한 행");
  const mapdal = totals.find((row) => row.storeId === "store-mapdal");
  assert.deepEqual(mapdal, { storeId: "store-mapdal", productId: donut.id, qty: 5, amount: 21_000 });
  assert.deepEqual(await store.productTotals("2026-09-01", "2026-09-30"), [], "기간 밖은 제외");
});
