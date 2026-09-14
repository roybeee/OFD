import { createHash } from "node:crypto";
import { createDemoRepository, DEMO_IDS, type StateRepository } from "@ofd/db";
import { type Actor, type OdaMonth, type Store } from "@ofd/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { buildApp } from "./app.ts";

const apps: FastifyInstance[] = [];
const MONTH = "2026-08";
const STORE = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${STORE}/${MONTH}`;
const owner = { "x-demo-actor-id": DEMO_IDS.owner };
const finance = { "x-demo-actor-id": DEMO_IDS.finance };
const CSV = "날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,매출,월 마감,33000000,3000000,매출,pos,S-01";
const EXPENSE = "날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,비용,8월 임차료,11000000,1000000,임차료,manual,E-01";
async function setup(repository = createDemoRepository()) {
  const actor = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
  await repository.commit({ changes: [{ type: "actor", id: actor.id, expectedVersion: 1, value: { ...actor, storeIds: [STORE] } }] });
  return { app: await open(repository), repository };
}
async function open(repository: StateRepository) {
  const app = await buildApp({ repository, env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false });
  apps.push(app); return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function request(app: FastifyInstance, suffix: string, payload: unknown, headers = owner) {
  return app.inject({ method: "POST", url: `${base}${suffix}`, payload, headers });
}
async function ready(app: FastifyInstance): Promise<number> {
  const initial = (await app.inject({ method: "GET", url: base, headers: owner })).json();
  const { acknowledgements: _acks, ...policy } = initial.data.policy;
  const saved = await request(app, "/save", { expectedVersion: 0, policy: { ...policy, attributionBasis: "accrual", vatBasis: "net", posDeliveryScope: "excluded", bVatPolicy: "add10", agreementNote: "갑·을은 발생월, 실제 부가세 제외 손익, 을 지급액 부가세 10% 가산에 합의함." } });
  expect(saved.statusCode, saved.body).toBe(200);
  for (const [version, who] of [[1, owner], [2, finance]] as const) {
    const signed = await request(app, "/confirm-policy", { expectedVersion: version }, who);
    expect(signed.statusCode, signed.body).toBe(200);
  }
  const pos = await request(app, "/import", { expectedVersion: 3, filename: "pos.csv", kind: "pos", content: CSV });
  expect(pos.statusCode, pos.body).toBe(200);
  const cost = await request(app, "/import", { expectedVersion: 4, filename: "expenses.csv", kind: "expense", content: EXPENSE });
  expect(cost.statusCode, cost.body).toBe(200);
  expect(cost.json().summary).toMatchObject({ revenue: 30000000, expenses: 10000000, profit: 20000000, shareA: 11500000, shareB: 8500000, payableB: 9350000, canFinalize: true });
  return 5;
}

describe("ODA monthly settlement API", () => {
  it("enforces authentication, own-store isolation, restricted HQ membership, read-only auditors, and assigned contract B", async () => {
    const { app } = await setup();
    for (const id of [DEMO_IDS.staff, DEMO_IDS.driver, DEMO_IDS.ops]) {
      expect((await app.inject({ method: "GET", url: base, headers: { "x-demo-actor-id": id } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${MONTH}`, headers: owner })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${MONTH}`, headers: finance })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: base, headers: { "x-demo-actor-id": DEMO_IDS.auditor } })).statusCode).toBe(200);
    expect((await request(app, "/comment", { expectedVersion: 0, text: "감사 의견" }, { "x-demo-actor-id": DEMO_IDS.auditor })).statusCode).toBe(403);
    expect((await request(app, "/confirm-policy", { expectedVersion: 0 }, { "x-demo-actor-id": DEMO_IDS.master })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v2/pos/links", headers: finance })).statusCode).toBe(403);
    const scopedMonthly = (await app.inject({ method: "GET", url: `/api/v2/settlements/monthly?month=${MONTH}`, headers: finance })).json();
    expect(scopedMonthly.rows.map((row: { storeId: string }) => row.storeId)).toEqual([STORE]);
    const secure = await buildApp({ repository: createDemoRepository(), env: { APP_MODE: "test", TEST_AUTH_REQUIRED: "true", PROVIDER_MODE: "mock", LOG_LEVEL: "silent", SESSION_SECRET: "test-session-key-at-least-thirty-two-characters" }, logger: false });
    apps.push(secure);
    expect((await secure.inject({ method: "GET", url: base, headers: owner })).statusCode).toBe(401);
  });

  it("parses XLSX on the server with mapped headings while retaining actual original bytes and source row", async () => {
    const { app } = await setup();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("월매출");
    sheet.addRow(["8월 매출 원본"]);
    sheet.addRow(["정산영업일", "총액원", "메모"]);
    sheet.addRow(["2026-08-31", 33000000, "월 매출"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = { filename: "매출.xlsx", kind: "pos", contentBase64: bytes.toString("base64"), headerRow: 2,
      sheetName: "월매출", columnMap: { date: "정산영업일", amount: "총액원", description: "메모" } };
    const preview = await request(app, "/import/preview", file);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().lines[0]).toMatchObject({ amount: 33000000, sourceRow: 3 });
    const saved = await request(app, "/import", { ...file, expectedVersion: 0 });
    expect(saved.statusCode, saved.body).toBe(200);
    const source = saved.json().evidence[0];
    expect(source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const downloaded = await app.inject({ method: "GET", url: `${base}/evidence/${source.id}`, headers: owner });
    expect(downloaded.rawPayload.equals(bytes)).toBe(true);
  });

  it("previews without mutation, validates atomically, hashes actual bytes, deduplicates files and cross-file transaction IDs", async () => {
    const { app, repository } = await setup();
    const preview = await request(app, "/import/preview", { filename: "pos.csv", kind: "pos", content: CSV });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().lines).toHaveLength(1);
    expect(await repository.list("oda_month", [STORE])).toHaveLength(0);
    const invalid = CSV + "\n2026-09-01,매출,다른 달,1100,100,매출,pos,S-02";
    const rejected = await request(app, "/import", { expectedVersion: 0, filename: "invalid.csv", kind: "pos", content: invalid });
    expect(rejected.statusCode).toBe(422);
    expect(await repository.list("oda_month", [STORE])).toHaveLength(0);
    const imported = await request(app, "/import", { expectedVersion: 0, filename: "pos.csv", kind: "pos", content: CSV });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().data.sources[0].sha256).toBe(createHash("sha256").update(CSV).digest("hex"));
    expect(imported.body).not.toContain("evidenceBytes");
    expect(imported.body).not.toContain(Buffer.from(CSV).toString("base64"));
    const duplicate = await request(app, "/import", { expectedVersion: 1, filename: "renamed.csv", kind: "pos", content: CSV });
    expect(duplicate.statusCode).toBe(409);
    const reexport = CSV.replace("월 마감", "다른 내보내기");
    const rows = await request(app, "/import", { expectedVersion: 1, filename: "reexport.csv", kind: "pos", content: reexport });
    expect(rows.statusCode).toBe(200);
    expect(rows.json().importResult).toEqual({ added: 0, duplicates: 1 });
    expect(rows.json().data.lines).toHaveLength(1);
    expect((await request(app, "/import", { expectedVersion: 2, filename: "broken.csv", kind: "pos", content: CSV.replace("33000000", "1.5") })).statusCode).toBe(422);
  });

  it("keeps evidence behind store authorization and repository persistence across app instances", async () => {
    const { app, repository } = await setup();
    const imported = (await request(app, "/import", { expectedVersion: 0, filename: "매출.csv", kind: "pos", content: CSV })).json();
    const evidenceId = imported.evidence[0].id;
    const download = await app.inject({ method: "GET", url: `${base}/evidence/${evidenceId}`, headers: owner });
    expect(download.statusCode).toBe(200); expect(download.body).toBe(CSV);
    const otherPath = `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${MONTH}/evidence/${evidenceId}`;
    expect((await app.inject({ method: "GET", url: otherPath, headers: owner })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: otherPath, headers: { "x-demo-actor-id": DEMO_IDS.master } })).statusCode).toBe(404);
    const restarted = await open(repository);
    const persisted = (await restarted.inject({ method: "GET", url: base, headers: owner })).json();
    expect(persisted.version).toBe(1); expect(persisted.data.lines).toHaveLength(1);
    expect((await restarted.inject({ method: "GET", url: `${base}/evidence/${evidenceId}`, headers: owner })).body).toBe(CSV);
    const ledger = await repository.listAudit(100, [STORE]);
    expect(JSON.stringify(ledger)).not.toContain("evidenceBytes");
    expect(JSON.stringify(ledger)).not.toContain(Buffer.from(CSV).toString("base64"));
  });

  it("preserves a legacy Korean CSV byte-for-byte while decoding it only for parsing", async () => {
    const { app } = await setup();
    // CP949/EUC-KR bytes for: 날짜,내용,금액,분류 + an August sales row.
    const bytes = Buffer.from("b3afc2a52cb3bbbfeb2cb1ddbed72cbad0b7f90a323032362d30382d33312cbff920b8c5c3e22c31313030303030302cb8c5c3e2", "hex");
    const uploaded = await request(app, "/import", { expectedVersion: 0, filename: "legacy.csv", kind: "pos", contentBase64: bytes.toString("base64") });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json().data.lines[0]).toMatchObject({ description: "월 매출", amount: 11000000 });
    const source = uploaded.json().evidence[0];
    expect(source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const downloaded = await app.inject({ method: "GET", url: `${base}/evidence/${source.id}`, headers: owner });
    expect(downloaded.rawPayload.equals(bytes)).toBe(true);
    expect(downloaded.headers["content-type"]).toContain("charset=euc-kr");
  });

  it("serializes concurrent changes, blocks forged signatures and invalidates commercial policy acknowledgements only on real change", async () => {
    const { app } = await setup();
    const replies = await Promise.all([request(app, "/comment", { expectedVersion: 0, text: "A" }), request(app, "/comment", { expectedVersion: 0, text: "B" })]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    const forged = await request(app, "/confirm-policy", { expectedVersion: 1, party: "B", actorId: DEMO_IDS.finance });
    expect(forged.statusCode).toBe(422);
    expect((await request(app, "/confirm-policy", { expectedVersion: 1 })).statusCode).toBe(200);
    expect((await request(app, "/confirm-policy", { expectedVersion: 2 }, finance)).statusCode).toBe(200);
    const data: OdaMonth = (await app.inject({ method: "GET", url: base, headers: owner })).json().data;
    const { acknowledgements: _acks, ...policy } = data.policy;
    const same = await request(app, "/save", { expectedVersion: 3, policy });
    expect(Object.keys(same.json().data.policy.acknowledgements)).toHaveLength(2);
    const changed = await request(app, "/save", { expectedVersion: 4, policy: { ...policy, bVatPolicy: "none" } });
    expect(changed.json().data.policy.acknowledgements).toEqual({});
  });

  it("requires source completeness and A finalization; retains snapshots on reopen; records exact immutable payment", async () => {
    const { app, repository } = await setup();
    expect((await request(app, "/finalize", { expectedVersion: 0 })).statusCode).toBe(422);
    const version = await ready(app);
    expect((await request(app, "/finalize", { expectedVersion: version }, finance)).statusCode).toBe(403);
    const finalized = await request(app, "/finalize", { expectedVersion: version });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const snapshot = finalized.json().history[0];
    expect((await request(app, "/save", { expectedVersion: 6, policy: {} })).statusCode).toBe(422);
    expect((await request(app, "/import", { expectedVersion: 6, filename: "more.csv", kind: "pos", content: CSV })).statusCode).toBe(409);
    const reopened = await request(app, "/reopen", { expectedVersion: 6, reason: "누락된 수수료 확인 후 재검토" });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().history[0]).toEqual(snapshot);
    expect(reopened.json().history[1].reason).toContain("누락된 수수료");
    const refinalized = await request(app, "/finalize", { expectedVersion: 7 });
    expect(refinalized.statusCode).toBe(200);
    expect((await request(app, "/paid", { expectedVersion: 8, date: "2026-09-10", reference: "은행 이체 00001", amount: 8500000 })).statusCode).toBe(422);
    const paid = await request(app, "/paid", { expectedVersion: 8, date: "2026-09-10", reference: "은행 이체 00001", amount: 9350000 });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().payment).toEqual({ date: "2026-09-10", reference: "은행 이체 00001", amount: 9350000 });
    expect((await request(app, "/reopen", { expectedVersion: 9, reason: "지급 이후 변경 요청" })).statusCode).toBe(409);
    const audits = await repository.listAudit(100, [STORE]);
    expect(audits.some((item) => (item.metadata.lineChanges as unknown[])?.length)).toBe(true);
  });

  it("cannot acknowledge both parties with the same identity after a role change", async () => {
    const { app, repository } = await setup();
    expect((await request(app, "/confirm-policy", { expectedVersion: 0 })).statusCode).toBe(200);
    const actor = (await repository.get<Actor>("actor", DEMO_IDS.owner))!;
    await repository.commit({ changes: [{ type: "actor", id: actor.id, expectedVersion: 1, value: { ...actor, role: "hq_finance" } }] });
    const duplicateIdentity = await request(app, "/confirm-policy", { expectedVersion: 1 });
    expect(duplicateIdentity.statusCode).toBe(403);
    expect(duplicateIdentity.json().error.code).toBe("ODA_DUAL_SIGNATURE");
  });

  it("carries one-time policy agreement but resets calendar metadata and proposes recurring costs only for review", async () => {
    const { app } = await setup();
    await ready(app); await request(app, "/finalize", { expectedVersion: 5 });
    const nextBase = `/api/v2/oda/${STORE}/2026-09`;
    const next = (await app.inject({ method: "GET", url: nextBase, headers: owner })).json();
    expect(next.data.policy.acknowledgements.A.actorId).toBe(DEMO_IDS.owner);
    expect(next.data.policy.acknowledgements.B.actorId).toBe(DEMO_IDS.finance);
    expect(next.data.policy.operatingDays).toBe(30); expect(next.data.lines).toEqual([]);
    const repeated = await app.inject({ method: "POST", url: `${nextBase}/repeat-previous`, headers: owner, payload: { expectedVersion: 0 } });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.lines[0]).toMatchObject({ reviewed: false, sourceId: "" });
    expect(repeated.json().summary.expenses).toBe(0);
    expect(repeated.json().summary.blockers.some((issue: { code: string }) => issue.code === "month_not_ended")).toBe(true);
    const twice = await app.inject({ method: "POST", url: `${nextBase}/repeat-previous`, headers: owner, payload: { expectedVersion: 1 } });
    expect(twice.json().data.lines).toHaveLength(1);
  });

  it("bank cash is never automatic P&L; explicit confirmed outflow converts once with linked evidence", async () => {
    const { app } = await setup();
    const bank = "날짜,내용,금액,분류,거래ID\n2026-08-31,임차료 이체,-1100000,입출금,B-01\n2026-08-31,플랫폼 입금,3000000,입출금,B-02";
    const imported = await request(app, "/import", { expectedVersion: 0, filename: "bank.csv", kind: "bank", content: bank });
    expect(imported.statusCode, imported.body).toBe(200);
    const [outflow, inflow] = imported.json().data.lines;
    expect(imported.json().summary).toMatchObject({ revenue: 0, expenses: 0, bankInflow: 3000000, bankOutflow: 1100000 });
    expect((await request(app, `/lines/${inflow.id}`, { expectedVersion: 1, changes: { kind: "revenue" } })).statusCode).toBe(422);
    expect((await request(app, "/bank-expense", { expectedVersion: 1, bankLineId: inflow.id, category: "rent", vat: 100000 })).statusCode).toBe(422);
    const converted = await request(app, "/bank-expense", { expectedVersion: 1, bankLineId: outflow.id, category: "rent", vat: 100000 });
    expect(converted.statusCode, converted.body).toBe(200);
    expect(converted.json().summary.expenses).toBe(1100000);
    expect(converted.json().data.lines[2]).toMatchObject({ bankLineId: outflow.id, amount: 1100000, reviewed: true, sourceId: outflow.sourceId });
    expect((await request(app, "/bank-expense", { expectedVersion: 2, bankLineId: outflow.id, category: "rent", vat: 100000 })).statusCode).toBe(409);
  });

  it("imports standard separate bank credit/debit XLSX columns and rejects conflicting CSV rows atomically", async () => {
    const { app, repository } = await setup();
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("계좌 내역");
    sheet.addRow(["거래일자", "상대방", "받은금액", "보낸금액", "거래고유번호"]);
    sheet.addRow(["2026-08-31", "배달 입금", 2200000, null, "B-XLSX-1"]);
    sheet.addRow(["2026-08-31", "임차료", null, 1100000, "B-XLSX-2"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const source = { filename: "bank.xlsx", kind: "bank", contentBase64: bytes.toString("base64"),
      columnMap: { date: "거래일자", description: "상대방", creditAmount: "받은금액", debitAmount: "보낸금액", externalId: "거래고유번호" } };
    const preview = await request(app, "/import/preview", source);
    expect(preview.statusCode, preview.body).toBe(200); expect(preview.json().errors).toEqual([]);
    expect(preview.json().lines.map((line: { amount: number }) => line.amount)).toEqual([2200000, -1100000]);
    const saved = await request(app, "/import", { ...source, expectedVersion: 0 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().summary).toMatchObject({ revenue: 0, expenses: 0, bankInflow: 2200000, bankOutflow: 1100000 });
    const invalid = "날짜,입금액,출금액\n2026-08-01,100,\n2026-08-02,300,200";
    const rejected = await request(app, "/import", { expectedVersion: 1, filename: "invalid-bank.csv", kind: "bank", content: invalid });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.details[0].code).toBe("bank_both_directions");
    const persisted = (await repository.list<OdaMonth>("oda_month", [STORE]))[0]!;
    expect(persisted.version).toBe(1); expect(persisted.lines).toHaveLength(2); expect(persisted.sources).toHaveLength(1);
  });

  it("excludes bank cash from totals and restores its classification without changing the evidence", async () => {
    const { app } = await setup();
    const content = "날짜,내용,금액,거래ID\n2026-08-31,플랫폼 입금,3000000,B-restore";
    const imported = (await request(app, "/import", { expectedVersion: 0, filename: "bank.csv", kind: "bank", content })).json();
    const bank = imported.data.lines[0];
    const excluded = await request(app, `/lines/${bank.id}`, { expectedVersion: 1, changes: { kind: "excluded", reviewed: true, note: "다른 계좌 중복 반영 제외" } });
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect(excluded.json().summary).toMatchObject({ bankInflow: 0, excludedCount: 1 });
    expect(excluded.json().data.lines[0]).toMatchObject({ originalKind: "bank", originalCategory: "bank", sourceId: bank.sourceId });
    const refreshed = (await app.inject({ method: "GET", url: base, headers: owner })).json();
    expect(refreshed.summary.bankInflow).toBe(0);
    const restored = await request(app, `/lines/${bank.id}`, { expectedVersion: 2, changes: { kind: "bank", reviewed: true } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().summary).toMatchObject({ bankInflow: 3000000, excludedCount: 0 });
    expect((await app.inject({ method: "GET", url: `${base}/evidence/${bank.sourceId}`, headers: owner })).body).toBe(content);
  });

  it("restores platform fees and payouts to their own original types and rejects revenue conversion", async () => {
    const { app } = await setup();
    const content = "날짜,내용,금액,부가세,수수료금액,수수료부가세,입금예정액,거래ID\n2026-08-31,배달 주문,1100000,100000,220000,20000,880000,P-restore";
    const imported = await request(app, "/import", { expectedVersion: 0, filename: "platform.csv", kind: "platform", channel: "baemin", content });
    expect(imported.statusCode, imported.body).toBe(200);
    const [, fee, payout] = imported.json().data.lines;
    let version = 1;
    for (const [line, kind, category] of [[fee, "expense", "fees"], [payout, "bank", "bank"]] as const) {
      const excluded = await request(app, `/lines/${line.id}`, { expectedVersion: version, changes: { kind: "excluded", category: "owner_transfer", reviewed: true, note: "원본 확인을 위해 임시 제외" } });
      expect(excluded.statusCode, excluded.body).toBe(200); version++;
      expect(excluded.json().data.lines.find((item: { id: string }) => item.id === line.id)).toMatchObject({ originalKind: kind, originalCategory: category });
      const incorrect = await request(app, `/lines/${line.id}`, { expectedVersion: version, changes: { kind: "revenue", category: "sales" } });
      expect(incorrect.statusCode).toBe(422); expect(incorrect.json().error.code).toBe("ODA_KIND_INVALID");
      const restored = await request(app, `/lines/${line.id}`, { expectedVersion: version, changes: { kind, reviewed: true } });
      expect(restored.statusCode, restored.body).toBe(200); version++;
      expect(restored.json().summary).toMatchObject({ revenue: 1100000, expenses: 220000, platformPayout: 880000 });
      expect(restored.json().data.lines.find((item: { id: string }) => item.id === line.id)).toMatchObject({ kind, category, sourceId: line.sourceId });
    }
  });

  it("uses a known store opening date for initial partial-month operating days", async () => {
    const { app, repository } = await setup();
    const store = (await repository.get<Store>("store", STORE))!;
    await repository.commit({ changes: [{ type: "store", id: STORE, storeId: STORE, expectedVersion: 1, value: { ...store, version: 2, openDate: "2026-08-17" } }] });
    const openingMonth = (await app.inject({ method: "GET", url: base, headers: owner })).json();
    expect(openingMonth.data.policy).toMatchObject({ partialMonth: true, operatingDays: 15, partialMonthPolicy: "hold" });
    expect(openingMonth.summary.blockers.some((issue: { code: string }) => issue.code === "partial_month_unresolved")).toBe(true);
    const followingMonth = (await app.inject({ method: "GET", url: `/api/v2/oda/${STORE}/2026-09`, headers: owner })).json();
    expect(followingMonth.data.policy).toMatchObject({ partialMonth: false, operatingDays: 30 });
  });

  it("neutralizes spreadsheet formulas in exports while retaining numeric cells", async () => {
    const { app } = await setup();
    await request(app, "/import", { expectedVersion: 0, filename: "pos.csv", kind: "pos", content: CSV.replace("월 마감", '=HYPERLINK(""https://evil.invalid"")') });
    const entered = await request(app, "/lines", { expectedVersion: 0, line: { date: "2026-08-31", kind: "expense", description: "=1+2", amount: 1100, vat: 100, category: "other", reviewed: false } });
    // Malformed CSV is rejected atomically; a typed manual row still must be safe in export.
    expect(entered.statusCode).toBe(200);
    const exported = await app.inject({ method: "GET", url: `${base}/export.csv`, headers: owner });
    expect(exported.statusCode).toBe(200); expect(exported.body).toContain("'=1+2"); expect(exported.body).toContain('"1100"');
  });
});
