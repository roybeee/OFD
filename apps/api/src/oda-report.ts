import ExcelJS from "exceljs";
import { ODA_EXPENSE_CATEGORIES, type AuditEvent, type OdaMonth, type OdaSummary } from "@ofd/domain";

const INK = "FF253B32";
const GREEN = "FF426950";
const PALE = "FFF1F5F0";
const AMBER = "FFFFF1CE";
const MONEY = '#,##0;[Red](#,##0);"–"';
const STATUS = { draft: "작성 중 · 미확정", finalized: "정산 확정", paid: "지급 기록 완료" } as const;
const CHANNELS: Record<string, string> = { pos: "매장 POS", baemin: "배달의민족", coupang: "쿠팡이츠", yogiyo: "요기요", manual: "직접 등록" };
const CATEGORIES: Record<string, string> = { ...Object.fromEntries(ODA_EXPENSE_CATEGORIES.map((item) => [item.value, item.label])),
  sales: "매출", bank: "계좌·정산 대사", capex: "투자비", deposit: "보증금", a_priority: "A 우선배분", depreciation: "감가상각",
  b_distribution: "B 배분금", owner_transfer: "사업주 이체", uncategorized: "미분류" };
const SOURCE_KINDS: Record<string, string> = { pos: "POS 월 마감", platform: "배달 플랫폼 월 마감", bank: "계좌 입출금", expense: "운영비 목록", evidence: "증빙" };

export interface OdaReportInput {
  month: OdaMonth;
  summary: OdaSummary;
  storeName: string;
  exportedAt?: Date;
  payment?: { date: string; amount: number; reference: string };
  /** Already restricted to this store and this monthly aggregate by the route. */
  audit?: Pick<AuditEvent, "id" | "action" | "actorId" | "actorRole" | "occurredAt">[];
}

/** A dated statement of server records, not an editable model with a second accounting engine. */
export async function buildOdaReport(input: OdaReportInput): Promise<Buffer> {
  const { month: record } = input;
  const closed = record.status !== "draft";
  const snapshot = closed ? [...record.history].reverse().find((entry) => entry.reason === "월 정산 확정" && entry.version <= record.version) : undefined;
  const summary = snapshot?.summary ?? input.summary;
  const lines = snapshot?.lines ?? record.lines;
  const sources = snapshot?.sources ?? record.sources;
  const policy = snapshot?.policy ?? record.policy;
  const exportedAt = input.exportedAt ?? new Date();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ODA 워크스테이션";
  workbook.title = `${record.month} ${input.storeName} 월 정산`;
  workbook.subject = "월 손익과 계약상 이익배분";
  workbook.created = exportedAt;
  workbook.modified = exportedAt;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const issuesByLine = new Map<string, string[]>();
  for (const issue of [...summary.blockers, ...summary.warnings]) if (issue.lineId) {
    issuesByLine.set(issue.lineId, [...(issuesByLine.get(issue.lineId) ?? []), issue.message]);
  }
  const metadata = `${record.month} / ${input.storeName} / ${STATUS[record.status]} / 기록 버전 ${record.version}`;

  // Assign all user text as primitive strings. ExcelJS serializes these as shared strings,
  // including values beginning with =, +, -, @; no uploaded text becomes a formula or hyperlink.
  function sheet(name: string, title: string, widths: number[], description: string): ExcelJS.Worksheet {
    const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: widths.length > 4 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      properties: { defaultRowHeight: 24 } });
    ws.columns = widths.map((width) => ({ width }));
    ws.mergeCells(1, 1, 1, widths.length); ws.getCell(1, 1).value = title;
    ws.getRow(1).height = 34; ws.getCell(1, 1).font = { name: "맑은 고딕", size: 18, bold: true, color: { argb: "FFFFFFFF" } };
    ws.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
    ws.mergeCells(2, 1, 2, widths.length); ws.getCell(2, 1).value = metadata;
    ws.mergeCells(3, 1, 3, widths.length); ws.getCell(3, 1).value = description;
    ws.getRow(3).height = 34;
    ws.headerFooter.oddFooter = `${record.month} ODA 월 정산 &C&P / &N`;
    return ws;
  }
  function header(ws: ExcelJS.Worksheet, values: string[]): void {
    const row = ws.addRow(values);
    row.height = 28;
    row.eachCell((cell) => { cell.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } }; });
  }
  function section(ws: ExcelJS.Worksheet, title: string): void {
    const row = ws.addRow([title]);
    ws.mergeCells(row.number, 1, row.number, 4);
    row.getCell(1).font = { name: "맑은 고딕", bold: true, color: { argb: INK } };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALE } };
    row.height = 28;
  }
  function metric(ws: ExcelJS.Worksheet, label: string, value: string | number | Date | null, note = "", highlight = false): void {
    const row = ws.addRow([label, value, value === null ? "산정 보류" : "", note]);
    if (typeof value === "number") row.getCell(2).numFmt = MONEY;
    if (value instanceof Date) row.getCell(2).numFmt = "yyyy-mm-dd";
    if (highlight || value === null) {
      row.eachCell({ includeEmpty: true }, (cell) => { cell.font = { name: "맑은 고딕", bold: true, color: { argb: INK } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: value === null ? AMBER : PALE } }; });
      row.height = 30;
    }
  }
  const report = sheet("월손익·배분", "ODA 월 손익 및 이익배분 정산서", [31, 22, 20, 66],
    `${snapshot ? `확정 당시 보관본 v${snapshot.version} 기준` : "현재 작성 자료 기준"} · 통화 KRW · 내보내기 ${exportedAt.toISOString()} · 수정은 워크스테이션에서 기록합니다.`);
  header(report, ["항목", "금액 또는 일자", "확인 상태", "적용 기준"]);
  metric(report, "정산 상태", STATUS[record.status], closed ? "확정한 손익·배분 기준" : "확정 전 검토용입니다. 지급 지시로 사용할 수 없습니다.", true);
  metric(report, "확정 가능 여부", closed ? "확정 완료" : summary.canFinalize ? "A 최종 확인 대기" : `확인 필요 ${summary.blockers.length}건`);
  section(report, "1. 월 손익");
  metric(report, "매출 합계", summary.revenue, policy.vatBasis === "net" ? "거래별 실제 부가세 제외" : policy.vatBasis === "gross" ? "부가세 포함 기준" : "부가세 기준 미합의", true);
  for (const group of summary.revenueByChannel) metric(report, `  ${CHANNELS[group.category] ?? group.category}`, group.amount, `${group.count}건`);
  metric(report, "운영비 합계", summary.expenses, "A 우선배분·감가상각·B 배분금·투자비·보증금·사업주 이체 제외", true);
  for (const group of summary.expenseByCategory) metric(report, `  ${CATEGORIES[group.category] ?? group.category}`, group.amount, `${group.count}건`);
  metric(report, "정산 기준 영업이익", summary.profit, "매출 합계 − 운영비 합계", true);
  section(report, "2. 계약상 이익배분");
  metric(report, "A 우선배분 기준액", summary.priorityA, "영업이익에서 우선 배분합니다. 운영비·인건비에 다시 넣지 않습니다.");
  metric(report, "우선배분 후 잔여이익", summary.residualProfit, "영업이익 − A 우선배분 기준액. 음수인 경우 합의 또는 보류 기준을 확인합니다.");
  metric(report, "A 배분액 합계", summary.shareA, "우선배분 포함. 잔여이익은 A:B = 50:50으로 배분합니다.", true);
  metric(report, "B 배분액", summary.shareB, "부가세 가산 전 배분액", true);
  metric(report, "B 배분 부가세", summary.vatB, policy.bVatPolicy === "add10" ? "합의한 10% 가산" : policy.bVatPolicy === "none" ? "가산 없음으로 합의" : "적용 여부 미합의");
  metric(report, "B 지급 예정액", summary.payableB, closed ? "배분액 + 합의한 부가세" : "작성 중 산정액입니다. 미합의·미확인 항목을 해결한 뒤 확정합니다.", true);
  metric(report, "정산서 작성 기한", dateCell(summary.statementDueDate), "익월 5일");
  metric(report, "B 지급 기한", dateCell(summary.paymentDueDate), "익월 10일");
  metric(report, "실제 지급일", input.payment ? dateCell(input.payment.date) : "미기록");
  metric(report, "실제 이체금액", input.payment?.amount ?? "미기록", "워크스테이션에 입력한 이체 기록입니다.");
  metric(report, "이체 확인번호", input.payment?.reference ?? "미기록");
  section(report, "3. 계좌 대사 참고");
  metric(report, "플랫폼 정산서 지급예정액", summary.platformPayout, "플랫폼 자료에 적힌 정산액. 실제 통장 입금과 구별합니다.");
  metric(report, "실제 통장 입금 합계", summary.bankInflow, "계좌 입금은 매출로 다시 합산하지 않습니다.");
  metric(report, "실제 통장 출금 합계", summary.bankOutflow, "비용으로 연결·확인한 거래만 운영비에 별도로 반영됩니다.");
  metric(report, "운영비·매출 제외금액", summary.excluded, `${summary.excludedCount}건. 계좌 대사 및 POS 포함 배달매출과 별도입니다.`);
  metric(report, "중복 합산 제외 배달매출", summary.ignoredRevenueCount, "건수. POS에 이미 포함된 배달 플랫폼 매출입니다.");

  const detail = sheet("거래내역", "거래내역과 원본 연결", [14, 23, 46, 20, 18, 22, 18, 13, 35, 38, 12, 32, 38, 38, 45],
    "금액은 원본 부가세 포함액입니다. 이 표의 단순 합계는 손익이 아닙니다. 미확인·제외·대사 내역을 포함하며 월손익·배분 시트에 서버 계산 결과를 표시합니다.");
  header(detail, ["귀속일", "자료 구분", "내용", "원본 금액 (원)", "원본 부가세 (원)", "분류", "채널", "검토", "원본 파일", "증빙 ID", "원본 행", "거래번호", "거래 ID", "연결 출금 ID", "비고 / 확인 필요"]);
  for (const line of lines) {
    const source = sourceById.get(line.sourceId);
    const kind = line.kind === "bank" ? source?.kind === "platform" ? "플랫폼 지급예정액" : "실제 계좌 입출금" : { revenue: "매출 자료", expense: "운영비 자료", excluded: "손익 제외" }[line.kind];
    const issues = issuesByLine.get(line.id) ?? [];
    const row = detail.addRow([dateCell(line.date), kind, line.description, line.amount, line.vat, CATEGORIES[line.category] ?? line.category,
      CHANNELS[line.channel] ?? line.channel, line.reviewed ? "확인" : "미확인", source?.fileName ?? "증빙 미연결", line.sourceId, line.sourceRow,
      line.externalId, line.id, line.bankLineId ?? "", [line.note, line.categoryRule ? `매장 분류 기억 v${line.categoryRule.version}: ${line.categoryRule.description} → ${line.categoryRule.category}${line.category !== line.categoryRule.category ? " (이후 수정)" : ""}` : "", ...issues, line.approvalSourceId ? `사전동의 증빙: ${line.approvalSourceId}` : ""].filter(Boolean).join("\n")]);
    row.getCell(1).numFmt = "yyyy-mm-dd"; row.getCell(4).numFmt = MONEY; row.getCell(5).numFmt = MONEY;
    if (!line.reviewed) row.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
  }
  detail.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, detail.rowCount), column: 15 } };

  const evidence = sheet("증빙목록", "보관된 원본 증빙 목록", [38, 36, 23, 20, 16, 18, 31, 38, 68], "원본의 파일명·식별자·해시를 기록합니다. 원본 파일은 워크스테이션에서 권한 확인 후 내려받을 수 있습니다.");
  header(evidence, ["증빙 ID", "파일명", "자료 구분", "채널", "자료 행 수", "파일 크기 (bytes)", "첨부 시각 (UTC)", "첨부자 ID", "SHA-256"]);
  for (const source of sources) evidence.addRow([source.id, source.fileName, SOURCE_KINDS[source.kind] ?? source.kind, CHANNELS[source.channel] ?? source.channel,
    source.rowCount, source.sizeBytes, source.importedAt, source.importedBy, source.sha256]);
  evidence.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, evidence.rowCount), column: 9 } };

  const checks = sheet("기준·확인", "합의한 정산 기준과 확인 항목", [32, 31, 25, 78], "A와 B는 서로 다른 본인 계정으로 기준을 확인합니다. 합의 변경 시 워크스테이션에서 다시 확인해야 합니다.");
  header(checks, ["항목", "적용 값", "식별자 / 상태", "설명 / 확인 시각"]);
  checks.addRow(["정산 귀속", policy.attributionBasis === "accrual" ? "발생월 기준" : "미합의"]);
  checks.addRow(["손익 부가세 기준", { unresolved: "미합의", gross: "부가세 포함", net: "실제 부가세 제외" }[policy.vatBasis]]);
  checks.addRow(["POS 배달매출 포함 여부", { unresolved: "미합의", included: "포함", excluded: "미포함" }[policy.posDeliveryScope]]);
  checks.addRow(["B 부가세 가산", { unresolved: "미합의", add10: "10% 가산", none: "가산 없음" }[policy.bVatPolicy]]);
  checks.addRow(["우선배분 미달 이익", policy.lowProfitPolicy === "hold" ? "합의 전 보류" : "당월 가용이익 한도 배분"]);
  checks.addRow(["부분월 여부", policy.partialMonth ? "부분월" : "전체월", "운영 일수", policy.operatingDays]);
  checks.addRow(["부분월 우선배분", { hold: "합의 전 보류", full_priority: "전액 적용", prorate: "운영 일수 비례" }[policy.partialMonthPolicy]]);
  checks.addRow(["1원 단수 귀속", policy.roundingBeneficiary]);
  checks.addRow(["사용 매출 채널", policy.activeChannels.map((channel) => CHANNELS[channel] ?? channel).join(", ")]);
  checks.addRow(["합의 내용", policy.agreementNote || "미기록"]);
  for (const party of ["A", "B"] as const) {
    const ack = policy.acknowledgements[party];
    checks.addRow([`${party} 정산 기준 확인`, ack?.actorName ?? "미확인", ack?.actorId ?? "", ack?.at ?? ""]);
  }
  section(checks, "확정 전 해결할 항목");
  if (!summary.blockers.length) checks.addRow(["확인 필요 항목 없음", closed ? "정산 확정" : "최종 확정 대기"]);
  for (const issue of summary.blockers) checks.addRow([issue.code, "확인 필요", issue.lineId ?? "", issue.message]);
  section(checks, "참고 사항");
  for (const issue of summary.warnings) checks.addRow([issue.code, "참고", issue.lineId ?? "", issue.message]);

  const history = sheet("변경이력", "확정 보관본과 변경 기록", [25, 31, 38, 32, 20, 24, 22, 70],
    "보관본은 확정·재개방 시 남긴 기록입니다. 감사 기록은 매장 최근 500건 중 이 정산월에 해당하는 최대 100건이며 전체 이력을 대신하지 않습니다.");
  header(history, ["기록 구분", "시각 (UTC)", "기록 ID", "행위자", "버전 / 역할", "영업이익 (원)", "B 지급액 (원)", "내용"]);
  for (const entry of record.history) {
    const row = history.addRow(["정산 보관본", entry.at, entry.id, entry.actorName, entry.version, entry.summary.profit, entry.summary.payableB, entry.reason]);
    row.getCell(6).numFmt = MONEY; row.getCell(7).numFmt = MONEY;
  }
  for (const event of input.audit ?? []) history.addRow(["감사 기록", event.occurredAt, event.id, event.actorId, event.actorRole, null, null, event.action]);
  for (const comment of record.comments) history.addRow(["정산 의견", comment.at, comment.id, comment.actorName, "", null, null, comment.body]);
  if (!record.history.length && !input.audit?.length && !record.comments.length) history.addRow(["기록 없음"]);

  // Stable widths, wrapped long evidence/notes and readable print titles on all sheets.
  for (const ws of workbook.worksheets) {
    ws.pageSetup.printTitlesRow = "1:4";
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: typeof cell.value === "number" ? "right" : "left" };
        if (!cell.font?.name) cell.font = { name: "맑은 고딕", size: 10, color: { argb: INK } };
      });
      if (row.number > 4) {
        let requiredLines = 1;
        row.eachCell((cell, index) => {
          if (typeof cell.value === "string") requiredLines = Math.max(requiredLines, cell.value.split("\n").reduce((total, part) => total + Math.max(1, Math.ceil(part.length * 1.6 / (ws.getColumn(index).width ?? 20))), 0));
        });
        row.height = Math.max(row.height ?? 24, Math.min(360, requiredLines * 16));
      }
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function dateCell(value: string): Date | string {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.valueOf()) ? date : value;
}
