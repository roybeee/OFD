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
