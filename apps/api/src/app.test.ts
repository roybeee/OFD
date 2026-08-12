import { createHmac } from "node:crypto";
import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import { MockObjectStorage } from "@ofd/integrations";
import { type OriginalDocument, type Shipment, type TaxInvoice } from "@ofd/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";

const openApps: FastifyInstance[] = [];
function todayInSeoul() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
async function demoApp(): Promise<FastifyInstance> {
  const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false });
  openApps.push(app);
  return app;
}
afterEach(async () => Promise.all(openApps.splice(0).map((app) => app.close())));

describe("OFD v2 API", () => {
  it("health와 demo bootstrap을 무인증으로 제공한다", async () => {
    const app = await demoApp();
    const health = await app.inject({ method: "GET", url: "/api/v2/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mode: "test", providerMode: "mock" });
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().currentActor.id).toBe(DEMO_IDS.owner);
    expect(bootstrap.json().products.length).toBeGreaterThan(0);
    expect(JSON.stringify(bootstrap.json())).not.toContain("passwordHash");
  });

  it("가맹 영업 파이프라인은 숙려기간을 서버에서 강제하고 override는 사후기록을 남긴다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };

    const created = await app.inject({ method: "POST", url: "/api/v2/leads", headers: master,
      payload: { name: "김가맹", phone: "010-1234-5678", area: "수원 영통", storeName: "영통점" } });
    expect(created.statusCode).toBe(201);
    const leadId = (created.json() as { lead: { id: string; stage: number } }).lead.id;

    /* 리드(0) → 상담(1) → 정보공개서 제공(2)까지는 게이트 없음 */
    for (const _ of [0, 1]) {
      const moved = await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} });
      expect(moved.statusCode).toBe(200);
    }
    /* 제공일 없이 가맹계약 진입 시도 → 입력 요구 */
    const noDoc = await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} });
    expect(noDoc.statusCode).toBe(422);
    expect(noDoc.json()).toMatchObject({ error: { code: "COOLING_DOC_DATE_REQUIRED" } });

    /* 오늘 제공 → 14일 미경과이므로 409 + 개방일 안내 */
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    await app.inject({ method: "PATCH", url: `/api/v2/leads/${leadId}`, headers: master, payload: { docDate: today } });
    const blocked = await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "COOLING", details: { days: 14 } } });

    /* override → 통과하되 flag가 서고 감사에 사후기록이 남는다 */
    const forced = await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: { override: true } });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ lead: { stage: 3, flag: true } });
    const audit = await app.inject({ method: "GET", url: "/api/v2/audit?q=숙려", headers: master });
    expect((audit.json() as { total: number }).total).toBe(1);

    /* 실사·공사(4) → 오픈완료(5)에서 가맹 매장이 대장에 자동 등록된다 */
    await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} });
    const opened = await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} });
    expect(opened.statusCode).toBe(200);
    const body = opened.json() as { lead: { stage: number; storeId: string | null }; createdStoreId?: string };
    expect(body.lead.stage).toBe(5);
    expect(body.createdStoreId).toBeTruthy();
    expect(body.lead.storeId).toBe(body.createdStoreId);
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    const stores = (bootstrap.json() as { stores: Array<{ id: string; name: string; storeKind?: string }> }).stores;
    expect(stores.find((store) => store.id === body.createdStoreId)).toMatchObject({ name: "영통점", storeKind: "가맹" });

    /* 단계 범위를 넘어서면 거부하고, 점주는 접근 자체가 막힌다 */
    expect((await app.inject({ method: "POST", url: `/api/v2/leads/${leadId}/stage`, headers: master, payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/v2/leads", headers: { "x-demo-actor-id": DEMO_IDS.owner } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v2/leads/${leadId}`, headers: master })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/v2/leads/${leadId}`, headers: master })).statusCode).toBe(404);
  });

  it("토스플레이스 앱 설치 웹훅이 merchantId를 자동 수집하고 연동 등록 시 목록에서 사라진다", async () => {
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
      ENCRYPTION_KEY: "test-encryption-key-32chars-min!!" }, logger: false });
    openApps.push(app);
    const master = { "x-demo-actor-id": DEMO_IDS.master };
    const install = (id: string, merchantId: number) => app.inject({ method: "POST", url: "/api/v2/webhooks/tossplace",
      headers: { "x-toss-webhook-id": id },
      payload: { id, type: "app.installation.created.v1", createdAt: "2026-08-12T00:00:00Z", merchantId, app: "ofd", data: {} } });

    const first = await install("wh-1", 4242);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, merchantId: "4242", known: false, discovered: true });
    /* at-least-once 재전송은 x-toss-webhook-id로 멱등 처리 */
    await install("wh-1", 4242);
    const list = await app.inject({ method: "GET", url: "/api/v2/pos/discovered", headers: master });
    expect((list.json() as { merchants: Array<{ merchantId: string }> }).merchants).toEqual([
      expect.objectContaining({ merchantId: "4242", eventType: "app.installation.created.v1" }),
    ]);

    /* 발견된 ID를 매장과 연동하면 pending 목록에서 사라진다 */
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    const storeId = (bootstrap.json() as { stores: Array<{ id: string }> }).stores[0]!.id;
    const linked = await app.inject({ method: "POST", url: "/api/v2/pos/links", headers: master,
      payload: { storeId, merchantId: "4242", accessKey: "ak", secretKey: "sk" } });
    expect(linked.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/discovered", headers: master })
      .then((res) => res.json() as { merchants: unknown[] })).merchants).toHaveLength(0);

    /* 이미 연동된 매장의 재설치 웹훅은 pending으로 돌아오지 않는다 */
    await install("wh-2", 4242);
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/discovered", headers: master })
      .then((res) => res.json() as { merchants: unknown[] })).merchants).toHaveLength(0);

    /* 설치 외 이벤트는 수집하지 않고, 점주는 목록 조회가 막힌다 */
    await app.inject({ method: "POST", url: "/api/v2/webhooks/tossplace", headers: { "x-toss-webhook-id": "wh-3" },
      payload: { id: "wh-3", type: "order.created.v1", merchantId: 9999, data: {} } });
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/discovered", headers: master })
      .then((res) => res.json() as { merchants: unknown[] })).merchants).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/discovered",
      headers: { "x-demo-actor-id": DEMO_IDS.owner } })).statusCode).toBe(403);
  });

  it("웹훅 서명 secret이 설정되면 서명이 틀린 요청을 401로 거부한다", async () => {
    const secret = "GA1k8THAGeGihd_Z0rW0MqpRTDQGYIktHBfmCWbsZn0";
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
      TOSSPLACE_WEBHOOK_SECRET: secret }, logger: false });
    openApps.push(app);
    const rawBody = JSON.stringify({ id: "wh-sig", type: "app.installation.created.v1", merchantId: 7, data: {} });
    const timestamp = String(Date.now());
    const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
    const ok = await app.inject({ method: "POST", url: "/api/v2/webhooks/tossplace",
      headers: { "content-type": "application/json", "x-toss-webhook-id": "wh-sig",
        "x-toss-timestamp": timestamp, "x-toss-signature": signature },
      payload: rawBody });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, discovered: true });
    const forged = await app.inject({ method: "POST", url: "/api/v2/webhooks/tossplace",
      headers: { "content-type": "application/json", "x-toss-timestamp": timestamp, "x-toss-signature": "v1=00" },
      payload: rawBody });
    expect(forged.statusCode).toBe(401);
  });

  it("매출현황 매장 등록은 마스터만 가능하고 store 스냅샷에 자기 스코프를 남긴다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };
    /* aggregate_store_scope_required 회귀 — storeId 스코프 없이 commit하면 memory/postgres 모두 500이 난다 */
    const created = await app.inject({ method: "POST", url: "/api/v2/pos/stores", headers: master,
      payload: { name: "수성점", storeKind: "직영", billingCycle: "monthly", paymentMethod: "monthly_credit", notificationPhone: "010-7191-5280" } });
    expect(created.statusCode).toBe(201);
    const storeId = (created.json() as { store: { id: string } }).store.id;
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    expect((bootstrap.json() as { stores: Array<{ id: string }> }).stores.some((store) => store.id === storeId)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/v2/pos/stores",
      headers: { "x-demo-actor-id": DEMO_IDS.owner }, payload: { name: "무단점" } })).statusCode).toBe(403);
  });

  it("매장 대장 수정은 변경 항목만 감사에 남기고 버전 충돌을 막는다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };
    const before = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    const store = (before.json() as { stores: Array<{ id: string; name: string }> }).stores[0]!;

    const patched = await app.inject({ method: "PATCH", url: `/api/v2/pos/stores/${store.id}`, headers: master,
      payload: { storeKind: "직영", region: "서울 금천", openDate: "2026-03-02", notificationPhone: "010-2222-3333" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ store: { storeKind: "직영", region: "서울 금천", openDate: "2026-03-02", notificationPhone: "01022223333" } });
    expect((patched.json() as { changed: string[] }).changed.sort()).toEqual(["notificationPhone", "openDate", "region", "storeKind"]);

    /* 같은 값 재전송은 변경 없음으로 처리해 감사 로그를 오염시키지 않는다 */
    const noop = await app.inject({ method: "PATCH", url: `/api/v2/pos/stores/${store.id}`, headers: master, payload: { storeKind: "직영" } });
    expect(noop.json()).toMatchObject({ changed: [] });

    /* 낡은 버전으로 쓰면 409 */
    const stale = await app.inject({ method: "PATCH", url: `/api/v2/pos/stores/${store.id}`, headers: master,
      payload: { expectedVersion: 1, region: "부산" } });
    expect(stale.statusCode).toBe(409);

    expect((await app.inject({ method: "PATCH", url: `/api/v2/pos/stores/${store.id}`, headers: master, payload: { openDate: "2026-3-2" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PATCH", url: "/api/v2/pos/stores/없음", headers: master, payload: { region: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/v2/pos/stores/${store.id}`, headers: { "x-demo-actor-id": DEMO_IDS.owner }, payload: { region: "x" } })).statusCode).toBe(403);
  });

  it("공지와 지도 키를 관리하고 감사 검색은 필터를 적용한다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };
    const created = await app.inject({ method: "POST", url: "/api/v2/notices", headers: master,
      payload: { title: "광복절 배송 휴무", body: "8/15 배송 없음", pinned: true } });
    expect(created.statusCode).toBe(201);
    const noticeId = (created.json() as { notice: { id: string } }).notice.id;
    /* 공지는 점주 화면 배너에 쓰므로 조회는 열려 있고 관리는 본사만 */
    const seen = await app.inject({ method: "GET", url: "/api/v2/notices", headers: { "x-demo-actor-id": DEMO_IDS.owner } });
    expect((seen.json() as { notices: Array<{ title: string }> }).notices[0]).toMatchObject({ title: "광복절 배송 휴무", pinned: true });
    expect((await app.inject({ method: "POST", url: "/api/v2/notices", headers: { "x-demo-actor-id": DEMO_IDS.owner }, payload: { title: "무단 공지" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v2/notices", headers: master, payload: { title: "짧" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "DELETE", url: `/api/v2/notices/${noticeId}`, headers: master })).statusCode).toBe(200);

    await app.inject({ method: "PUT", url: "/api/v2/pos/config/navermap", headers: master, payload: { keyId: "naver-key-1" } });
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/config/navermap", headers: master })).json()).toEqual({ keyId: "naver-key-1" });
    expect((await app.inject({ method: "PUT", url: "/api/v2/pos/config/navermap", headers: { "x-demo-actor-id": DEMO_IDS.ops }, payload: { keyId: "x" } })).statusCode).toBe(403);

    const search = await app.inject({ method: "GET", url: "/api/v2/audit?q=notice&limit=1", headers: master });
    expect(search.statusCode).toBe(200);
    const result = search.json() as { rows: Array<{ action: string }>; total: number };
    expect(result.total).toBeGreaterThanOrEqual(2); // 생성·삭제
    expect(result.rows.length).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/v2/audit", headers: { "x-demo-actor-id": DEMO_IDS.owner } })).statusCode).toBe(403);
    const future = await app.inject({ method: "GET", url: "/api/v2/audit?from=2030-01-01", headers: master });
    expect((future.json() as { total: number }).total).toBe(0);
  });

  it("월별 정산 집계(V1 정산 탭 이식)를 재무·마스터에게 제공하고 점주는 차단한다", async () => {
    const app = await demoApp();
    const summary = await app.inject({ method: "GET", url: "/api/v2/settlements/monthly?month=2026-07",
      headers: { "x-demo-actor-id": DEMO_IDS.master } });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as { month: string; rows: Array<Record<string, unknown>>; totals: Record<string, unknown> };
    expect(body.month).toBe("2026-07");
    const doksan = body.rows.find((row) => row.name === "독산점");
    /* 데모 시드: 2026-07-30(KST) 확정 입고 1건 + 7월 귀속 정산 1건 + reviewed 계산서 1건 */
    expect(doksan).toMatchObject({ receiptCount: 1, settlementCount: 1 });
    expect((doksan as { supplyConfirmed: number }).supplyConfirmed).toBeGreaterThan(0);
    expect((doksan as { invoiceSummary: { total: number; inProgress: number } }).invoiceSummary).toMatchObject({ total: 1, inProgress: 1 });
    /* 배송 라인 4개(브리오슈2+원두2) 입고, POS 판매 없음 → 로스 100% */
    expect(doksan).toMatchObject({ receivedQty: 4, soldQty: 0, wasteQty: 4, lossRate: 100 });
    /* 입고가 없는 매장은 로스율을 단정하지 않는다 */
    const hapjeong = body.rows.find((row) => row.name === "합정점");
    expect(hapjeong).toMatchObject({ receivedQty: null, lossRate: null });
    expect(body.totals).toMatchObject({ receiptCount: 1, settlementCount: 1 });

    const denied = await app.inject({ method: "GET", url: "/api/v2/settlements/monthly",
      headers: { "x-demo-actor-id": DEMO_IDS.owner } });
    expect(denied.statusCode).toBe(403);

    const badMonth = await app.inject({ method: "GET", url: "/api/v2/settlements/monthly?month=2026-13",
      headers: { "x-demo-actor-id": DEMO_IDS.finance } });
    expect(badMonth.statusCode).toBe(200);
    expect((badMonth.json() as { month: string }).month).toMatch(/^\d{4}-\d{2}$/); // 잘못된 값은 현재 월로 폴백
  });

  it("개인 이메일 로그인은 본사 계정도 MFA 없이 비밀번호만으로 HttpOnly 세션을 발급한다", async () => {
    const app = await demoApp();
    const storeLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } });
    expect(storeLogin.statusCode).toBe(200);
    expect(storeLogin.json()).toMatchObject({ authenticated: true, mfaRequired: false });
    expect(storeLogin.headers["set-cookie"]).toContain("HttpOnly");
    expect(storeLogin.headers["set-cookie"]).toContain("SameSite=Strict");

    const hqLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.finance@ofd.local", password: "OFD-demo-2026!" } });
    expect(hqLogin.statusCode).toBe(200);
    expect(hqLogin.json()).toMatchObject({ authenticated: true, mfaRequired: false });
    expect(hqLogin.headers["set-cookie"]).toContain("HttpOnly");

    // MFA 엔드포인트는 제거됐다
    const gone = await app.inject({ method: "POST", url: "/api/v2/auth/mfa", payload: { challengeToken: "x", code: "000000" } });
    expect(gone.statusCode).toBe(404);
  });

  it("자동 로그인 세션은 스텝업·비밀번호 변경으로 갱신돼도 30일 유지가 승계된다", async () => {
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
      TEST_AUTH_REQUIRED: "true", SESSION_SECRET: "test-session-secret-with-at-least-32-characters" }, logger: false });
    openApps.push(app);
    const thirtyDays = `Max-Age=${30 * 24 * 60 * 60}`;

    /* 자동 로그인 세션 → 스텝업 후에도 30일 쿠키 유지 */
    const remembered = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.master@ofd.local", password: "OFD-demo-2026!", rememberMe: true } });
    expect(String(remembered.headers["set-cookie"])).toContain(thirtyDays);
    const rememberedCookie = String(remembered.headers["set-cookie"] ?? "").split(";")[0];
    const steppedUp = await app.inject({ method: "POST", url: "/api/v2/auth/step-up",
      headers: { cookie: rememberedCookie }, payload: { password: "OFD-demo-2026!" } });
    expect(steppedUp.statusCode).toBe(200);
    expect(String(steppedUp.headers["set-cookie"])).toContain(thirtyDays);

    /* 자동 로그인 세션에서 비밀번호를 바꿔도 30일 쿠키 유지 */
    const stepped = String(steppedUp.headers["set-cookie"] ?? "").split(";")[0];
    const changed = await app.inject({ method: "POST", url: "/api/v2/auth/change-password",
      headers: { cookie: stepped }, payload: { currentPassword: "OFD-demo-2026!", newPassword: "Rotated-Pass-2026!" } });
    expect(changed.statusCode).toBe(200);
    expect(String(changed.headers["set-cookie"])).toContain(thirtyDays);

    /* 일반 세션은 스텝업 후에도 브라우저 세션 쿠키(Max-Age 없음) 그대로 */
    const plain = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.finance@ofd.local", password: "OFD-demo-2026!" } });
    expect(String(plain.headers["set-cookie"])).not.toContain("Max-Age");
    const plainCookie = String(plain.headers["set-cookie"] ?? "").split(";")[0];
    const plainStepUp = await app.inject({ method: "POST", url: "/api/v2/auth/step-up",
      headers: { cookie: plainCookie }, payload: { password: "OFD-demo-2026!" } });
    expect(plainStepUp.statusCode).toBe(200);
    expect(String(plainStepUp.headers["set-cookie"])).not.toContain("Max-Age");
  });

  it("자동 로그인(rememberMe) 선택 시 30일 유지 쿠키, 미선택 시 브라우저 종료로 만료되는 세션 쿠키를 발급한다", async () => {
    const app = await demoApp();
    const plain = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } });
    expect(plain.statusCode).toBe(200);
    expect(String(plain.headers["set-cookie"])).not.toContain("Max-Age");

    const remembered = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!", rememberMe: true } });
    expect(remembered.statusCode).toBe(200);
    expect(String(remembered.headers["set-cookie"])).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("requires a signed session in the isolated test stack when TEST_AUTH_REQUIRED is enabled", async () => {
    const app = await buildApp({ env: {
      APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent", TEST_AUTH_REQUIRED: "true",
      SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    }, logger: false });
    openApps.push(app);

    const anonymous = await app.inject({ method: "GET", url: "/api/v2/bootstrap",
      headers: { "x-demo-actor-id": DEMO_IDS.driver } });
    expect(anonymous.statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } });
    const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0];
    const authenticated = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { cookie } });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().currentActor.id).toBe(DEMO_IDS.owner);
  });

  it("비밀번호 5회 실패로 잠긴 본사 계정은 정답 비밀번호로도 우회할 수 없다", async () => {
    const app = await demoApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({ method: "POST", url: "/api/v2/auth/login",
        payload: { email: "hq.finance@ofd.local", password: "wrong-password" } });
      expect(failed.statusCode).toBe(401);
      expect(failed.json().error.code).toBe("INVALID_CREDENTIALS");
    }

    const blocked = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.finance@ofd.local", password: "OFD-demo-2026!" } });
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error.code).toBe("ACCOUNT_LOCKED");
  });

  it("관리자 step-up 재인증 실패도 계정 잠금에 누적되어 무제한 추측을 차단한다", async () => {
    const app = await demoApp();
    const headers = { "x-demo-actor-id": DEMO_IDS.finance };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({ method: "POST", url: "/api/v2/auth/step-up", headers,
        payload: { password: "wrong-password" } });
      expect(failed.statusCode).toBe(401);
      expect(failed.json().error.code).toBe("INVALID_CREDENTIALS");
    }

    const blocked = await app.inject({ method: "POST", url: "/api/v2/auth/step-up", headers,
      payload: { password: "OFD-demo-2026!" } });
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error.code).toBe("ACCOUNT_LOCKED");
  });

  it("관리자가 발급한 초기 비밀번호는 본인이 바꾸기 전까지 업무 API를 막는다", async () => {
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
      TEST_AUTH_REQUIRED: "true", SESSION_SECRET: "test-session-secret-with-at-least-32-characters" }, logger: false });
    openApps.push(app);

    /* 마스터로 로그인해 새 계정을 만든다 */
    const masterLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "hq.master@ofd.local", password: "OFD-demo-2026!" } });
    expect(masterLogin.json()).toMatchObject({ authenticated: true, mustChangePassword: false });
    const masterCookie = String(masterLogin.headers["set-cookie"] ?? "").split(";")[0];
    const stepUp = await app.inject({ method: "POST", url: "/api/v2/auth/step-up", headers: { cookie: masterCookie },
      payload: { password: "OFD-demo-2026!" } });
    const steppedCookie = String(stepUp.headers["set-cookie"] ?? "").split(";")[0];
    const created = await app.inject({ method: "POST", url: "/api/v2/admin/actors",
      headers: { cookie: steppedCookie, "Idempotency-Key": "provision-first-login" },
      payload: { name: "신규 감사자", role: "auditor", storeIds: [], email: "auditor.new@ofd.local", password: "Initial-Pass-2026!" } });
    expect(created.statusCode).toBe(201);

    /* 새 계정 로그인 → 세션은 발급되지만 mustChangePassword가 참이고 업무 API는 403 */
    const firstLogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "auditor.new@ofd.local", password: "Initial-Pass-2026!" } });
    expect(firstLogin.statusCode).toBe(200);
    expect(firstLogin.json()).toMatchObject({ authenticated: true, mustChangePassword: true });
    const cookie = String(firstLogin.headers["set-cookie"] ?? "").split(";")[0];
    const blocked = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    /* 비밀번호 변경은 잠금 중에도 허용된다 → 이후 업무 API 정상 */
    const changed = await app.inject({ method: "POST", url: "/api/v2/auth/change-password", headers: { cookie },
      payload: { currentPassword: "Initial-Pass-2026!", newPassword: "Personal-Pass-2026!" } });
    expect(changed.statusCode).toBe(200);
    const newCookie = String(changed.headers["set-cookie"] ?? "").split(";")[0];
    const allowed = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { cookie: newCookie } });
    expect(allowed.statusCode).toBe(200);

    /* 바뀐 비밀번호로 다시 로그인하면 더 이상 강제 변경이 아니다 */
    const relogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "auditor.new@ofd.local", password: "Personal-Pass-2026!" } });
    expect(relogin.json()).toMatchObject({ authenticated: true, mustChangePassword: false });
  });

  it("계정 유형 변경은 권한·매장 배정을 갱신하고 세션을 폐기하며 안전장치를 지킨다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };
    const key = (value: string) => ({ ...master, "Idempotency-Key": value });

    const before = await app.inject({ method: "GET", url: "/api/v2/admin/actors", headers: master });
    const staff = (before.json() as { actors: Array<{ id: string; role: string; version: number }> }).actors
      .find((candidate) => candidate.id === DEMO_IDS.staff)!;
    expect(staff.role).toBe("store_staff");

    /* 매장 직원 → 본사 운영: 매장 배정은 비워야 하고, 권한이 본사 것으로 바뀐다 */
    const changed = await app.inject({ method: "PATCH", url: "/api/v2/admin/actors", headers: key("role-staff-ops"),
      payload: { action: "role", actorId: DEMO_IDS.staff, expectedVersion: staff.version, role: "hq_ops", storeIds: [] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ actor: { role: "hq_ops", storeIds: [], version: staff.version + 1 } });
    const afterCaps = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.staff } });
    expect(afterCaps.json().capabilities).toContain("hq.orders.read");
    expect(afterCaps.json().capabilities).not.toContain("store.orders.read");

    /* 낡은 버전으로는 실패(세션 폐기로 authVersion이 올랐다) */
    expect((await app.inject({ method: "PATCH", url: "/api/v2/admin/actors", headers: key("role-stale"),
      payload: { action: "role", actorId: DEMO_IDS.staff, expectedVersion: staff.version, role: "auditor", storeIds: [] } })).statusCode).toBe(409);

    /* 매장 역할로 되돌릴 때는 매장 배정이 필수 */
    const noStore = await app.inject({ method: "PATCH", url: "/api/v2/admin/actors", headers: key("role-nostore"),
      payload: { action: "role", actorId: DEMO_IDS.staff, expectedVersion: staff.version + 1, role: "store_owner", storeIds: [] } });
    expect(noStore.statusCode).toBe(400);
    expect(noStore.json().error.code).toBe("STORE_ASSIGNMENT_REQUIRED");

    /* 마지막 활성 최고관리자는 강등할 수 없다 */
    const masterRow = (before.json() as { actors: Array<{ id: string; version: number }> }).actors
      .find((candidate) => candidate.id === DEMO_IDS.master)!;
    const lastMaster = await app.inject({ method: "PATCH", url: "/api/v2/admin/actors", headers: key("role-last-master"),
      payload: { action: "role", actorId: DEMO_IDS.master, expectedVersion: masterRow.version, role: "hq_ops", storeIds: [] } });
    expect([409]).toContain(lastMaster.statusCode);

    /* 비마스터는 유형 변경 불가 */
    expect((await app.inject({ method: "PATCH", url: "/api/v2/admin/actors",
      headers: { "x-demo-actor-id": DEMO_IDS.finance, "Idempotency-Key": "role-forbidden" },
      payload: { action: "role", actorId: DEMO_IDS.staff, expectedVersion: staff.version + 1, role: "auditor", storeIds: [] } })).statusCode).toBe(403);
  });

  it("기타 관리는 마스터만 보이고, 메뉴 순서는 저장 후 모든 사용자 bootstrap에 실린다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };

    /* 마스터만 기타 관리(hq.settings.manage) 권한을 갖는다 */
    const masterBoot = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    expect(masterBoot.json().capabilities).toContain("hq.settings.manage");
    for (const actorId of [DEMO_IDS.ops, DEMO_IDS.finance, DEMO_IDS.auditor]) {
      const boot = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": actorId } });
      expect(boot.json().capabilities).not.toContain("hq.settings.manage");
    }

    /* 순서 저장 → bootstrap의 menuOrder에 반영(마스터가 아닌 사용자도 같은 순서를 받는다) */
    const saved = await app.inject({ method: "PUT", url: "/api/v2/admin/menu-order",
      headers: { ...master, "Idempotency-Key": "menu-order-1" },
      payload: { order: ["/hq/sales", "/hq/orders", "/nope/unknown"] } });
    expect(saved.statusCode).toBe(200);
    /* 카탈로그에 없는 경로는 버려진다 */
    expect(saved.json()).toMatchObject({ menuOrder: ["/hq/sales", "/hq/orders"] });
    const opsBoot = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.ops } });
    expect(opsBoot.json().menuOrder).toEqual(["/hq/sales", "/hq/orders"]);

    /* 페이지 노출 정책을 바꿔도 메뉴 순서는 보존된다 */
    await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy",
      headers: { ...master, "Idempotency-Key": "ap-keep-order" }, payload: { role: "hq_ops", pages: ["/hq/orders"] } });
    const afterPolicy = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: master });
    expect(afterPolicy.json().menuOrder).toEqual(["/hq/sales", "/hq/orders"]);

    /* 비마스터는 순서를 바꿀 수 없다 */
    expect((await app.inject({ method: "PUT", url: "/api/v2/admin/menu-order",
      headers: { "x-demo-actor-id": DEMO_IDS.ops, "Idempotency-Key": "menu-order-forbidden" },
      payload: { order: ["/hq/orders"] } })).statusCode).toBe(403);
  });

  it("계정 유형별·계정별 페이지 노출을 설정하면 로그인 capability에 반영된다", async () => {
    const app = await demoApp();
    const master = { "x-demo-actor-id": DEMO_IDS.master };

    // 기본: hq_ops는 매출현황 페이지를 본다(hq.pos.read)
    const before = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.ops } });
    expect(before.json().capabilities).toContain("hq.pos.read");

    // 역할(hq_ops)에서 매출/상품/오픈 페이지를 빼면 hq.pos.read가 사라진다
    const roleUpdate = await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy", headers: { ...master, "Idempotency-Key": "ap-role-ops-001" },
      payload: { role: "hq_ops", pages: ["/hq/orders", "/hq/delivery"] } });
    expect(roleUpdate.statusCode).toBe(200);
    const afterRole = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.ops } });
    expect(afterRole.json().capabilities).not.toContain("hq.pos.read");
    expect(afterRole.json().capabilities).toContain("hq.orders.read");

    // 계정별 지정이 역할 설정을 덮어써 그 계정만 매출현황을 되살린다
    const actorUpdate = await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy", headers: { ...master, "Idempotency-Key": "ap-actor-ops-001" },
      payload: { actorId: DEMO_IDS.ops, pages: ["/hq/orders", "/hq/sales"] } });
    expect(actorUpdate.statusCode).toBe(200);
    const afterActor = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.ops } });
    expect(afterActor.json().capabilities).toContain("hq.pos.read");

    // 영역 밖(store) 페이지는 hq 역할에 지정해도 무시된다
    const cross = await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy", headers: { ...master, "Idempotency-Key": "ap-role-fin-001" },
      payload: { role: "hq_finance", pages: ["/store/orders", "/hq/reconciliation"] } });
    expect(cross.statusCode).toBe(200);
    const finance = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.finance } });
    expect(finance.json().capabilities).toContain("hq.payments.reconcile");
    expect(finance.json().capabilities).not.toContain("store.orders.read");

    // 계정별 지정 해제(null)는 역할 설정으로 되돌린다
    await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy", headers: { ...master, "Idempotency-Key": "ap-actor-ops-reset" }, payload: { actorId: DEMO_IDS.ops, pages: null } });
    const reverted = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.ops } });
    expect(reverted.json().capabilities).not.toContain("hq.pos.read");

    // 비마스터는 설정 조회·변경 불가
    expect((await app.inject({ method: "GET", url: "/api/v2/admin/access-policy", headers: { "x-demo-actor-id": DEMO_IDS.ops } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/v2/admin/access-policy",
      headers: { "x-demo-actor-id": DEMO_IDS.finance, "Idempotency-Key": "ap-forbidden-001" }, payload: { role: "hq_ops", pages: [] } })).statusCode).toBe(403);
  });

  it("본인 비밀번호 변경은 현재 비밀번호를 확인하고 세션을 재발급하며 옛 비밀번호를 무효화한다", async () => {
    const app = await demoApp();
    const login = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } });
    const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0];

    // 현재 비밀번호가 틀리면 401
    const wrong = await app.inject({ method: "POST", url: "/api/v2/auth/change-password", headers: { cookie },
      payload: { currentPassword: "wrong-password", newPassword: "BrandNewPassword-2026!" } });
    expect(wrong.statusCode).toBe(401);

    // 같은 비밀번호로는 바꿀 수 없다
    const same = await app.inject({ method: "POST", url: "/api/v2/auth/change-password", headers: { cookie },
      payload: { currentPassword: "OFD-demo-2026!", newPassword: "OFD-demo-2026!" } });
    expect(same.statusCode).toBe(422);

    // 정상 변경 → 200 + 새 세션 쿠키 재발급
    const changed = await app.inject({ method: "POST", url: "/api/v2/auth/change-password", headers: { cookie },
      payload: { currentPassword: "OFD-demo-2026!", newPassword: "BrandNewPassword-2026!" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ changed: true });
    expect(changed.headers["set-cookie"]).toContain("HttpOnly");

    // 옛 비밀번호 로그인은 실패, 새 비밀번호는 성공
    expect((await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "OFD-demo-2026!" } })).json().error.code).toBe("INVALID_CREDENTIALS");
    const relogin = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "store.owner@ofd.local", password: "BrandNewPassword-2026!" } });
    expect(relogin.statusCode).toBe(200);
    expect(relogin.json()).toMatchObject({ authenticated: true });
  });

  it("배송 기사 bootstrap은 배정 배송에 필요한 정보 외 재무·타매장 정보를 노출하지 않는다", async () => {
    const app = await demoApp();
    const response = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.driver } });
    const body = response.json();
    expect(body.shipments.every((shipment: { driverId: string }) => shipment.driverId === DEMO_IDS.driver)).toBe(true);
    expect(body.bankTransactions).toEqual([]);
    expect(body.paymentRequests).toEqual([]);
    expect(body.settlements).toEqual([]);
    expect(body.taxInvoices).toEqual([]);
    expect(body.receipts).toEqual([]);
    const assignedOrderIds = new Set(body.shipments.map((shipment: { orderId: string }) => shipment.orderId));
    expect(body.orders.every((order: { id: string }) => assignedOrderIds.has(order.id))).toBe(true);
  });

  it("감사자는 비밀번호로 로그인해 전 매장 원장과 감사 이벤트를 읽되 운영 mutation은 수행하지 못한다", async () => {
    const app = await demoApp();
    const login = await app.inject({ method: "POST", url: "/api/v2/auth/login",
      payload: { email: "auditor@ofd.local", password: "OFD-demo-2026!" } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: true, mfaRequired: false });

    const headers = { "x-demo-actor-id": DEMO_IDS.auditor };
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().capabilities).toContain("hq.audit.read");
    expect(bootstrap.json().bankTransactions.length).toBeGreaterThan(0);
    expect(bootstrap.json().taxInvoices.length).toBeGreaterThan(0);
    expect(bootstrap.json().auditEvents).toBeDefined();

    const denied = await app.inject({ method: "POST", url: "/api/v2/orders/00000000-0000-4000-8000-000000003001/approve",
      headers: { ...headers, "idempotency-key": "auditor-cannot-approve" }, payload: { expectedVersion: 1 } });
    expect(denied.statusCode).toBe(403);
  });

  it("발주 생성과 멱등 재시도를 한 번만 처리한다", async () => {
    const app = await demoApp();
    /* 고정 날짜는 그 날이 오면 당일-발주 검증에 걸려 깨진다(date-rot) — 허용 배송일에서 동적으로 취한다 */
    const bootstrapForDate = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const requestedDeliveryDate = bootstrapForDate.json().allowedDeliveryDates[0] as string;
    const payload = {
      storeId: DEMO_IDS.storeDoksan, requestedDeliveryDate,
      items: [{ productId: DEMO_IDS.productBean, quantity: 2 }],
    };
    const headers = { "idempotency-key": "create-order-test" };
    const first = await app.inject({ method: "POST", url: "/api/v2/orders", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/orders", headers, payload });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.id).toBe(first.json().order.id);
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    expect(bootstrap.json().orders.filter((order: { id: string }) => order.id === first.json().order.id)).toHaveLength(1);
  });

  it("새 발주 생성과 제출을 하나의 멱등 트랜잭션으로 처리해 네트워크 재시도에도 draft나 중복 주문을 남기지 않는다", async () => {
    const app = await demoApp();
    const bootstrapBefore = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const requestedDeliveryDate = bootstrapBefore.json().allowedDeliveryDates[0];
    const existingIds = new Set(bootstrapBefore.json().orders.map((order: { id: string }) => order.id));
    const payload = {
      storeId: DEMO_IDS.storeDoksan,
      requestedDeliveryDate,
      items: [{ productId: DEMO_IDS.productBean, quantity: 2 }],
    };
    const headers = { "idempotency-key": "submit-new-order-test" };

    const first = await app.inject({ method: "POST", url: "/api/v2/orders/submit-new", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/orders/submit-new", headers, payload });

    expect(first.statusCode).toBe(201);
    expect(first.json().order).toMatchObject({ status: "submitted", version: 2 });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.id).toBe(first.json().order.id);
    const bootstrapAfter = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const created = bootstrapAfter.json().orders.filter((order: { id: string }) => !existingIds.has(order.id));
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("submitted");
  });

  it("미업로드 사진으로 배송 완료를 위조할 수 없고 실제 mock 업로드 후에만 입고 확정한다", async () => {
    const shipmentId = "00000000-0000-4000-8000-000000004001";
    const repository = createDemoRepository();
    const seededShipment = (await repository.get<Shipment>("shipment", shipmentId))!;
    await repository.commit({ changes: [{ type: "shipment", id: shipmentId, storeId: seededShipment.storeId,
      expectedVersion: seededShipment.version, value: { ...seededShipment, plannedDate: todayInSeoul(), version: seededShipment.version + 1 } }] });
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, repository, logger: false });
    openApps.push(app);
    const actorHeaders = { "x-demo-actor-id": DEMO_IDS.driver };
    const ticketResponse = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/proof-upload`,
      headers: { ...actorHeaders, "idempotency-key": "proof-ticket-test" }, payload: { contentType: "image/jpeg" },
    });
    expect(ticketResponse.statusCode).toBe(201);
    const ticket = ticketResponse.json();
    const deliveryPayload = { expectedVersion: 3, photoKey: ticket.objectKey, recipientName: "박독산", capturedAt: "2000-01-01T00:00:00.000Z" };
    const forged = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/deliver`,
      headers: { ...actorHeaders, "idempotency-key": "deliver-before-upload" }, payload: deliveryPayload,
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error.code).toBe("PHOTO_NOT_UPLOADED");

    const upload = await app.inject({ method: "PUT", url: ticket.uploadUrl, headers: { "content-type": "image/jpeg" }, payload: Buffer.from([0xff, 0xd8, 0xff, 0x00]) });
    expect(upload.statusCode).toBe(204);
    const completed = await app.inject({
      method: "POST", url: `/api/v2/shipments/${shipmentId}/deliver`,
      headers: { ...actorHeaders, "idempotency-key": "deliver-after-upload" }, payload: deliveryPayload,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().shipment.status).toBe("delivered");
    expect(completed.json().receipt.status).toBe("confirmed");
    expect(completed.json().shipment.proof.capturedAt).not.toBe(deliveryPayload.capturedAt);
    const serializedCompletion = JSON.stringify(completed.json());
    for (const forbidden of ["gross", "supply", "vat", "photoObjectKey", "objectVersionId", "etag", "checksumSha256", "uploadedBy"]) {
      expect(serializedCompletion).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("점주는 본사 승인할 수 없고 운영 담당자는 수동 승인한다", async () => {
    const app = await demoApp();
    const orderId = "00000000-0000-4000-8000-000000003001";
    const denied = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/approve`, headers: { "idempotency-key": "owner-approve-test" }, payload: { expectedVersion: 1 },
    });
    expect(denied.statusCode).toBe(403);
    const approved = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/approve`,
      headers: { "x-demo-actor-id": DEMO_IDS.ops, "idempotency-key": "ops-approve-test" }, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().order.status).toBe("approved");
  });

  it("변경 요청을 받은 점주는 최신 가격으로 수정해 재제출하고 네트워크 재시도에도 한 번만 반영한다", async () => {
    const app = await demoApp();
    const orderId = "00000000-0000-4000-8000-000000003001";
    const changed = await app.inject({
      method: "POST", url: `/api/v2/orders/${orderId}/change-request`,
      headers: { "x-demo-actor-id": DEMO_IDS.ops, "idempotency-key": "request-order-change" },
      payload: { expectedVersion: 1, reason: "원두 수량과 입고일을 다시 확인해 주세요." },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().order).toMatchObject({
      status: "change_requested", version: 2,
      changeRequest: { reason: "원두 수량과 입고일을 다시 확인해 주세요.", requestedBy: DEMO_IDS.ops },
    });
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const requestedDeliveryDate = bootstrap.json().allowedDeliveryDates[1];
    const headers = { "idempotency-key": "resubmit-changed-order" };
    const payload = {
      expectedVersion: 2, requestedDeliveryDate, note: "수량 수정 완료",
      items: [{ productId: DEMO_IDS.productBean, quantity: 3 }],
    };
    const first = await app.inject({ method: "POST", url: `/api/v2/orders/${orderId}/resubmit`, headers, payload });
    const replay = await app.inject({ method: "POST", url: `/api/v2/orders/${orderId}/resubmit`, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().order).toMatchObject({ status: "submitted", version: 3, requestedDeliveryDate, note: "수량 수정 완료" });
    expect(first.json().order.lines).toHaveLength(1);
    expect(first.json().order.lines[0]).toMatchObject({ quantity: 3, snapshot: { productId: DEMO_IDS.productBean, unitGross: 28_600 } });
    expect(first.json().order.changeRequest).toBeUndefined();
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().order.version).toBe(3);
  });

  it("점주 취소는 처리 전 주문만 허용하고 이미 배송이 생성된 주문은 차단한다", async () => {
    const app = await demoApp();
    const bootstrap = await app.inject({ method: "GET", url: "/api/v2/bootstrap" });
    const created = await app.inject({
      method: "POST", url: "/api/v2/orders/submit-new", headers: { "idempotency-key": "new-order-for-cancel" },
      payload: { storeId: DEMO_IDS.storeDoksan, requestedDeliveryDate: bootstrap.json().allowedDeliveryDates[0], items: [{ productId: DEMO_IDS.productBean, quantity: 1 }] },
    });
    const cancelled = await app.inject({
      method: "POST", url: `/api/v2/orders/${created.json().order.id}/cancel`, headers: { "idempotency-key": "cancel-before-fulfillment" },
      payload: { expectedVersion: 2, reason: "중복 발주 취소" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().order).toMatchObject({ status: "cancelled", version: 3 });

    const blocked = await app.inject({
      method: "POST", url: "/api/v2/orders/00000000-0000-4000-8000-000000003002/cancel",
      headers: { "idempotency-key": "cancel-after-shipment" }, payload: { expectedVersion: 1, reason: "잘못된 취소 요청" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("ORDER_FULFILLMENT_STARTED");
  });

  it("재무 담당자는 MFA 후 잘못 연결한 입금 대사를 사유와 함께 되돌린다", async () => {
    const app = await demoApp();
    const financeHeaders = { "x-demo-actor-id": DEMO_IDS.finance };
    const paymentId = "00000000-0000-4000-8000-000000006001";
    const transactionId = "00000000-0000-4000-8000-000000006101";
    const matched = await app.inject({
      method: "POST", url: `/api/v2/payments/${paymentId}/manual-match`,
      headers: { ...financeHeaders, "idempotency-key": "match-before-reverse" },
      payload: { expectedVersion: 1, bankTransactionId: transactionId },
    });
    expect(matched.statusCode).toBe(200);
    const reversed = await app.inject({
      method: "POST", url: `/api/v2/payments/${paymentId}/reverse-match`,
      headers: { ...financeHeaders, "idempotency-key": "reverse-wrong-match" },
      payload: { expectedVersion: 2, reason: "다른 매장 입금으로 확인" },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().paymentRequest).toMatchObject({ status: "pending", version: 3 });
    expect(reversed.json().paymentRequest.matchedBankTransactionId).toBeUndefined();
    expect(reversed.json().bankTransaction).toMatchObject({ matched: false, version: 3 });
  });

  it("재무 검토자와 다른 MFA 마스터만 세금계산서 발행을 승인한다", async () => {
    const app = await demoApp();
    const invoiceId = "00000000-0000-4000-8000-000000008001";
    const approved = await app.inject({
      method: "POST", url: `/api/v2/invoices/${invoiceId}/approve`,
      headers: { "x-demo-actor-id": DEMO_IDS.master, "idempotency-key": "master-invoice-approve" }, payload: { expectedVersion: 2 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().invoice).toMatchObject({ status: "approved", approvedBy: DEMO_IDS.master });
  });

  it("계좌 거래 수동 새로고침은 API에서 외부 호출하지 않고 worker outbox에 한 번만 예약한다", async () => {
    const repository = createDemoRepository();
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, repository, logger: false });
    openApps.push(app);
    const headers = { "x-demo-actor-id": DEMO_IDS.finance, "idempotency-key": "bank-sync-request-test" };
    const date = todayInSeoul();
    const payload = { from: date, to: date };
    const first = await app.inject({ method: "POST", url: "/api/v2/bank-sync", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/api/v2/bank-sync", headers, payload });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    const events = await repository.claimOutbox(10);
    expect(events.filter((event) => event.topic === "bank.sync.requested")).toHaveLength(1);
  });

  it("Popbill webhook API key·MID·CorpNum을 검증하고 중복을 멱등 수신한다", async () => {
    const app = await buildApp({ env: {
      APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent", POPBILL_WEBHOOK_API_KEY: "test-webhook-key",
    }, logger: false });
    openApps.push(app);
    const headers = { "x-api-key": "test-webhook-key", "pb-webhook-mid": "MID-20260802-1", "pb-webhook-corpnum": "1234567890" };
    const payload = { corpNum: "1234567890", stateCode: 300, invoicerMgtKey: "OFD012345678901234567890" };
    const accepted = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers, payload });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    const duplicate = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers, payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ accepted: false });
    const forged = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers: { ...headers, "x-api-key": "wrong", "pb-webhook-mid": "MID-2" }, payload });
    expect(forged.statusCode).toBe(401);
    const missingMid = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", headers: { "x-api-key": "test-webhook-key", "pb-webhook-corpnum": "1234567890" }, payload });
    expect(missingMid.statusCode).toBe(400);
    const otherCorp = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-3", "pb-webhook-corpnum": "9999999999" }, payload: { ...payload, corpNum: "9999999999" } });
    expect(otherCorp.statusCode).toBe(403);

    const nested = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-NESTED" },
      payload: { header: { QMNum: "202608028888888800000001" }, body: { ...payload, stateCode: 304 } } });
    expect(nested.statusCode).toBe(202);

    const bulk = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill",
      headers: { ...headers, "pb-webhook-mid": "MID-BULK" },
      payload: [
        { header: { QMNum: "202608028888888800000002" }, body: { ...payload, itemKey: "item-1", stateCode: 304 } },
        { header: { QMNum: "202608028888888800000003" }, body: { ...payload, itemKey: "item-2", stateCode: 305 } },
      ] });
    expect(bulk.statusCode).toBe(202);
  });

  it("production mock-provider 배포에서는 Popbill webhook endpoint를 닫는다", async () => {
    const app = await buildApp({
      env: { NODE_ENV: "production", APP_MODE: "production", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
        KOREA_HOLIDAYS: "2026-01-01,2026-03-01,2026-05-05,2026-08-15,2026-10-03,2026-10-09,2026-12-25",
        SESSION_SECRET: "a-secure-session-secret-that-is-long-enough", WEB_ORIGIN: "https://ofd.example",
        ENCRYPTION_KEY: Buffer.alloc(32, 0xa5).toString("base64"),
        STORAGE_MODE: "s3", S3_REGION: "ap-northeast-2", S3_BUCKET: "ofd", S3_KMS_KEY_ID: "kms-key",
        EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com" },
      repository: createDemoRepository(), storage: new MockObjectStorage(), logger: false,
    });
    openApps.push(app);
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/v2/bootstrap", headers: {
      origin: "https://ofd.example", "access-control-request-method": "GET",
      "access-control-request-headers": "x-demo-actor-id",
    } });
    expect(String(preflight.headers["access-control-allow-headers"] ?? "")).not.toContain("x-demo-actor-id");
    const response = await app.inject({ method: "POST", url: "/api/v2/webhooks/popbill", payload: { MID: "fake", CorpNum: "1234567890" } });
    expect(response.statusCode).toBe(404);
  });

  it("production은 검증된 KOREA_HOLIDAYS가 없으면 시작을 거부한다", async () => {
    const base = { NODE_ENV: "production", APP_MODE: "production", PROVIDER_MODE: "mock", LOG_LEVEL: "silent",
      SESSION_SECRET: "a-secure-session-secret-that-is-long-enough", WEB_ORIGIN: "https://ofd.example",
      ENCRYPTION_KEY: Buffer.alloc(32, 0xa5).toString("base64"), STORAGE_MODE: "s3", S3_REGION: "ap-northeast-2",
      S3_BUCKET: "ofd", S3_KMS_KEY_ID: "kms-key", EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com" };
    await expect(buildApp({ env: base, repository: createDemoRepository(), storage: new MockObjectStorage(), logger: false }))
      .rejects.toMatchObject({ code: "HOLIDAY_CALENDAR_REQUIRED", statusCode: 503 });
    await expect(buildApp({ env: { ...base, KOREA_HOLIDAYS: "2026-02-30" }, repository: createDemoRepository(),
      storage: new MockObjectStorage(), logger: false })).rejects.toMatchObject({ code: "HOLIDAY_CALENDAR_INVALID", statusCode: 503 });
  });
});

describe("OFD v2 Phase 3 finance API", () => {
  it("retries a failed invoice through the business API", async () => {
    const repository = createDemoRepository();
    const invoice = (await repository.get<TaxInvoice>("tax_invoice", "00000000-0000-4000-8000-000000008001"))!;
    const failed = { ...invoice, status: "failed" as const, failureReason: "timeout", version: invoice.version + 1 };
    await repository.commit({ changes: [{ type: "tax_invoice", id: failed.id, storeId: failed.storeId,
      expectedVersion: invoice.version, value: failed }] });
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, repository, logger: false });
    openApps.push(app);
    const response = await app.inject({ method: "POST", url: `/api/v2/invoices/${failed.id}/retry`,
      headers: { "x-demo-actor-id": DEMO_IDS.finance, "idempotency-key": "retry-invoice" }, payload: { expectedVersion: failed.version } });
    expect(response.statusCode).toBe(200);
    expect(response.json().invoice).toMatchObject({ status: "queued", retryCount: 1 });
  });

  it("denies another store owner access to a document download", async () => {
    const repository = createDemoRepository();
    const document: OriginalDocument = { id: "api-document", storeId: DEMO_IDS.storeHapjeong, kind: "monthly_statement",
      aggregateType: "settlement", aggregateId: "api-settlement", sourceVersion: 1, objectKey: "private/monthly.pdf",
      objectVersionId: "version-1", contentHashSha256: "b".repeat(64), mimeType: "application/pdf", fileName: "monthly.pdf",
      sizeBytes: 100, createdAt: "2026-08-01T00:00:00.000Z", version: 1 };
    await repository.commit({ changes: [{ type: "document", id: document.id, storeId: document.storeId, expectedVersion: null, value: document }] });
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, repository, logger: false });
    openApps.push(app);
    const denied = await app.inject({ method: "GET", url: `/api/v2/documents/${document.id}/download`,
      headers: { "x-demo-actor-id": DEMO_IDS.owner } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("STORE_SCOPE_DENIED");
    const allowed = await app.inject({ method: "GET", url: `/api/v2/documents/${document.id}/download`,
      headers: { "x-demo-actor-id": DEMO_IDS.master } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ document: { id: document.id }, expiresInSeconds: 900 });
  });
});
