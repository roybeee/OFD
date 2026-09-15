/** ODA contract settlement. All amounts are signed, integer KRW; expenses are positive costs. */
export type OdaLineKind = "revenue" | "expense" | "bank" | "excluded";
export type OdaSourceKind = "pos" | "platform" | "bank" | "expense" | "evidence";
export type OdaParty = "A" | "B";
export const ODA_DELIVERY_CHANNELS = [
  { value: "baemin", label: "배달의민족" }, { value: "coupang", label: "쿠팡이츠" },
  { value: "yogiyo", label: "요기요" }, { value: "ddangyo", label: "땡겨요" },
] as const;
export type OdaDeliveryChannel = typeof ODA_DELIVERY_CHANNELS[number]["value"];
export type OdaPosDeliveryScope = "unresolved" | "included" | "excluded";
export interface OdaAcknowledgement { actorId: string; actorName: string; at: string }
export interface OdaPolicy {
  attributionBasis: "unresolved" | "accrual";
  activeChannels: string[];
  vatBasis: "unresolved" | "gross" | "net";
  /** Legacy all-channel setting, retained for existing records and snapshots. */
  posDeliveryScope: OdaPosDeliveryScope;
  /** When present, this takes precedence over the legacy all-channel setting. */
  posDeliveryScopes?: Record<OdaDeliveryChannel, OdaPosDeliveryScope>;
  bVatPolicy: "unresolved" | "add10" | "none";
  lowProfitPolicy: "hold" | "available_profit_only";
  partialMonthPolicy: "hold" | "full_priority" | "prorate";
  partialMonth: boolean;
  operatingDays: number;
  roundingBeneficiary: OdaParty;
  agreementNote: string;
  /** Written only from authenticated server identities; clear on policy changes. */
  acknowledgements: Partial<Record<OdaParty, OdaAcknowledgement>>;
}
export interface OdaLine {
  id: string;
  date: string;
  kind: OdaLineKind;
  description: string;
  /** Gross amount; negative revenue is a refund, negative expense is a credit. */
  amount: number;
  /** Explicit VAT component of amount; null means unknown, 0 means zero VAT. */
  vat: number | null;
  category: string;
  channel: string;
  sourceId: string;
  sourceRow: number;
  externalId: string;
  reviewed: boolean;
  note: string;
  /** Source of B's prior written investment consent, when applicable. */
  approvalSourceId?: string;
  /** Expense explicitly derived from an original cash outflow, exactly once. */
  bankLineId?: string;
  /** Server-retained classification before exclusion, used for an exact restoration. */
  originalKind?: Exclude<OdaLineKind, "excluded">;
  originalCategory?: string;
  /** Applied store rule at import time; retained after a later manual correction. */
  categoryRule?: { id: string; version: number; description: string; category: string };
}
export interface OdaSource {
  id: string;
  fileName: string;
  sha256: string;
  kind: OdaSourceKind;
  channel: string;
  importedAt: string;
  importedBy: string;
  rowCount: number;
  sizeBytes: number;
  mimeType: string;
}
export interface OdaComment { id: string; actorId: string; actorName: string; at: string; body: string }
export interface OdaIssue { code: string; message: string; lineId?: string }
export interface OdaCategoryTotal { category: string; amount: number; count: number }
export interface OdaPlatformRevenue {
  channel: string;
  /** Eligible platform revenue rows only, after invalid, duplicate and excluded rows are skipped. */
  gross: number;
  recognized: number;
  ignoredGross: number;
  count: number;
  ignoredCount: number;
}
export interface OdaSummary {
  revenue: number;
  expenses: number;
  profit: number;
  grossRevenue: number;
  grossExpenses: number;
  revenueVat: number;
  expenseVat: number;
  excluded: number;
  bankInflow: number;
  bankOutflow: number;
  /** Platform settlement report payout, kept separate from actual bank receipts. */
  platformPayout: number;
  priorityA: number;
  residualProfit: number;
  shareA: number | null;
  shareB: number | null;
  vatB: number | null;
  payableB: number | null;
  statementDueDate: string;
  paymentDueDate: string;
  unreviewedCount: number;
  excludedCount: number;
  duplicateCount: number;
  ignoredRevenueCount: number;
  revenueByChannel: OdaCategoryTotal[];
  /** Optional for historical snapshots made before platform reconciliation was introduced. */
  platformRevenueByChannel?: OdaPlatformRevenue[];
  expenseByCategory: OdaCategoryTotal[];
  blockers: OdaIssue[];
  warnings: OdaIssue[];
  canFinalize: boolean;
}
export interface OdaSnapshot {
  id: string;
  version: number;
  at: string;
  actorId: string;
  actorName: string;
  reason: string;
  lines: OdaLine[];
  sources: OdaSource[];
  policy: OdaPolicy;
  summary: OdaSummary;
}
export interface OdaMonth {
  id: string;
  storeId: string;
  month: string;
  version: number;
  status: "draft" | "finalized" | "paid";
  lines: OdaLine[];
  sources: OdaSource[];
  policy: OdaPolicy;
  history: OdaSnapshot[];
  comments: OdaComment[];
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizedBy?: string;
  paidAt?: string;
  paidBy?: string;
  paymentReference?: string;
}
export interface OdaCsvOptions {
  sourceId: string;
  kind: OdaLineKind;
  channel?: string;
  /** Restrict rows to their actual accounting month. */
  month?: string;
  /** Optional external identity keys already imported from other sources. */
  existingLines?: readonly OdaLine[];
  expenseRules?: { version: number; rules: readonly { id: string; description: string; category: string }[] };
}
/** Exact matching only: ignore width, repeated whitespace and letter case, never dates or substrings. */
export const normalizeOdaExpenseDescription = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export interface OdaCsvError { row: number; code: string; message: string }
export interface OdaCsvResult { lines: OdaLine[]; errors: OdaCsvError[]; warnings: OdaCsvError[]; duplicateCount: number; rowCount: number }

export const ODA_EXPENSE_CATEGORIES = [
  { value: "ingredients", label: "식재료비" },
  { value: "labor", label: "인건비" },
  { value: "rent", label: "임차료" },
  { value: "utilities", label: "관리비·공과금" },
  { value: "fees", label: "수수료" },
  { value: "marketing", label: "마케팅비" },
  { value: "supplies", label: "소모품비" },
  { value: "other", label: "기타 운영비" },
] as const;

const EXCLUDED_CATEGORIES = new Set(["capex", "deposit", "a_priority", "depreciation", "b_distribution", "owner_transfer"]);
const normalizeText = (value: string): string => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_·ㆍ-]+/g, "");
const CATEGORY_ALIASES: Record<string, string> = {
  ingredients: "ingredients", 식재료비: "ingredients", 식재료: "ingredients", 재료비: "ingredients", 원재료: "ingredients", 원재료비: "ingredients", 매입: "ingredients",
  labor: "labor", 인건비: "labor", 급여: "labor", 직원급여: "labor", 아르바이트: "labor",
  rent: "rent", 임대료: "rent", 임차료: "rent", 월세: "rent",
  utilities: "utilities", 관리비공과금: "utilities", 관리비: "utilities", 공과금: "utilities", 수도광열비: "utilities", 전기요금: "utilities", 가스요금: "utilities", 수도요금: "utilities",
  fees: "fees", 수수료: "fees", 배달수수료: "fees", 카드수수료: "fees", 결제수수료: "fees", 배달대행료: "fees", 플랫폼수수료: "fees",
  marketing: "marketing", 마케팅비: "marketing", 광고비: "marketing", 광고선전비: "marketing",
  supplies: "supplies", 소모품비: "supplies", 소모품: "supplies", 포장재: "supplies",
  other: "other", 기타운영비: "other", 기타비용: "other",
  sales: "sales", 매출: "sales", 매출액: "sales", 판매: "sales", 환불: "sales", 취소: "sales",
  capex: "capex", 투자비: "capex", 시설투자: "capex", 시설비: "capex", 인테리어: "capex", 설비투자: "capex", 장비구입: "capex",
  deposit: "deposit", 보증금: "deposit", 임대보증금: "deposit",
  apriority: "a_priority", a선공제: "a_priority", 점주인건비: "a_priority", 대표인건비: "a_priority", 선공제: "a_priority", a선배분: "a_priority",
  depreciation: "depreciation", 감가상각: "depreciation", 감가상각비: "depreciation",
  bdistribution: "b_distribution", b배분금: "b_distribution", b정산금: "b_distribution", 이익배분: "b_distribution",
  ownertransfer: "owner_transfer", 사업주이체: "owner_transfer", 대표자이체: "owner_transfer", 출자금: "owner_transfer", 자본이체: "owner_transfer",
  bank: "bank", 입금: "bank", 출금: "bank", 정산입금: "bank", 계좌이체: "bank", 계좌거래: "bank", 입출금: "bank",
  uncategorized: "uncategorized", 미분류: "uncategorized",
};
export function normalizeOdaCategory(value: string): string {
  return CATEGORY_ALIASES[normalizeText(value)] ?? "uncategorized";
}
export function normalizeOdaChannel(value: string): string {
  const key = normalizeText(value);
  const aliases: Record<string, string> = { pos: "pos", 매장: "pos", 홀: "pos", 매장pos: "pos", baemin: "baemin", 배민: "baemin", 배달의민족: "baemin", coupang: "coupang", 쿠팡: "coupang", 쿠팡이츠: "coupang", coupangeats: "coupang", yogiyo: "yogiyo", 요기요: "yogiyo", ddangyo: "ddangyo", 땡겨요: "ddangyo" };
  return aliases[key] ?? key;
}
export function getOdaPosDeliveryScope(policy: OdaPolicy, channel: string): OdaPosDeliveryScope {
  if (!policy.posDeliveryScopes) return policy.posDeliveryScope;
  const known = ODA_DELIVERY_CHANNELS.find(item => item.value === normalizeOdaChannel(channel));
  return known ? policy.posDeliveryScopes[known.value] ?? "unresolved" : "unresolved";
}
/** Prepare the channel editor without rewriting saved historical policies. */
export function getOdaPosDeliveryScopes(policy: OdaPolicy): Record<OdaDeliveryChannel, OdaPosDeliveryScope> {
  return Object.fromEntries(ODA_DELIVERY_CHANNELS.map(({ value }) => [value,
    !policy.posDeliveryScopes && value === "ddangyo" ? "unresolved" : getOdaPosDeliveryScope(policy, value),
  ])) as Record<OdaDeliveryChannel, OdaPosDeliveryScope>;
}
function validMonth(value: string): boolean { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1900; }
function monthDays(month: string): number { return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate(); }
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function sumMoney(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new RangeError("정산 금액의 합계가 안전한 원 단위 정수 범위를 벗어났습니다.");
  return value;
}
function integerDivideRound(amount: number, denominator: number): number { return Number((BigInt(amount) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator)); }
export function createOdaMonth(storeId: string, month: string, now = new Date().toISOString()): OdaMonth {
  if (!storeId.trim()) throw new Error("매장 ID가 필요합니다.");
  if (!validMonth(month)) throw new Error("정산월은 YYYY-MM 형식이어야 합니다.");
  return {
    id: `oda:${storeId}:${month}`, storeId, month, version: 1, status: "draft", lines: [], sources: [], history: [], comments: [], createdAt: now, updatedAt: now,
    policy: { attributionBasis: "unresolved", activeChannels: ["pos"], vatBasis: "unresolved", posDeliveryScope: "unresolved", bVatPolicy: "unresolved", lowProfitPolicy: "hold", partialMonthPolicy: "hold", partialMonth: false, operatingDays: monthDays(month), roundingBeneficiary: "A", agreementNote: "", acknowledgements: {} },
  };
}

/** Exact identity, safe across differently exported files. Revenue and fee rows remain distinct. */
export function odaLineExternalKey(line: Pick<OdaLine, "externalId" | "channel" | "kind">): string | null {
  const id = line.externalId.normalize("NFKC").trim();
  return id ? JSON.stringify([normalizeOdaChannel(line.channel), line.kind, id]) : null;
}
/** A candidate match, never sufficient on its own to silently delete a transaction. */
export function odaLineFingerprint(line: Pick<OdaLine, "date" | "kind" | "description" | "amount" | "vat" | "category" | "channel">): string {
  return JSON.stringify([line.date, line.kind, normalizeText(line.description), line.amount, line.vat, normalizeOdaCategory(line.category), normalizeOdaChannel(line.channel)]);
}

export function calculateOdaMonth(data: OdaMonth): OdaSummary {
  if (!validMonth(data.month)) throw new Error("잘못된 정산월입니다.");
  const blockers: OdaIssue[] = [];
  const warnings: OdaIssue[] = [];
  const block = (code: string, message: string, lineId?: string): void => { blockers.push(lineId ? { code, message, lineId } : { code, message }); };
  const warn = (code: string, message: string, lineId?: string): void => { warnings.push(lineId ? { code, message, lineId } : { code, message }); };
  const policy = data.policy;
  if (policy.attributionBasis !== "accrual") block("attribution_unresolved", "매출·비용은 발생한 귀속월로 기록하고 입금월과 구분하는 기준을 확인해 주세요.");
  if (policy.vatBasis !== "gross" && policy.vatBasis !== "net") block("vat_basis_unresolved", "부가세 포함·제외 손익 기준에 대한 합의가 필요합니다.");
  if (!policy.posDeliveryScopes && policy.posDeliveryScope !== "included" && policy.posDeliveryScope !== "excluded") block("pos_scope_unresolved", "POS 매출에 배달 매출이 포함되는지 확인해 주세요.");
  if (policy.bVatPolicy !== "add10" && policy.bVatPolicy !== "none") block("b_vat_unresolved", "계약 제9조의 참조 오류를 확인하고 월 정산의 B 부가세 가산 여부를 합의해 주세요.");
  if (!policy.agreementNote.trim()) block("agreement_missing", "정산 기준의 합의 내용을 기록해 주세요.");
  const ackA = policy.acknowledgements.A;
  const ackB = policy.acknowledgements.B;
  if (!ackA || !ackB) block("policy_acknowledgements_missing", "정산 기준은 A와 B가 각각 본인 계정으로 확인해야 합니다.");
  else if (!ackA.actorId || !ackB.actorId || ackA.actorId === ackB.actorId) block("policy_acknowledgements_invalid", "A와 B는 서로 다른 본인 계정으로 정산 기준을 확인해야 합니다.");
  if (policy.roundingBeneficiary !== "A" && policy.roundingBeneficiary !== "B") block("rounding_unresolved", "5:5 배분 후 남는 1원의 귀속을 확인해 주세요.");
  const days = monthDays(data.month);
  if (!Number.isInteger(policy.operatingDays) || policy.operatingDays < 1 || policy.operatingDays > days) block("operating_days_invalid", "정산월의 실제 운영 일수를 확인해 주세요.");
  if (policy.partialMonth && policy.partialMonthPolicy === "hold") block("partial_month_unresolved", "월중 개업·종료월은 A의 300만원 전액 또는 일할 적용을 별도로 합의해야 합니다.");
  if (!policy.partialMonth && policy.operatingDays !== days) block("partial_month_flag_required", "월 전체보다 짧은 정산 기간은 월중 개업·종료 여부를 확인해 주세요.");
  const channels = [...new Set(policy.activeChannels.map(normalizeOdaChannel).filter(Boolean))];
  if (policy.posDeliveryScopes) {
    const deliveryChannels = new Set([...channels.filter(channel => channel !== "pos"),
      ...data.lines.filter(line => line.kind === "revenue" && data.sources.some(source => source.id === line.sourceId && source.kind === "platform")).map(line => normalizeOdaChannel(line.channel))]);
    for (const channel of deliveryChannels) {
      if (!["included", "excluded"].includes(getOdaPosDeliveryScope(policy, channel))) {
        const label = ODA_DELIVERY_CHANNELS.find(item => item.value === channel)?.label ?? channel;
        block("pos_scope_unresolved", `${label}: POS 매출 포함 여부를 확인해 주세요.`);
      }
    }
  }
  if (!channels.includes("pos")) block("pos_channel_required", "매장 POS 채널을 활성 매출자료 목록에 포함해 주세요.");
  for (const channel of channels) {
    const source = data.sources.some((s) => channel === "pos" ? s.kind === "pos" : s.kind === "platform" && normalizeOdaChannel(s.channel) === channel);
    if (!source) block("sales_source_missing", channel === "pos" ? "POS 월 마감 원본을 첨부해 주세요." : `${ODA_DELIVERY_CHANNELS.find(item => item.value === channel)?.label ?? channel} 월 마감 원본을 첨부해 주세요.`);
  }
  if (!data.lines.length) block("lines_missing", "당월 매출·비용 자료를 추가해 주세요.");
  if (!data.sources.some((s) => s.kind === "expense") && !data.lines.some((line) => line.kind === "expense")) warn("cost_list_empty", "운영비 목록이 비어 있습니다. 누락된 비용이 없는지 확인해 주세요.");
  warn("contract_reference_errors", "계약 제9조는 제6조 및 존재하지 않는 제6조 제4항을 참조합니다. 월 정산 부가세 적용과 비용 표시 기준을 합의 기록으로 보완해야 합니다.");
  warn("bank_reconciliation", "계좌 입출금은 매출·비용 합산에서 제외됩니다. 전월분 입금·정산보류·미지급비용은 원본과 대조해 주세요.");
  let revenue = 0, expenses = 0, grossRevenue = 0, grossExpenses = 0, revenueVat = 0, expenseVat = 0, excluded = 0, bankInflow = 0, bankOutflow = 0, platformPayout = 0, excludedCount = 0, duplicateCount = 0, ignoredRevenueCount = 0;
  const revenueGroups = new Map<string, OdaCategoryTotal>();
  const expenseGroups = new Map<string, OdaCategoryTotal>();
  const platformRevenueGroups = new Map<string, OdaPlatformRevenue>();
  const externalKeys = new Map<string, OdaLine[]>();
  const derivedBankIds = new Set<string>();
  const groupAdd = (map: Map<string, OdaCategoryTotal>, category: string, amount: number): void => { const group = map.get(category) ?? { category, amount: 0, count: 0 }; group.amount = sumMoney(group.amount, amount); group.count++; map.set(category, group); };
  for (const line of data.lines) {
    if (!Number.isSafeInteger(line.amount) || (line.vat !== null && (!Number.isSafeInteger(line.vat) || Math.abs(line.vat) > Math.abs(line.amount) || line.vat !== 0 && Math.sign(line.vat) !== Math.sign(line.amount)))) { block("invalid_money", "금액·부가세는 부호가 일치하는 원 단위 정수여야 하며 부가세가 총액보다 클 수 없습니다.", line.id); continue; }
    if (!validDate(line.date) || line.date.slice(0, 7) !== data.month) { block("wrong_month", "거래 귀속일이 선택한 정산월과 다릅니다.", line.id); continue; }
    if (!line.reviewed) block("line_unreviewed", `${line.description || "거래"}: 분류 또는 중복 여부를 확인해 주세요.`, line.id);
    const dismissedProposal = line.externalId.startsWith("repeat:") && line.kind === "excluded" && line.reviewed && line.note.trim().length > 0;
    if (!dismissedProposal && !data.sources.some((s) => s.id === line.sourceId)) block("source_missing", "거래의 원본 자료가 없습니다.", line.id);
    if (line.externalId.startsWith("repeat:") && !line.reviewed) continue;
    if (line.bankLineId && line.kind !== "excluded") {
      const original = data.lines.find((candidate) => candidate.id === line.bankLineId && candidate.kind === "bank" && candidate.amount < 0);
      if (!original || line.kind !== "expense" || line.amount !== -original.amount || line.sourceId !== original.sourceId || line.date !== original.date) { block("bank_derivation_invalid", "계좌 출금에서 만든 비용의 금액·귀속일·원본 연결이 일치하지 않습니다.", line.id); continue; }
      if (derivedBankIds.has(line.bankLineId)) { block("bank_derivation_duplicate", "같은 계좌 출금이 두 번 비용으로 반영되었습니다.", line.id); continue; }
      derivedBankIds.add(line.bankLineId);
    }
    let category = normalizeOdaCategory(line.category);
    const describedCategory = inferredCategory(line.description, line.kind);
    if (line.kind === "expense" && ["a_priority", "depreciation", "b_distribution"].includes(describedCategory) && category !== describedCategory) {
      category = describedCategory;
      warn("contract_cost_description", "내용이 A 선공제·감가상각·B 배분에 해당하여 운영비에서 제외했습니다. 실제 거래 분류를 확인해 주세요.", line.id);
    }
    const channel = normalizeOdaChannel(line.channel);
    const key = odaLineExternalKey(line);
    if (key && line.kind !== "excluded") {
      const prior = externalKeys.get(key) ?? [];
      if (prior.some((existing) => existing.date === line.date && existing.amount === line.amount && existing.vat === line.vat)) { duplicateCount++; block("duplicate_external_id", "동일 채널·유형·거래번호의 날짜·금액·세액이 중복되었습니다. 원본을 확인한 뒤 하나를 제외해 주세요.", line.id); continue; }
      if (prior.length) warn("external_id_collision", "같은 거래번호의 금액·날짜가 다릅니다. 취소·환불 또는 별도 거래임을 확인한 행을 함께 반영합니다.", line.id);
      externalKeys.set(key, [...prior, line]);
    }
    if (line.kind !== "excluded" && (line.kind === "bank" || category === "bank")) {
      if (data.sources.some((s) => s.id === line.sourceId && s.kind === "platform")) platformPayout = sumMoney(platformPayout, line.amount);
      else if (line.amount >= 0) bankInflow = sumMoney(bankInflow, line.amount);
      else bankOutflow = sumMoney(bankOutflow, -line.amount);
      continue;
    }
    if (line.kind === "excluded" || EXCLUDED_CATEGORIES.has(category)) {
      excluded = sumMoney(excluded, line.amount); excludedCount++;
      if (line.kind === "expense" && EXCLUDED_CATEGORIES.has(category)) warn("excluded_contract_cost", "A 선공제·감가상각·B 배분금·투자·보증금·사업주 이체는 운영비에서 제외했습니다.", line.id);
      if (category === "capex" && line.amount >= 1_000_000 && (!line.approvalSourceId || !data.sources.some((s) => s.id === line.approvalSourceId))) block("investment_consent_missing", "100만원 이상 투자: B의 사전 서면동의 자료를 연결해 주세요.", line.id);
      continue;
    }
    if (category === "uncategorized") block("category_unresolved", "미분류 거래의 운영비 해당 여부를 확인해 주세요.", line.id);
    let platformRevenue: OdaPlatformRevenue | undefined;
    if (line.kind === "revenue" && data.sources.some(source => source.id === line.sourceId && source.kind === "platform")) {
      platformRevenue = platformRevenueGroups.get(channel) ?? { channel, gross: 0, recognized: 0, ignoredGross: 0, count: 0, ignoredCount: 0 };
      platformRevenue.gross = sumMoney(platformRevenue.gross, line.amount); platformRevenue.count++;
      platformRevenueGroups.set(channel, platformRevenue);
    }
    if (platformRevenue && getOdaPosDeliveryScope(policy, channel) === "included") {
      ignoredRevenueCount++;
      platformRevenue.ignoredGross = sumMoney(platformRevenue.ignoredGross, line.amount); platformRevenue.ignoredCount++;
      if (!channels.includes(channel)) block("inactive_channel", "업로드한 매출 채널을 정산 기준의 활성 채널에 추가해 주세요.", line.id);
      continue;
    }
    if (policy.vatBasis === "net" && line.vat === null) block("vat_missing", "부가세 제외 기준에는 거래별 실제 부가세(면세는 0)가 필요합니다.", line.id);
    const value = policy.vatBasis === "net" ? line.amount - (line.vat ?? 0) : line.amount;
    if (line.kind === "revenue") {
      if (platformRevenue) platformRevenue.recognized = sumMoney(platformRevenue.recognized, value);
      if (!channels.includes(channel)) block("inactive_channel", "업로드한 매출 채널을 정산 기준의 활성 채널에 추가해 주세요.", line.id);
      revenue = sumMoney(revenue, value); grossRevenue = sumMoney(grossRevenue, line.amount); revenueVat = sumMoney(revenueVat, line.vat ?? 0); groupAdd(revenueGroups, channel, value);
    } else if (line.kind === "expense") {
      expenses = sumMoney(expenses, value); grossExpenses = sumMoney(grossExpenses, line.amount); expenseVat = sumMoney(expenseVat, line.vat ?? 0); groupAdd(expenseGroups, category, value);
    } else block("kind_invalid", "지원하지 않는 거래 유형입니다.", line.id);
  }
  if (ignoredRevenueCount) warn("pos_delivery_deduplicated", `POS에 포함된 배달 매출 ${ignoredRevenueCount}건은 중복 합산하지 않았습니다. 플랫폼 수수료는 별도 비용으로 반영합니다.`);
  const profit = sumMoney(revenue, -expenses);
  let priorityA = 3_000_000;
  if (policy.partialMonth && policy.partialMonthPolicy === "prorate" && Number.isInteger(policy.operatingDays) && policy.operatingDays > 0 && policy.operatingDays <= days) priorityA = integerDivideRound(3_000_000 * policy.operatingDays, days);
  const residualProfit = sumMoney(profit, -priorityA);
  let shareA: number | null = null, shareB: number | null = null, vatB: number | null = null, payableB: number | null = null;
  if (profit < 0) block("loss_policy_unresolved", "적자월의 손실 부담·이월 규칙은 계약에 없어 지급 확정을 보류합니다.");
  else if (profit < priorityA && policy.lowProfitPolicy !== "available_profit_only") block("low_profit_unresolved", "이익이 A 선공제액보다 작습니다. 부족분·이월 처리에 대한 별도 합의가 필요합니다.");
  else if (profit < priorityA) { shareA = profit; shareB = 0; warn("low_profit_agreed", "합의한 가용이익 한도 적용: A는 당월 이익까지만 배분받고 부족분을 이월하지 않습니다."); }
  else {
    const half = Math.floor(residualProfit / 2);
    const remainder = residualProfit - half * 2;
    shareA = sumMoney(priorityA, half + (policy.roundingBeneficiary === "A" ? remainder : 0));
    shareB = half + (policy.roundingBeneficiary === "B" ? remainder : 0);
  }
  if (shareB !== null && policy.bVatPolicy !== "unresolved") { vatB = policy.bVatPolicy === "add10" ? integerDivideRound(shareB, 10) : 0; payableB = sumMoney(shareB, vatB); }
  const following = new Date(Date.UTC(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 1));
  const nextMonth = following.toISOString().slice(0, 7);
  return { revenue, expenses, profit, grossRevenue, grossExpenses, revenueVat, expenseVat, excluded, bankInflow, bankOutflow, platformPayout, priorityA, residualProfit, shareA, shareB, vatB, payableB, statementDueDate: `${nextMonth}-05`, paymentDueDate: `${nextMonth}-10`, unreviewedCount: data.lines.filter((l) => !l.reviewed).length, excludedCount, duplicateCount, ignoredRevenueCount, revenueByChannel: [...revenueGroups.values()], platformRevenueByChannel: [...platformRevenueGroups.values()], expenseByCategory: [...expenseGroups.values()], blockers, warnings, canFinalize: blockers.length === 0 };
}

type CsvField = "date" | "description" | "amount" | "vat" | "category" | "channel" | "externalId" | "kind" | "note" | "feeAmount" | "feeVat" | "payoutAmount" | "creditAmount" | "debitAmount";
const HEADER_ALIASES: Record<string, CsvField> = {
  date: "date", 귀속일: "date", 날짜: "date", 일자: "date", 거래일: "date", 거래일자: "date", 거래일시: "date", 매출일: "date", 승인일자: "date", 주문일자: "date", 발생일: "date",
  description: "description", 내용: "description", 거래내용: "description", 적요: "description", 내역: "description", 항목: "description", 거래처: "description", 상품명: "description",
  amount: "amount", gross: "amount", 금액: "amount", 총액: "amount", 매출액: "amount", 총매출: "amount", 총매출액: "amount", 거래금액: "amount", 결제금액: "amount", 공급대가: "amount", 실매출액: "amount", 매출금액: "amount",
  vat: "vat", 부가세: "vat", 부가가치세: "vat", 세액: "vat",
  category: "category", 분류: "category", 계정: "category", 계정과목: "category", 비용분류: "category", 비용항목: "category",
  channel: "channel", 채널: "channel", 매출채널: "channel", 플랫폼: "channel",
  externalid: "externalId", 거래번호: "externalId", 거래id: "externalId", 주문번호: "externalId", 승인번호: "externalId", 거래고유번호: "externalId",
  kind: "kind", type: "kind", 유형: "kind", 거래유형: "kind", 구분: "kind",
  note: "note", 메모: "note", 비고: "note",
  feeamount: "feeAmount", 수수료금액: "feeAmount", 수수료합계: "feeAmount", 플랫폼수수료: "feeAmount", 수수료: "feeAmount",
  feevat: "feeVat", 수수료부가세: "feeVat",
  payoutamount: "payoutAmount", 입금예정액: "payoutAmount", 정산입금액: "payoutAmount", 지급액: "payoutAmount", 정산금액: "payoutAmount", 정산액: "payoutAmount", 실입금액: "payoutAmount",
  creditamount: "creditAmount", 입금액: "creditAmount", 입금금액: "creditAmount", 입금: "creditAmount", 맡기신금액: "creditAmount",
  debitamount: "debitAmount", 출금액: "debitAmount", 출금금액: "debitAmount", 출금: "debitAmount", 찾으신금액: "debitAmount",
};
interface TokenizedCsv { rows: { cells: string[]; row: number }[]; error?: OdaCsvError }
function tokenizeCsv(text: string): TokenizedCsv {
  const input = text.replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: TokenizedCsv["rows"] = [];
  let cells: string[] = [], field = "", state: "unquoted" | "quoted" | "closed" = "unquoted", physicalRow = 1, recordRow = 1;
  const pushRow = (): void => { cells.push(field); if (cells.some((value) => value.trim() !== "")) rows.push({ cells, row: recordRow }); cells = []; field = ""; state = "unquoted"; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (state === "quoted") {
      if (char === '"') { if (input[index + 1] === '"') { field += '"'; index++; } else state = "closed"; }
      else if (char === "\r" || char === "\n") { if (char === "\r" && input[index + 1] === "\n") index++; field += "\n"; physicalRow++; }
      else field += char;
      continue;
    }
    if (char === delimiter) { cells.push(field); field = ""; state = "unquoted"; continue; }
    if (char === "\r" || char === "\n") { if (char === "\r" && input[index + 1] === "\n") index++; pushRow(); physicalRow++; recordRow = physicalRow; continue; }
    if (state === "closed") { if (char !== " " && char !== "\t") return { rows: [], error: { row: physicalRow, code: "malformed_csv", message: "닫힌 따옴표 뒤에는 구분자 또는 줄바꿈만 올 수 있습니다." } }; continue; }
    if (char === '"') { if (field.trim()) return { rows: [], error: { row: physicalRow, code: "malformed_csv", message: "따옴표가 잘못 배치되었습니다. CSV 내 따옴표는 두 번 겹쳐 이스케이프해 주세요." } }; field = ""; state = "quoted"; }
    else field += char;
  }
  if (state === "quoted") return { rows: [], error: { row: recordRow, code: "malformed_csv", message: "닫히지 않은 따옴표가 있습니다." } };
  if (field || cells.length) pushRow();
  return { rows };
}
function parseKrw(raw: string): number | null {
  let value = raw.trim().replace(/^(?:₩|KRW)\s*/i, "").replace(/\s*원$/, "");
  if (/^\([^()]+\)$/.test(value)) value = `-${value.slice(1, -1).trim()}`;
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function parseDate(raw: string): string | null {
  const value = raw.trim();
  const match = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match) return null;
  const date = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  return validDate(date) ? date : null;
}
function parseKind(value: string, defaultKind: OdaLineKind): OdaLineKind | null {
  if (!value.trim()) return defaultKind;
  const aliases: Record<string, OdaLineKind> = { revenue: "revenue", 매출: "revenue", 수입: "revenue", expense: "expense", 비용: "expense", 지출: "expense", bank: "bank", 계좌: "bank", 입출금: "bank", 입금: "bank", 출금: "bank", 정산입금: "bank", excluded: "excluded", 제외: "excluded", 정산제외: "excluded" };
  return aliases[normalizeText(value)] ?? null;
}
function inferredCategory(description: string, kind: OdaLineKind): string {
  if (kind === "revenue") return "sales";
  if (kind === "bank") return "bank";
  const exact = normalizeOdaCategory(description);
  if (exact !== "uncategorized") return exact;
  const text = normalizeText(description);
  const confident: [RegExp, string][] = [[/임대료|임차료|월세/, "rent"], [/전기요금|수도요금|가스요금|관리비/, "utilities"], [/배달수수료|카드수수료|결제수수료|플랫폼수수료/, "fees"], [/감가상각/, "depreciation"], [/보증금/, "deposit"], [/a선공제|점주인건비|대표인건비/, "a_priority"], [/b정산금|b배분금/, "b_distribution"], [/인테리어|설비투자|장비구입/, "capex"]];
  return confident.find(([pattern]) => pattern.test(text))?.[1] ?? "uncategorized";
}

/** RFC-4180 CSV/TSV reader with row-local diagnostics. It never guesses VAT or treats bank payouts as revenue. */
export function parseOdaCsv(text: string, options: OdaCsvOptions): OdaCsvResult {
  const result: OdaCsvResult = { lines: [], errors: [], warnings: [], duplicateCount: 0, rowCount: 0 };
  const remembered = new Map(options.expenseRules?.rules.map(rule => [normalizeOdaExpenseDescription(rule.description), rule]) ?? []);
  if (!options.sourceId.trim()) { result.errors.push({ row: 0, code: "source_id_required", message: "원본 자료 ID가 필요합니다." }); return result; }
  if (options.month !== undefined && !validMonth(options.month)) { result.errors.push({ row: 0, code: "invalid_month", message: "정산월은 YYYY-MM 형식이어야 합니다." }); return result; }
  const tokenized = tokenizeCsv(text);
  if (tokenized.error) { result.errors.push(tokenized.error); return result; }
  const header = tokenized.rows[0];
  if (!header) { result.errors.push({ row: 1, code: "empty_csv", message: "CSV 파일이 비어 있습니다." }); return result; }
  const columns = new Map<CsvField, number>();
  for (const [index, value] of header.cells.entries()) {
    const field = HEADER_ALIASES[normalizeText(value)];
    if (!field) continue;
    if (columns.has(field)) result.errors.push({ row: header.row, code: "duplicate_header", message: `${value}: 같은 의미의 열이 두 개입니다. 사용할 열을 하나로 지정해 주세요.` });
    else columns.set(field, index);
  }
  if (!columns.has("date")) result.errors.push({ row: header.row, code: "date_header_missing", message: "귀속일(date) 열이 필요합니다." });
  const hasBankFlowColumns = columns.has("creditAmount") || columns.has("debitAmount");
  if (!columns.has("amount")) {
    if (options.kind === "bank") {
      if (!hasBankFlowColumns) result.errors.push({ row: header.row, code: "bank_amount_header_missing", message: "실제 계좌 거래금액 또는 입금액·출금액 열이 필요합니다. 플랫폼 정산예정액은 통장 거래로 처리하지 않습니다." });
    } else result.errors.push({ row: header.row, code: hasBankFlowColumns ? "bank_flow_requires_bank" : columns.has("payoutAmount") ? "payout_not_revenue" : "amount_header_missing", message: hasBankFlowColumns ? "입금액·출금액으로 구성된 파일은 통장 내역으로 등록해 주세요. 통장 입출금은 매출·비용이 아닙니다." : columns.has("payoutAmount") ? "정산입금액만으로는 매출을 계산할 수 없습니다. 총매출과 수수료 자료를 추가해 주세요." : "금액(amount) 열이 필요합니다." });
  }
  if (options.kind === "bank" && (columns.has("payoutAmount") || columns.has("feeAmount") || columns.has("feeVat"))) result.warnings.push({ row: header.row, code: "bank_auxiliary_ignored", message: "통장 파일의 정산예정액·수수료 열은 추가 거래로 만들지 않습니다. 실제 거래금액 또는 입금액·출금액만 대사에 반영합니다." });
  if (result.errors.length) return result;
  const externalKeys = new Map<string, OdaLine[]>();
  for (const line of options.existingLines ?? []) {
    const key = odaLineExternalKey(line);
    if (key && line.kind !== "excluded") externalKeys.set(key, [...(externalKeys.get(key) ?? []), line]);
  }
  const previousFingerprints = new Set((options.existingLines ?? []).filter((line) => line.sourceId !== options.sourceId && line.kind !== "excluded").map(odaLineFingerprint));
  const append = (line: OdaLine): void => {
    const key = odaLineExternalKey(line);
    if (key && line.kind !== "excluded") {
      const prior = externalKeys.get(key) ?? [];
      if (prior.some((existing) => existing.date === line.date && existing.amount === line.amount && existing.vat === line.vat)) { result.duplicateCount++; result.warnings.push({ row: line.sourceRow, code: "duplicate_external_id", message: `${line.externalId}: 거래번호·날짜·금액·부가세가 같은 중복 행을 건너뛰었습니다.` }); return; }
      if (prior.length) { line.reviewed = false; line.note = [line.note, "같은 거래번호의 날짜·금액이 다름: 취소·환불 또는 별도 거래인지 확인 필요"].filter(Boolean).join(" / "); result.warnings.push({ row: line.sourceRow, code: "external_id_collision", message: `${line.externalId}: 같은 거래번호의 금액·날짜가 다른 행을 보존했습니다. 취소·환불 등 원본을 확인해 주세요.` }); }
      externalKeys.set(key, [...prior, line]);
    }
    const bankExpenseCandidate = line.kind === "expense" && (options.existingLines ?? []).some((existing) => existing.kind === "expense" && existing.bankLineId && existing.date === line.date && existing.amount === line.amount && normalizeOdaCategory(existing.category) === normalizeOdaCategory(line.category));
    if ((!key && previousFingerprints.has(odaLineFingerprint(line))) || bankExpenseCandidate) { line.reviewed = false; line.note = [line.note, "다른 원본과 날짜·금액·내용이 같습니다. 별개 거래인지 확인 필요"].filter(Boolean).join(" / "); result.warnings.push({ row: line.sourceRow, code: "duplicate_candidate", message: "다른 파일과 일치하는 거래입니다. 실제로 별개 거래인지 확인해 주세요." }); }
    result.lines.push(line);
  };
  for (const record of tokenized.rows.slice(1)) {
    result.rowCount++;
    const before = result.errors.length;
    const value = (field: CsvField): string => { const index = columns.get(field); return index === undefined ? "" : (record.cells[index] ?? "").trim(); };
    const error = (code: string, message: string): void => { result.errors.push({ row: record.row, code, message }); };
    if (record.cells.length !== header.cells.length) { error("column_count_mismatch", `열 수가 제목 행(${header.cells.length}개)과 다릅니다. 쉼표가 있는 금액·내용은 따옴표로 감싸 주세요.`); continue; }
    const date = parseDate(value("date"));
    if (!date) error("invalid_date", "귀속일을 YYYY-MM-DD 형식의 실제 날짜로 입력해 주세요.");
    else if (options.month && date.slice(0, 7) !== options.month) error("wrong_month", `${date}: 선택한 정산월(${options.month})의 거래가 아닙니다.`);
    const amountText = value("amount");
    let amount = amountText ? parseKrw(amountText) : null;
    if (options.kind === "bank" && hasBankFlowColumns) {
      const creditText = value("creditAmount"), debitText = value("debitAmount");
      const credit = creditText ? parseKrw(creditText) : 0, debit = debitText ? parseKrw(debitText) : 0;
      if (credit === null || credit < 0) error("invalid_credit_amount", "입금액은 0 이상의 원 단위 정수여야 합니다. 입금이 없으면 비워두거나 0을 입력해 주세요.");
      if (debit === null || debit < 0) error("invalid_debit_amount", "출금액은 0 이상의 원 단위 정수여야 합니다. 출금이 없으면 비워두거나 0을 입력해 주세요.");
      if (credit !== null && debit !== null && credit >= 0 && debit >= 0) {
        if (credit > 0 && debit > 0) error("bank_both_directions", "한 거래에 입금액과 출금액이 모두 있습니다. 원본 거래를 확인해 주세요.");
        else if (credit === 0 && debit === 0) error("bank_empty_flow", "한 거래에는 입금액 또는 출금액 중 하나가 있어야 합니다.");
        else {
          const signedAmount = credit - debit;
          if (amountText && amount === null) error("invalid_amount", "거래금액은 소수점 없는 원 단위 정수여야 합니다.");
          else if (amountText && amount !== signedAmount) error("bank_amount_conflict", "거래금액과 입금액−출금액이 일치하지 않습니다. 사용할 실제 거래 열을 확인해 주세요.");
          amount = signedAmount;
        }
      }
    } else if (amount === null) error("invalid_amount", "금액은 소수점 없는 원 단위 정수여야 합니다.");
    const vatText = value("vat");
    const vat = vatText ? parseKrw(vatText) : null;
    if (vatText && vat === null) error("invalid_vat", "부가세는 원 단위 정수 또는 빈칸이어야 합니다. 면세 거래는 0을 입력해 주세요.");
    if (amount !== null && vat !== null && (Math.abs(vat) > Math.abs(amount) || vat !== 0 && Math.sign(vat) !== Math.sign(amount))) error("vat_mismatch", "부가세의 부호는 총액과 같아야 하며 총액을 초과할 수 없습니다.");
    const kind = parseKind(value("kind"), options.kind);
    if (!kind) error("invalid_kind", "유형은 매출(revenue)·비용(expense)·입출금(bank)·제외(excluded) 중 하나여야 합니다.");
    if (options.kind === "bank" && kind && kind !== "bank" && kind !== "excluded") error("invalid_bank_kind", "통장 원본은 입출금 대사에만 사용합니다. 운영비는 가져온 출금을 확인한 뒤 '비용으로 반영'으로 등록해 주세요.");
    const feeText = options.kind === "bank" ? "" : value("feeAmount"), feeVatText = options.kind === "bank" ? "" : value("feeVat"), payoutText = options.kind === "bank" ? "" : value("payoutAmount");
    const fee = feeText ? parseKrw(feeText) : null, feeVat = feeVatText ? parseKrw(feeVatText) : null, payout = payoutText ? parseKrw(payoutText) : null;
    if (feeText && fee === null) error("invalid_fee", "수수료금액은 원 단위 정수여야 합니다.");
    if (feeVatText && feeVat === null) error("invalid_fee_vat", "수수료 부가세는 원 단위 정수여야 합니다.");
    if (feeVat !== null && (fee === null || Math.abs(feeVat) > Math.abs(fee) || feeVat !== 0 && Math.sign(feeVat) !== Math.sign(fee))) error("fee_vat_mismatch", "수수료 부가세의 금액과 부호를 확인해 주세요.");
    if (payoutText && payout === null) error("invalid_payout", "정산입금액은 원 단위 정수여야 합니다.");
    if (result.errors.length > before || !date || amount === null || !kind) continue;
    const description = value("description") || (kind === "revenue" ? "매출" : kind === "bank" ? "계좌거래" : "비용");
    const explicitCategory = value("category");
    const inferred = inferredCategory(description, kind);
    let category = explicitCategory ? normalizeOdaCategory(explicitCategory) : inferred;
    const categoryConflict = kind === "expense" && EXCLUDED_CATEGORIES.has(inferred) && category !== inferred;
    if (categoryConflict) category = inferred;
    if (kind === "bank") category = "bank";
    const channel = normalizeOdaChannel(value("channel") || options.channel || (kind === "revenue" ? "pos" : ""));
    const rule = kind === 'expense' && !explicitCategory && !EXCLUDED_CATEGORIES.has(category)
      ? remembered.get(normalizeOdaExpenseDescription(description)) : undefined;
    const appliedRule = rule && ODA_EXPENSE_CATEGORIES.some(item => item.value === rule.category) ? rule : undefined;
    if (appliedRule) category = appliedRule.category;
    const reviewed = !appliedRule && category !== "uncategorized" && !EXCLUDED_CATEGORIES.has(category);
    let note = value("note");
    if (categoryConflict) { note = [note, `내용이 제외 항목과 일치하여 원본 분류(${explicitCategory}) 재확인 필요`].filter(Boolean).join(" / "); result.warnings.push({ row: record.row, code: "excluded_category_conflict", message: "내용이 A 선공제·감가상각·B 배분·투자 등 제외 항목과 일치합니다. 원본 분류를 확인해 주세요." }); }
    if (explicitCategory && category === "uncategorized") note = [note, `원본 분류: ${explicitCategory}`].filter(Boolean).join(" / ");
    if (EXCLUDED_CATEGORIES.has(category)) note = [note, "운영비 제외 항목: 원본 및 분류 확인 필요"].filter(Boolean).join(" / ");
    const line: OdaLine = { id: `${options.sourceId}:${record.row}`, date, kind, description, amount, vat, category, channel, sourceId: options.sourceId, sourceRow: record.row, externalId: value("externalId"), reviewed, note,
      ...(appliedRule ? { categoryRule: { id: appliedRule.id, version: options.expenseRules!.version, description: appliedRule.description, category: appliedRule.category } } : {}) };
    append(line);
    const { categoryRule: _rule, ...derived } = line;
    if (fee !== null && fee !== 0) append({ ...derived, id: `${line.id}:fee`, kind: "expense", description: `${description} 수수료`, amount: fee, vat: feeVat, category: "fees", reviewed: true, note: value("note") });
    if (payout !== null && payout !== 0) append({ ...derived, id: `${line.id}:payout`, kind: "bank", description: `${description} 정산입금`, amount: payout, vat: null, category: "bank", reviewed: true, note: value("note") });
  }
  if (!result.rowCount) result.errors.push({ row: header.row + 1, code: "no_rows", message: "가져올 거래 행이 없습니다." });
  const rememberedCount = result.lines.filter(line => line.categoryRule).length;
  if (rememberedCount) result.warnings.push({ row: 0, code: 'expense_rule_applied', message: `이 매장에서 기억한 분류를 비용 ${rememberedCount}건에 적용했습니다. 금액·증빙 확인은 필요합니다.` });
  return result;
}
