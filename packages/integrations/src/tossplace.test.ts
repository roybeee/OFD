import assert from "node:assert/strict";
import test from "node:test";

import { decryptPosSecret, encryptPosSecret, fetchTossDailyItems } from "./tossplace.ts";

const ORDERS = [
  { completedAt: "2026-08-03T02:10:00+09:00", lineItems: [
      { item: { title: "우유크림도넛" }, quantity: 2, itemPrice: { priceValue: 4200 } },
      { item: { title: "아메리카노" }, quantity: 1, itemPrice: { priceValue: 4500 },
        optionChoices: [{ priceValue: 500, quantity: 1 }], appliedDiscounts: [{ amount: 1000 }] }] },
  { completedAt: "2026-08-03T23:50:00+09:00", lineItems: [
      { item: { title: "우유크림도넛" }, quantity: 3, itemPrice: { priceValue: 4200 } }] },
  { completedAt: "2026-08-04T01:00:00+09:00", lineItems: [
      { item: { title: "버터피스타치오" }, quantity: 1, itemPrice: { priceValue: 5800 } }] },
  { completedAt: "2026-08-05T01:00:00+09:00", lineItems: [
      { item: { title: "범위밖" }, quantity: 9, itemPrice: { priceValue: 1000 } }] },
];

const stubFetch = (orders: unknown[], calls: string[] = []): typeof fetch =>
  (async (url: string | URL) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ resultType: "SUCCESS", success: { orders } }) } as Response;
  }) as unknown as typeof fetch;

const fetchRange = (orders: unknown[], calls?: string[]) => fetchTossDailyItems({
  merchantId: "521445", accessKey: "ak", secretKey: "sk",
  from: "2026-08-03", to: "2026-08-04",
  fetchImpl: stubFetch(orders, calls), sleepImpl: async () => {},
});

test("KST 일자 경계로 집계하고 금액에 옵션가·할인을 반영한다", async () => {
  const items = await fetchRange(ORDERS);
  const find = (date: string, rawName: string) => items.find((i) => i.date === date && i.rawName === rawName);
  assert.equal(find("2026-08-03", "우유크림도넛")?.qty, 5, "23:50 주문은 같은 KST 일자로 합산된다");
  assert.equal(find("2026-08-03", "우유크림도넛")?.amount, 21_000);
  assert.equal(find("2026-08-03", "아메리카노")?.amount, 4_000, "4500 + 옵션 500 - 할인 1000");
  assert.equal(find("2026-08-04", "버터피스타치오")?.qty, 1);
  assert.ok(!items.some((i) => i.rawName === "범위밖"), "요청 구간 밖 주문은 제외한다");
});

test("수량 0 이하와 품목명 없는 라인은 무시한다", async () => {
  const items = await fetchRange([{ completedAt: "2026-08-03T05:00:00+09:00", lineItems: [
    { item: { title: "정상" }, quantity: 1, itemPrice: { priceValue: 1000 } },
    { item: { title: "" }, quantity: 5, itemPrice: { priceValue: 1000 } },
    { item: { title: "수량0" }, quantity: 0, itemPrice: { priceValue: 1000 } },
  ] }]);
  assert.deepEqual(items.map((i) => i.rawName), ["정상"]);
});

test("할인이 판매가를 넘어도 음수 금액을 만들지 않는다", async () => {
  const items = await fetchRange([{ completedAt: "2026-08-03T05:00:00+09:00", lineItems: [
    { item: { title: "전액할인" }, quantity: 1, itemPrice: { priceValue: 3000 }, appliedDiscounts: [{ amount: 5000 }] },
  ] }]);
  assert.equal(items[0]?.amount, 0);
});

test("KST 경계를 포함하도록 조회 구간을 to+1일로 요청한다", async () => {
  const calls: string[] = [];
  await fetchRange(ORDERS, calls);
  assert.ok(calls[0]?.includes(`from=${encodeURIComponent("2026-08-03T00:00:00+09:00")}`));
  assert.ok(calls[0]?.includes(`to=${encodeURIComponent("2026-08-05T00:00:00+09:00")}`), "종료일 다음날 자정까지 조회한다");
});

/* 실서비스 404 회귀(2026-08-12): 실제 토스 경로는 /order/orders이고 from·to·orderStates
 * 파라미터를 쓴다 — V1 server.js tossFetchRange와 동일해야 수집이 된다. */
test("토스 주문 조회는 V1과 동일한 /order/orders 경로·파라미터로 호출한다", async () => {
  const calls: string[] = [];
  await fetchRange(ORDERS, calls);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/api-public/openapi/v1/merchants/521445/order/orders");
  assert.equal(url.searchParams.get("orderStates"), "COMPLETED");
  assert.equal(url.searchParams.get("sortOrder"), "ASC");
  assert.equal(url.searchParams.get("size"), "500");
  assert.equal(url.searchParams.get("page"), "1");
});

test("COMPLETED가 아닌 주문은 걸러지고 completedAt 없으면 createdAt으로 귀속한다", async () => {
  const items = await fetchRange([
    { orderState: "CANCELED", completedAt: "2026-08-03T05:00:00+09:00", lineItems: [
      { item: { title: "취소건" }, quantity: 1, itemPrice: { priceValue: 1000 } }] },
    { orderState: "COMPLETED", createdAt: "2026-08-03T06:00:00+09:00", lineItems: [
      { item: { title: "생성시각귀속" }, quantity: 2, itemPrice: { priceValue: 1000 } }] },
  ]);
  assert.ok(!items.some((i) => i.rawName === "취소건"));
  assert.equal(items.find((i) => i.rawName === "생성시각귀속")?.qty, 2);
});

test("SUCCESS 봉투가 아니면 오류를 던진다", async () => {
  const failing = (async () => ({ ok: true, json: async () => ({ resultType: "FAIL", error: { errorCode: "E1", reason: "권한 없음" } }) })) as unknown as typeof fetch;
  await assert.rejects(() => fetchTossDailyItems({
    merchantId: "1", accessKey: "a", secretKey: "b", from: "2026-08-03", to: "2026-08-03",
    fetchImpl: failing, sleepImpl: async () => {},
  }), /E1/);
});

test("POS 자격증명을 AES-256-GCM으로 왕복 암복호한다", () => {
  const key = "unit-test-encryption-key";
  const encrypted = encryptPosSecret("secret-value", key);
  assert.match(encrypted, /^p1:/);
  assert.equal(encrypted.split(":").length, 4);
  assert.equal(decryptPosSecret(encrypted, key), "secret-value");
  assert.notEqual(encryptPosSecret("secret-value", key), encrypted, "IV가 매번 달라야 한다");
});

test("위조된 암호문과 잘못된 키를 거부한다", () => {
  const key = "unit-test-encryption-key";
  const encrypted = encryptPosSecret("secret-value", key);
  assert.throws(() => decryptPosSecret(`${encrypted.slice(0, -4)}AAAA`, key));
  assert.throws(() => decryptPosSecret(encrypted, "다른키"));
  assert.throws(() => decryptPosSecret("bogus", key), /POS_SECRET_FORMAT/);
  assert.throws(() => encryptPosSecret("x", ""), /ENCRYPTION_KEY_REQUIRED/);
});

/* 공식 문서(docs.tossplace.com/reference/open-api/webhook.html)의 서명 예시를 그대로 회귀 벡터로 쓴다 */
test("웹훅 서명을 공식 문서 예시 벡터로 검증한다", async () => {
  const { verifyTossWebhookSignature } = await import("./tossplace.ts");
  const secret = "GA1k8THAGeGihd_Z0rW0MqpRTDQGYIktHBfmCWbsZn0";
  const timestamp = "1767225600000";
  const body = '{"id":"000000000000000000000000","type":"_test.v1","createdAt":"2026-01-01T00:00:00.000Z","merchantId":42,"app":"my-awesome-app","data": {}}';
  const signature = "v1=0398718113ed9a277320953cd613e4ecad4fed4a6dc843064ec311e14368774e";
  const now = Number(timestamp);
  assert.equal(verifyTossWebhookSignature(body, timestamp, signature, secret, now), true);
  /* 위변조·시계 어긋남·비밀키 오류는 전부 거부 */
  assert.equal(verifyTossWebhookSignature(body.replace("42", "43"), timestamp, signature, secret, now), false);
  assert.equal(verifyTossWebhookSignature(body, timestamp, "v1=deadbeef", secret, now), false);
  assert.equal(verifyTossWebhookSignature(body, timestamp, signature, "wrong-secret", now), false);
  assert.equal(verifyTossWebhookSignature(body, timestamp, signature, secret, now + 6 * 60_000), false);
  assert.equal(verifyTossWebhookSignature(body, "not-a-number", signature, secret, now), false);
});
