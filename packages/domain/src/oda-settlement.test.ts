import assert from "node:assert/strict";
import test from "node:test";
import { calculateOdaMonth, createOdaMonth, parseOdaCsv, type OdaLine, type OdaMonth, type OdaSource } from "./oda-settlement.ts";

const NOW = "2026-10-01T00:00:00.000Z";
function source(id: string, kind: OdaSource["kind"], channel = "pos"): OdaSource {
  return { id, kind, channel, fileName: `${id}.csv`, sha256: "a".repeat(64), importedAt: NOW, importedBy: "actor-a", rowCount: 1, sizeBytes: 100, mimeType: "text/csv" };
}
function line(id: string, kind: OdaLine["kind"], amount: number, overrides: Partial<OdaLine> = {}): OdaLine {
  return { id, date: "2026-09-30", kind, amount, vat: 0, description: id, category: kind === "revenue" ? "sales" : kind === "bank" ? "bank" : "ingredients", channel: "pos", sourceId: kind === "revenue" ? "pos" : "cost", sourceRow: 2, externalId: "", reviewed: true, note: "", ...overrides };
}
function ready(): OdaMonth {
  const month = createOdaMonth("oda-hoegi", "2026-09", NOW);
  month.policy = { ...month.policy, attributionBasis: "accrual", vatBasis: "gross", posDeliveryScope: "excluded", bVatPolicy: "add10", agreementNote: "귀속월 손익 / POS는 배달 제외 / 부가세 포함 / B 월 정산에 10% 별도 / 1원 A 귀속", acknowledgements: { A: { actorId: "actor-a", actorName: "운영자 A", at: NOW }, B: { actorId: "actor-b", actorName: "지원자 B", at: NOW } } };
  month.sources = [source("pos", "pos"), source("cost", "expense")];
  month.lines = [line("매출", "revenue", 30_000_000), line("비용", "expense", 20_000_000)];
  return month;
}
const hasBlock = (data: OdaMonth, code: string): boolean => calculateOdaMonth(data).blockers.some((issue) => issue.code === code);

test("계약 제5조: 이익 1천만원은 A 650만원/B 350만원, B VAT는 운영비에 재투입하지 않는다", () => {
  const result = calculateOdaMonth(ready());
  assert.equal(result.profit, 10_000_000);
  assert.equal(result.priorityA, 3_000_000);
  assert.equal(result.shareA, 6_500_000);
  assert.equal(result.shareB, 3_500_000);
  assert.equal(result.vatB, 350_000);
  assert.equal(result.payableB, 3_850_000);
  assert.equal(result.expenses, 20_000_000);
  assert.equal(result.canFinalize, true);
  assert.equal(result.statementDueDate, "2026-10-05");
  assert.equal(result.paymentDueDate, "2026-10-10");
});

test("A 선공제액과 정확히 같은 이익은 B 배분 0원", () => {
  const data = ready(); data.lines[0]!.amount = 23_000_000;
  const result = calculateOdaMonth(data);
  assert.equal(result.shareA, 3_000_000); assert.equal(result.shareB, 0); assert.equal(result.payableB, 0); assert.equal(result.canFinalize, true);
});

for (const profit of [2_000_000, 0, -1_000_000]) test(`이익 ${profit}원의 미합의 부족분/손실은 지급 확정을 보류`, () => {
  const data = ready(); data.lines[0]!.amount = 20_000_000 + profit;
  const result = calculateOdaMonth(data);
  assert.equal(result.shareA, null); assert.equal(result.shareB, null); assert.equal(result.payableB, null); assert.equal(result.canFinalize, false);
});

test("가용이익 한도 합의는 비음수 저이익에만 적용하며 적자는 계속 HOLD", () => {
  const data = ready(); data.policy.lowProfitPolicy = "available_profit_only"; data.lines[0]!.amount = 22_000_000;
  const result = calculateOdaMonth(data);
  assert.equal(result.shareA, 2_000_000); assert.equal(result.shareB, 0); assert.equal(result.canFinalize, true);
  data.lines[0]!.amount = 19_000_000;
  assert.equal(hasBlock(data, "loss_policy_unresolved"), true);
});

test("홀수 잔여이익은 합의한 1원 귀속을 보존하고 A+B가 이익과 일치", () => {
  const data = ready(); data.lines[0]!.amount += 1;
  let result = calculateOdaMonth(data);
  assert.equal(result.shareA, 6_500_001); assert.equal(result.shareB, 3_500_000);
  data.policy.roundingBeneficiary = "B"; result = calculateOdaMonth(data);
  assert.equal(result.shareA, 6_500_000); assert.equal(result.shareB, 3_500_001);
  assert.equal(result.shareA! + result.shareB!, result.profit);
});

test("A 선공제·감가상각·B 배분·투자·보증금·사업주이체를 운영비에서 제외", () => {
  const data = ready();
  for (const category of ["a_priority", "depreciation", "b_distribution", "capex", "deposit", "owner_transfer"]) data.lines.push(line(category, "expense", 500_000, { category }));
  const result = calculateOdaMonth(data);
  assert.equal(result.expenses, 20_000_000); assert.equal(result.excluded, 3_000_000); assert.equal(result.shareB, 3_500_000);
});

test("100만원 이상 투자는 B의 서면동의 근거가 있어야 확정 가능", () => {
  const data = ready(); data.lines.push(line("오븐", "excluded", 1_000_000, { category: "capex" }));
  assert.equal(hasBlock(data, "investment_consent_missing"), true);
  data.lines[2]!.approvalSourceId = "consent"; data.sources.push(source("consent", "evidence"));
  assert.equal(hasBlock(data, "investment_consent_missing"), false);
});

test("배달 총매출·수수료·플랫폼 예정입금·실제 계좌입금을 구분한다", () => {
  const data = ready(); data.policy.activeChannels.push("배민");
  data.sources.push(source("platform", "platform", "baemin"), source("bank", "bank", "baemin"));
  data.lines = [line("POS", "revenue", 10_000_000), line("배달", "revenue", 1_000_000, { sourceId: "platform", channel: "baemin" }), line("수수료", "expense", 200_000, { sourceId: "platform", category: "fees", channel: "baemin" }), line("정산예정", "bank", 800_000, { sourceId: "platform", channel: "baemin" }), line("입금", "bank", 800_000, { sourceId: "bank", channel: "baemin" })];
  const result = calculateOdaMonth(data);
  assert.equal(result.revenue, 11_000_000); assert.equal(result.expenses, 200_000); assert.equal(result.bankInflow, 800_000); assert.equal(result.platformPayout, 800_000);
});

test("제외한 계좌 입출금·플랫폼 예정입금은 원래 bank 분류가 남아도 합산하지 않는다", () => {
  const data = ready();
  data.sources.push(source("bank", "bank"), source("platform", "platform", "baemin"));
  data.lines.push(
    line("제외 입금", "excluded", 800_000, { sourceId: "bank", category: "bank" }),
    line("제외 출금", "excluded", -100_000, { sourceId: "bank", category: "bank" }),
    line("제외 예정입금", "excluded", 700_000, { sourceId: "platform", category: "bank", channel: "baemin" }),
    line("실제 입금", "bank", 600_000, { sourceId: "bank" }),
  );
  const result = calculateOdaMonth(data);
  assert.equal(result.bankInflow, 600_000); assert.equal(result.bankOutflow, 0); assert.equal(result.platformPayout, 0);
  assert.equal(result.excludedCount, 3); assert.equal(result.excluded, 1_400_000);
  assert.equal(result.profit, 10_000_000);
});

test("POS에 배달 포함이면 플랫폼 매출만 제외하고 플랫폼 비용은 유지", () => {
  const data = ready(); data.policy.posDeliveryScope = "included"; data.policy.activeChannels.push("coupang"); data.sources.push(source("platform", "platform", "쿠팡이츠"));
  data.lines.push(line("배달", "revenue", 1_000_000, { sourceId: "platform", channel: "coupang" }), line("수수료", "expense", 200_000, { sourceId: "platform", channel: "coupang", category: "fees" }));
  const result = calculateOdaMonth(data);
  assert.equal(result.revenue, 30_000_000); assert.equal(result.expenses, 20_200_000); assert.equal(result.ignoredRevenueCount, 1);
});

test("부가세 제외 기준은 실제 VAT를 사용하고 면세 0을 허용하며 누락은 HOLD", () => {
  const data = ready(); data.policy.vatBasis = "net";
  data.lines[0]!.vat = 2_000_000; data.lines[1]!.vat = 1_000_000;
  let result = calculateOdaMonth(data); assert.equal(result.revenue, 28_000_000); assert.equal(result.expenses, 19_000_000);
  data.lines[1]!.vat = null; assert.equal(hasBlock(data, "vat_missing"), true);
  data.lines[1]!.vat = 0; result = calculateOdaMonth(data); assert.equal(result.expenses, 20_000_000); assert.equal(result.canFinalize, true);
});

test("환불·매입환급의 음수 부호를 보존하고 잘못된 VAT 부호는 차단", () => {
  const data = ready(); data.lines.push(line("환불", "revenue", -110_000, { vat: -10_000 }), line("매입환급", "expense", -55_000, { vat: -5_000 })); data.policy.vatBasis = "net";
  assert.equal(calculateOdaMonth(data).profit, 9_950_000);
  data.lines[2]!.vat = 10_000; assert.equal(hasBlock(data, "invalid_money"), true);
});

test("활성 채널 원본 누락·미분류·검토 미완료·다른 귀속월은 확정을 차단", () => {
  const data = ready(); data.policy.activeChannels.push("baemin"); data.lines.push(line("미상", "expense", 1_000, { category: "uncategorized", reviewed: false }), line("전월", "revenue", 1_000, { date: "2026-08-31" }));
  for (const code of ["sales_source_missing", "category_unresolved", "line_unreviewed", "wrong_month"]) assert.equal(hasBlock(data, code), true, code);
});

test("A/B 동일 계정 또는 합의 미확인과 미정 기준은 확정을 차단", () => {
  const data = ready(); data.policy.acknowledgements.B!.actorId = "actor-a";
  assert.equal(hasBlock(data, "policy_acknowledgements_invalid"), true);
  delete data.policy.acknowledgements.B; assert.equal(hasBlock(data, "policy_acknowledgements_missing"), true);
  data.policy.vatBasis = "unresolved"; data.policy.posDeliveryScope = "unresolved"; data.policy.bVatPolicy = "unresolved"; data.policy.attributionBasis = "unresolved";
  for (const code of ["vat_basis_unresolved", "pos_scope_unresolved", "b_vat_unresolved", "attribution_unresolved"]) assert.equal(hasBlock(data, code), true);
});

test("월중 개업은 합의 전 HOLD, 일할은 실제 월 일수로 원 단위 반올림", () => {
  const data = ready(); data.policy.partialMonth = true; data.policy.operatingDays = 14;
  assert.equal(hasBlock(data, "partial_month_unresolved"), true);
  data.policy.partialMonthPolicy = "prorate"; assert.equal(calculateOdaMonth(data).priorityA, 1_400_000);
  data.policy.partialMonthPolicy = "full_priority"; assert.equal(calculateOdaMonth(data).priorityA, 3_000_000);
});

test("12월 정산 기한은 다음 해 달력상 5일/10일", () => {
  const data = createOdaMonth("oda", "2026-12", NOW);
  const result = calculateOdaMonth(data); assert.equal(result.statementDueDate, "2027-01-05"); assert.equal(result.paymentDueDate, "2027-01-10");
});

test("전월 반복 비용은 확인 전 손익 미반영, 제외한 제안은 원본 강제 안 함", () => {
  const data = ready(); data.lines.push(line("임대료 제안", "expense", 3_000_000, { externalId: "repeat:rent", sourceId: "", reviewed: false, category: "rent" }));
  assert.equal(calculateOdaMonth(data).expenses, 20_000_000); assert.equal(hasBlock(data, "line_unreviewed"), true);
  Object.assign(data.lines[2]!, { kind: "excluded", reviewed: true, note: "당월 발생하지 않음" });
  assert.equal(calculateOdaMonth(data).canFinalize, true);
});

test("정수 범위 초과 합계는 근삿값을 표시하지 않고 오류 처리", () => {
  const data = ready(); data.lines = [line("대금1", "revenue", Number.MAX_SAFE_INTEGER), line("대금2", "revenue", 1)];
  assert.throws(() => calculateOdaMonth(data), /정수 범위/);
});

test("CSV BOM·따옴표 쉼표·줄바꿈·escaped quotes·CRLF를 보존", () => {
  const parsed = parseOdaCsv('\uFEFF귀속일,내용,금액,부가세,분류,채널,거래번호\r\n2026-09-01,"매장, \"\"주문\"\"\r\n메모","1,100",100,매출,매장,T1\r\n', { sourceId: "csv", kind: "revenue", month: "2026-09" });
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.lines.length, 1); assert.equal(parsed.lines[0]!.description, '매장, "주문"\n메모'); assert.equal(parsed.lines[0]!.amount, 1100); assert.equal(parsed.lines[0]!.channel, "pos"); assert.equal(parsed.lines[0]!.sourceRow, 2);
});

test("CSV 날짜·소수·그룹 쉼표·VAT·귀속월 오류를 행별로 보고", () => {
  const parsed = parseOdaCsv('date,description,amount,vat\n2026-02-30,bad,1,0\n2026-09-01,bad,1.25,0\n2026-09-02,bad,"1,00",0\n2026-09-03,bad,100,200\n2026-08-01,bad,100,0\n', { sourceId: "csv", kind: "revenue", month: "2026-09" });
  assert.equal(parsed.lines.length, 0);
  assert.deepEqual(parsed.errors.map((error) => error.code), ["invalid_date", "invalid_amount", "invalid_amount", "vat_mismatch", "wrong_month"]);
});

test("CSV 거래번호+채널+유형 중복은 파일 안팎에서 제외, 비용과 매출은 구분", () => {
  const existing = line("existing", "revenue", 1100, { externalId: "T1", channel: "baemin", date: "2026-09-01", vat: null });
  const parsed = parseOdaCsv('date,amount,category,channel,externalId,kind\n2026-09-01,1100,sales,배민,T1,revenue\n2026-09-01,200,fees,배민,T1,expense\n2026-09-01,200,fees,배민,T1,expense\n2026-09-01,1100,sales,쿠팡이츠,T1,revenue', { sourceId: "csv", kind: "revenue", existingLines: [existing] });
  assert.equal(parsed.lines.length, 2); assert.equal(parsed.duplicateCount, 2); assert.deepEqual(parsed.errors, []);
});

test("거래번호 없는 같은 금액 거래는 몰래 삭제하지 않고 다른 파일의 중복 후보만 검토 요청", () => {
  const csv = 'date,description,amount,vat,category,channel\n2026-09-30,우유,1000,0,ingredients,pos\n2026-09-30,우유,1000,0,ingredients,pos';
  const first = parseOdaCsv(csv, { sourceId: "first", kind: "expense" }); assert.equal(first.lines.length, 2); assert.equal(first.lines[0]!.reviewed, true);
  const second = parseOdaCsv(csv, { sourceId: "second", kind: "expense", existingLines: first.lines });
  assert.equal(second.lines.length, 2); assert.equal(second.lines[0]!.reviewed, false); assert.equal(second.warnings.filter((w) => w.code === "duplicate_candidate").length, 2);
});

test("CSV 플랫폼 총매출·수수료·입금 열을 별개 유형으로 확장", () => {
  const parsed = parseOdaCsv('귀속일,내용,금액,부가세,수수료금액,수수료부가세,정산금액,거래번호\n2026-09-30,배민마감,1100000,100000,220000,20000,880000,T1', { sourceId: "platform", kind: "revenue", channel: "배민" });
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.lines.length, 3);
  assert.deepEqual(parsed.lines.map((l) => [l.kind, l.amount, l.vat]), [["revenue", 1_100_000, 100_000], ["expense", 220_000, 20_000], ["bank", 880_000, null]]);
});

test("정산입금액만 있는 플랫폼 파일을 총매출로 오인하지 않는다", () => {
  const csv = '귀속일,정산금액\n2026-09-30,880000';
  const revenue = parseOdaCsv(csv, { sourceId: "csv", kind: "revenue" }); assert.equal(revenue.errors[0]!.code, "payout_not_revenue");
  const bank = parseOdaCsv(csv, { sourceId: "csv", kind: "bank" }); assert.equal(bank.errors[0]!.code, "bank_amount_header_missing"); assert.equal(bank.lines.length, 0);
});

test("통장 입금액·출금액을 전처리 없이 부호 있는 대사 거래로 읽는다", () => {
  const parsed = parseOdaCsv('거래일시,적요,입금액,출금액,거래번호\n2026-09-01 09:31:22,플랫폼 입금,"1,100,000",,B1\n2026-09-02,임차료,,330000,B2', { sourceId: "bank", kind: "bank", month: "2026-09" });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.lines.map((line) => [line.kind, line.amount, line.category, line.externalId, line.date]), [["bank", 1100000, "bank", "B1", "2026-09-01"], ["bank", -330000, "bank", "B2", "2026-09-02"]]);
  for (const [credit, debit] of [["입금", "출금"], ["맡기신 금액", "찾으신 금액"], ["입금금액", "출금금액"], ["creditAmount", "debitAmount"]]) {
    const aliases = parseOdaCsv(`날짜,${credit},${debit}\n2026-09-01,0,1000\n2026-09-02,2000,0`, { sourceId: "bank", kind: "bank" });
    assert.deepEqual(aliases.errors, []); assert.deepEqual(aliases.lines.map((line) => line.amount), [-1000, 2000]);
  }
});

test("입금·출금 동시 입력, 빈 거래, 음수·소수점·잘못된 금액과 합계 불일치는 거절한다", () => {
  const parsed = parseOdaCsv('날짜,금액,입금액,출금액\n2026-09-01,100,200,100\n2026-09-02,0,,\n2026-09-03,-100,-100,0\n2026-09-04,-100,0,1.5\n2026-09-05,100,0,100\n2026-09-06,bad,200,0', { sourceId: "bank", kind: "bank" });
  assert.equal(parsed.lines.length, 0);
  assert.deepEqual(parsed.errors.map((error) => error.code), ["bank_both_directions", "bank_empty_flow", "invalid_credit_amount", "invalid_debit_amount", "bank_amount_conflict", "invalid_amount"]);
});

test("명시된 실제 거래금액은 입금−출금과 일치해야 하며 빈 금액은 입출금으로 계산한다", () => {
  const parsed = parseOdaCsv('date,amount,creditAmount,debitAmount,payoutAmount,feeAmount\n2026-09-01,-100,0,100,9900,500\n2026-09-02,,200,,8800,300', { sourceId: "bank", kind: "bank" });
  assert.deepEqual(parsed.errors, []); assert.deepEqual(parsed.lines.map((line) => line.amount), [-100, 200]);
  assert.equal(parsed.lines.length, 2); assert.equal(parsed.warnings[0]!.code, "bank_auxiliary_ignored");
});

test("단일 입금 또는 출금 열도 지원하며 계좌 파일을 매출·비용으로 가져오지 않는다", () => {
  const debitOnly = parseOdaCsv('date,출금액\n2026-09-01,1000', { sourceId: "bank", kind: "bank" });
  const creditOnly = parseOdaCsv('date,입금액\n2026-09-01,1000', { sourceId: "bank", kind: "bank" });
  assert.deepEqual(debitOnly.errors, []); assert.equal(debitOnly.lines[0]!.amount, -1000);
  assert.deepEqual(creditOnly.errors, []); assert.equal(creditOnly.lines[0]!.amount, 1000);
  const incorrect = parseOdaCsv('date,입금액\n2026-09-01,1000', { sourceId: "pos", kind: "revenue" });
  assert.equal(incorrect.errors[0]!.code, "bank_flow_requires_bank");
  const spoofed = parseOdaCsv('date,입금액,유형\n2026-09-01,1000,매출', { sourceId: "bank", kind: "bank" });
  assert.equal(spoofed.errors[0]!.code, "invalid_bank_kind"); assert.equal(spoofed.lines.length, 0);
});

test("명시된 제외 항목은 확인 대상으로 남기고 미상 지출을 임의로 확정하지 않는다", () => {
  const parsed = parseOdaCsv('귀속일,내용,금액,분류\n2026-09-01,공사,1000000,투자비\n2026-09-02,카드결제,10000,\n2026-09-03,9월 임대료,1000000,', { sourceId: "csv", kind: "expense" });
  assert.deepEqual(parsed.lines.map((l) => [l.category, l.reviewed]), [["capex", false], ["uncategorized", false], ["rent", true]]);
});

test("잘못된 CSV 따옴표·중복 헤더·빈파일·행 열수 불일치를 거절", () => {
  for (const [csv, code] of [['date,amount\n2026-09-01,"100', 'malformed_csv'], ['date,amount,금액\n2026-09-01,100,100', 'duplicate_header'], ['', 'empty_csv'], ['date,amount\n2026-09-01,1,000', 'column_count_mismatch']] as const) {
    const parsed = parseOdaCsv(csv, { sourceId: "csv", kind: "revenue" }); assert.equal(parsed.errors[0]!.code, code);
  }
});

test("POS 원본의 배달채널 행은 유지하고 플랫폼 원본 중복 매출만 제외", () => {
  const data = ready(); data.policy.posDeliveryScope = "included"; data.policy.activeChannels.push("baemin"); data.sources.push(source("platform", "platform", "baemin"));
  data.lines = [line("매장", "revenue", 10_000_000), line("POS배달", "revenue", 5_000_000, { channel: "baemin" }), line("플랫폼배달", "revenue", 5_000_000, { channel: "baemin", sourceId: "platform" })];
  const result = calculateOdaMonth(data); assert.equal(result.revenue, 15_000_000); assert.equal(result.ignoredRevenueCount, 1);
});

test("일반 비용 분류로 들어온 A 선공제·감가상각·B 정산금 충돌은 자동 반영 안 함", () => {
  const parsed = parseOdaCsv('date,amount,category,description\n2026-09-01,3000000,인건비,점주인건비\n2026-09-01,1000000,기타 운영비,감가상각비\n2026-09-01,3500000,수수료,B 정산금\n2026-09-01,5000000,기타 운영비,인테리어 공사', { sourceId: "csv", kind: "expense" });
  assert.deepEqual(parsed.lines.map((entry) => [entry.category, entry.reviewed]), [["a_priority", false], ["depreciation", false], ["b_distribution", false], ["capex", false]]);
  assert.equal(parsed.warnings.filter((w) => w.code === "excluded_category_conflict").length, 4);
});

test("계좌 출금 비용 전환은 원본/금액 일치를 검증하고 한번만 반영", () => {
  const data = ready(); data.sources.push(source("bank", "bank"));
  data.lines.push(line("bank-1", "bank", -100_000, { sourceId: "bank" }), line("cost-1", "expense", 100_000, { sourceId: "bank", bankLineId: "bank-1" }));
  let result = calculateOdaMonth(data); assert.equal(result.expenses, 20_100_000); assert.equal(result.bankOutflow, 100_000); assert.equal(result.canFinalize, true);
  data.lines.push(line("cost-duplicate", "expense", 100_000, { sourceId: "bank", bankLineId: "bank-1" }));
  result = calculateOdaMonth(data); assert.equal(result.expenses, 20_100_000); assert.equal(hasBlock(data, "bank_derivation_duplicate"), true);
  data.lines.pop(); data.lines[3]!.amount = 90_000; assert.equal(hasBlock(data, "bank_derivation_invalid"), true);
});

test("계좌 출금에서 만든 비용과 별도 매입명세서의 같은 날짜·금액·분류는 확인 대상", () => {
  const existing = line("bank-cost", "expense", 100_000, { description: "계좌적요 주식회사", bankLineId: "bank-1", channel: "bank" });
  const parsed = parseOdaCsv('date,description,amount,category,channel,externalId\n2026-09-30,식재료 명세서,100000,ingredients,supplier,T1', { sourceId: "receipt", kind: "expense", existingLines: [existing] });
  assert.equal(parsed.lines.length, 1); assert.equal(parsed.lines[0]!.reviewed, false); assert.equal(parsed.warnings[0]!.code, "duplicate_candidate");
});

test("동일 주문번호의 매출과 취소는 둘 다 보존하고 확인 뒤 순매출 0원으로 반영", () => {
  const parsed = parseOdaCsv('date,amount,externalId,description\n2026-09-01,100000,order1,피자주문\n2026-09-02,-100000,order1,주문취소', { sourceId: "pos", kind: "revenue" });
  assert.equal(parsed.lines.length, 2); assert.equal(parsed.duplicateCount, 0); assert.equal(parsed.lines[1]!.reviewed, false); assert.equal(parsed.warnings[0]!.code, "external_id_collision");
  const data = ready(); data.lines = parsed.lines;
  let result = calculateOdaMonth(data); assert.equal(result.revenue, 0); assert.equal(hasBlock(data, "line_unreviewed"), true);
  data.lines[1]!.reviewed = true; result = calculateOdaMonth(data); assert.equal(result.revenue, 0); assert.equal(hasBlock(data, "duplicate_external_id"), false);
});

test("수동 비용도 명시적인 A 선공제 내용은 일반 인건비로 이중 공제할 수 없다", () => {
  const data = ready(); data.lines.push(line("manual-priority", "expense", 3_000_000, { description: "A 선공제", category: "labor" }));
  const result = calculateOdaMonth(data); assert.equal(result.expenses, 20_000_000); assert.equal(result.excluded, 3_000_000);
});
