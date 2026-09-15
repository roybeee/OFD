import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import { calculateOdaMonth, createOdaMonth, type Actor, type OdaLine, type OdaMonth, type OdaSource } from "@ofd/domain";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { buildOdaReport } from "./oda-report.ts";

const MONTH = "2026-08";
const STORE = DEMO_IDS.storeDoksan;
const TIME = "2026-09-01T02:00:00.000Z";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture(): OdaMonth {
  const data = createOdaMonth(STORE, MONTH, TIME);
  data.id = `${STORE}:${MONTH}`;
  data.policy = { ...data.policy, attributionBasis: "accrual", vatBasis: "net", posDeliveryScope: "excluded", bVatPolicy: "add10", activeChannels: ["pos", "baemin"],
    agreementNote: "발생월 기준 실제 부가세 제외, B 부가세 10% 가산에 합의", acknowledgements: {
      A: { actorId: "A", actorName: "운영자", at: TIME }, B: { actorId: "B", actorName: "운영 지원자", at: TIME },
    } };
  function source(id: string, kind: OdaSource["kind"], channel = ""): OdaSource {
    return { id, kind, channel, fileName: `${id}.csv`, sha256: "a".repeat(64), importedAt: TIME, importedBy: "A", rowCount: 1, sizeBytes: 100, mimeType: "text/csv" };
  }
  data.sources = [source("pos", "pos", "pos"), source("cost", "expense"), source("platform", "platform", "baemin"), source("bank", "bank")];
  function line(id: string, kind: OdaLine["kind"], amount: number, vat: number | null, category: string, sourceId: string, channel = "manual"): OdaLine {
    return { id, date: "2026-08-31", kind, description: id, amount, vat, category, sourceId, channel, sourceRow: 2, externalId: id, reviewed: true, note: "" };
  }
  data.lines = [line("매장매출", "revenue", 33000000, 3000000, "sales", "pos", "pos"),
    line("운영비", "expense", 11000000, 1000000, "rent", "cost"),
    line("A 우선배분", "excluded", 3000000, 0, "a_priority", "cost"),
    line("플랫폼 정산", "bank", 7000000, null, "bank", "platform", "baemin"),
    line("통장 입금", "bank", 6000000, null, "bank", "bank"),
    line("통장 출금", "bank", -2000000, null, "bank", "bank")];
  return data;
}
async function workbook(data: OdaMonth, extras: Partial<Parameters<typeof buildOdaReport>[0]> = {}): Promise<ExcelJS.Workbook> {
  const bytes = await buildOdaReport({ month: data, summary: calculateOdaMonth(data), storeName: "ODA 외대점", exportedAt: new Date(TIME), ...extras });
  const report = new ExcelJS.Workbook(); await report.xlsx.load(bytes as unknown as ExcelJS.Buffer); return report;
}
function value(book: ExcelJS.Workbook, label: string, sheet = "월손익·배분"): ExcelJS.CellValue {
  let result: ExcelJS.CellValue = null;
  book.getWorksheet(sheet)!.eachRow((row) => { if (row.getCell(1).value === label) result = row.getCell(2).value; });
  return result;
}

describe("ODA monthly report", () => {
  it("exports channel reconciliation from the frozen summary and omits it for older snapshots", async () => {
    const data = fixture();
    data.lines.push({ ...data.lines[0]!, id: "platform-sale", sourceId: "platform", channel: "baemin", amount: 1_100_000, vat: 100_000, externalId: "platform-sale" });
    const draft = await workbook(data);
    expect(value(draft, "배달의민족 · 정산 대상 원본금액")).toBe(1_100_000);
    expect(value(draft, "배달의민족 · 손익 추가액")).toBe(1_000_000);
    data.policy.posDeliveryScope = "included";
    data.status = "finalized"; data.version = 6;
    data.history = [{ id: "confirmed", version: 5, at: TIME, actorId: "A", actorName: "운영자", reason: "월 정산 확정",
      lines: structuredClone(data.lines), sources: structuredClone(data.sources), policy: structuredClone(data.policy), summary: calculateOdaMonth(data) }];
    data.lines.at(-1)!.amount = 2_200_000;
    data.policy.posDeliveryScope = "excluded";
    const frozen = await workbook(data);
    expect(value(frozen, "배달의민족 · POS 중복 제외")).toBe(1_100_000);
    expect(value(frozen, "배달의민족 · 손익 추가액")).toBe(0);
    delete data.history[0]!.summary.platformRevenueByChannel;
    expect(value(await workbook(data), "배달의민족 · 손익 추가액")).toBeNull();
  });

  it("shows each delivery channel POS scope in the accounting report", async () => {
    const data = fixture();
    data.policy.activeChannels = ["pos", "baemin", "coupang", "yogiyo", "ddangyo"];
    data.policy.posDeliveryScopes = { baemin: "included", coupang: "excluded", yogiyo: "unresolved", ddangyo: "excluded" };
    const report = await workbook(data);
    expect(value(report, "POS 포함 · 배달의민족", "기준·확인")).toBe("포함 · POS 기준");
    expect(value(report, "POS 포함 · 쿠팡이츠", "기준·확인")).toBe("별도 합산");
    expect(value(report, "POS 포함 · 요기요", "기준·확인")).toBe("확인 필요");
    expect(value(report, "POS 포함 · 땡겨요", "기준·확인")).toBe("별도 합산");
    expect(value(report, "사용 매출 채널", "기준·확인")).toContain("땡겨요");
    expect(value(report, "POS 배달매출 포함 여부", "기준·확인")).toBeNull();
  });

  it("exports exact server amounts, keeps priority out of costs, and distinguishes bank cash from platform payout", async () => {
    const data = fixture();
    const report = await workbook(data);
    expect(report.worksheets.map((sheet) => sheet.name)).toEqual(["월손익·배분", "거래내역", "증빙목록", "기준·확인", "변경이력"]);
    expect(value(report, "정산 상태")).toBe("작성 중 · 미확정");
    expect(value(report, "매출 합계")).toBe(30000000);
    expect(value(report, "운영비 합계")).toBe(10000000);
    expect(value(report, "정산 기준 영업이익")).toBe(20000000);
    expect(value(report, "A 우선배분 기준액")).toBe(3000000);
    expect(value(report, "A 배분액 합계")).toBe(11500000);
    expect(value(report, "B 배분액")).toBe(8500000);
    expect(value(report, "B 배분 부가세")).toBe(850000);
    expect(value(report, "B 지급 예정액")).toBe(9350000);
    expect(value(report, "플랫폼 정산서 지급예정액")).toBe(7000000);
    expect(value(report, "실제 통장 입금 합계")).toBe(6000000);
    expect(value(report, "실제 통장 출금 합계")).toBe(2000000);
    expect(value(report, "정산서 작성 기한")).toEqual(new Date("2026-09-05T00:00:00Z"));
    expect(value(report, "B 지급 기한")).toEqual(new Date("2026-09-10T00:00:00Z"));
    const detail = report.getWorksheet("거래내역")!;
    expect(detail.getRow(8).getCell(2).value).toBe("플랫폼 지급예정액");
    expect(detail.getRow(9).getCell(2).value).toBe("실제 계좌 입출금");
    expect(detail.getRow(9).getCell(9).value).toBe("bank.csv");
    expect(detail.getRow(9).getCell(10).value).toBe("bank");
    expect(detail.getRow(9).getCell(11).value).toBe(2);
    expect(detail.getRow(5).getCell(4).numFmt).toContain("#,##0");
    expect(detail.autoFilter).toBeDefined();
  });

  it("keeps unagreed allocation blank with hold reasons, instead of turning unknown amounts into zero", async () => {
    const data = fixture();
    data.lines[0]!.amount = 12100000; data.lines[0]!.vat = 1100000;
    data.policy.bVatPolicy = "unresolved";
    data.policy.acknowledgements = {};
    const report = await workbook(data);
    expect(value(report, "정산 기준 영업이익")).toBe(1000000);
    expect(value(report, "A 배분액 합계")).toBeNull();
    expect(value(report, "B 배분액")).toBeNull();
    expect(value(report, "B 지급 예정액")).toBeNull();
    expect(value(report, "확정 가능 여부")).toContain("확인 필요");
    let hold = false;
    report.getWorksheet("월손익·배분")!.eachRow((row) => { if (row.getCell(1).value === "B 지급 예정액") hold = row.getCell(3).value === "산정 보류"; });
    expect(hold).toBe(true);
    expect(value(report, "low_profit_unresolved", "기준·확인")).toBe("확인 필요");
    expect(value(report, "b_vat_unresolved", "기준·확인")).toBe("확인 필요");
  });

  it.each(["finalized", "paid"] as const)("uses the locked snapshot for %s statements and preserves payment records", async (status) => {
    const data = fixture();
    data.status = status; data.version = 6;
    data.history = [{ id: "confirmed", version: 5, at: TIME, actorId: "A", actorName: "운영자", reason: "월 정산 확정",
      lines: structuredClone(data.lines), sources: structuredClone(data.sources), policy: structuredClone(data.policy), summary: calculateOdaMonth(data) }];
    data.lines[0]!.amount = 66000000; // The report must not silently reissue the frozen statement with a changed current value.
    const report = await workbook(data, status === "paid" ? { payment: { date: "2026-09-10", amount: 9350000, reference: "TRANSFER-01" } } : {});
    expect(value(report, "정산 상태")).toBe(status === "paid" ? "지급 기록 완료" : "정산 확정");
    expect(value(report, "매출 합계")).toBe(30000000);
    expect(report.getWorksheet("거래내역")!.getRow(5).getCell(4).value).toBe(33000000);
    expect(value(report, "실제 이체금액")).toBe(status === "paid" ? 9350000 : "미기록");
    expect(value(report, "이체 확인번호")).toBe(status === "paid" ? "TRANSFER-01" : "미기록");
    expect(report.getWorksheet("월손익·배분")!.getCell("A3").value).toContain("확정 당시 보관본 v5");
  });

  it("serializes adversarial text as inert string cells and exports evidence metadata without private bytes", async () => {
    const data = fixture();
    data.lines[0]!.description = '=HYPERLINK("https://example.invalid/", "open")';
    data.lines[0]!.externalId = "00100000000000001";
    data.sources[0]!.fileName = "+cmd|'/C calc'!A0.csv";
    data.comments.push({ id: "comment", actorId: "A", actorName: "@SUM(A1)", at: TIME, body: "=1+1" });
    const withPrivateBytes = { ...data, evidenceBytes: { pos: "PRIVATE_BYTES_SHOULD_NOT_APPEAR" } };
    const report = await workbook(withPrivateBytes);
    expect(report.getWorksheet("거래내역")!.getRow(5).getCell(3).value).toBe(data.lines[0]!.description);
    expect(report.getWorksheet("거래내역")!.getRow(5).getCell(12).value).toBe("00100000000000001");
    const cells: ExcelJS.CellValue[] = [];
    for (const sheet of report.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
      expect(cell.formula).toBeUndefined(); expect(cell.hyperlink).toBeUndefined(); cells.push(cell.value);
    }));
    expect(JSON.stringify(cells)).toContain(data.sources[0]!.sha256);
    expect(JSON.stringify(cells)).not.toContain("PRIVATE_BYTES_SHOULD_NOT_APPEAR");
  });

  it("authenticates the download, permits scoped read-only users, and does not mutate monthly records", async () => {
    const repository = createDemoRepository();
    const data = fixture();
    await repository.commit({ changes: [{ type: "oda_month", id: data.id, storeId: STORE, expectedVersion: null, value: { ...data, evidenceBytes: {} } }] });
    const actor = (await repository.get<Actor>("actor", DEMO_IDS.finance))!;
    await repository.commit({ changes: [{ type: "actor", id: actor.id, expectedVersion: 1, value: { ...actor, storeIds: [STORE] } }] });
    const app = await buildApp({ repository, env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false }); apps.push(app);
    const url = `/api/v2/oda/${STORE}/${MONTH}/export.xlsx`;
    const before = await repository.get("oda_month", data.id);
    const auditsBefore = await repository.listAudit(100, [STORE]);
    for (const actorId of [DEMO_IDS.owner, DEMO_IDS.finance, DEMO_IDS.auditor]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-demo-actor-id": actorId } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("spreadsheetml.sheet");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="ODA-settlement-2026-08.xlsx"');
      expect(response.headers["cache-control"]).toContain("no-store");
      const report = new ExcelJS.Workbook(); await report.xlsx.load(response.rawPayload as unknown as ExcelJS.Buffer);
      expect(value(report, "B 지급 예정액")).toBe(9350000);
    }
    expect((await app.inject({ method: "GET", url, headers: { "x-demo-actor-id": DEMO_IDS.staff } })).statusCode).toBe(403);
    const otherUrl = `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${MONTH}/export.xlsx`;
    for (const actorId of [DEMO_IDS.owner, DEMO_IDS.finance]) expect((await app.inject({ method: "GET", url: otherUrl, headers: { "x-demo-actor-id": actorId } })).statusCode).toBe(403);
    expect(await repository.get("oda_month", data.id)).toEqual(before);
    expect(await repository.listAudit(100, [STORE])).toEqual(auditsBefore);
    const secure = await buildApp({ repository, env: { APP_MODE: "test", TEST_AUTH_REQUIRED: "true", PROVIDER_MODE: "mock", LOG_LEVEL: "silent", SESSION_SECRET: "oda-report-test-secret-thirty-two-characters" }, logger: false }); apps.push(secure);
    expect((await secure.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});
