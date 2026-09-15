import { createHash, randomUUID } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import { DomainError, calculateOdaMonth, createOdaMonth, parseOdaCsv, normalizeOdaChannel, normalizeOdaCategory, type Actor, type OdaMonth,
  type OdaLine, type OdaSource, type OdaSourceKind, type OdaCsvResult, type Store } from "@ofd/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "./events.ts";
import { readOdaWorkbook } from "./oda-spreadsheet.ts";
import { buildOdaReport } from "./oda-report.ts";
import { buildOdaExpenseExport } from "./oda-expense-export.ts";
import { getImportProfile, saveImportProfile } from "./oda-import-profile.ts";
import { idempotentMutation } from "./idempotency.ts";
import { previousSettlementMonth, recurringCandidates } from "./oda-recurring.ts";

/** Original bytes are repository-private. Never serialize this object to a client or audit ledger. */
interface OdaRecord extends OdaMonth {
  evidenceBytes: Record<string, string>;
  paymentAmount?: number;
  paymentDate?: string;
}
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MONTH_BYTES = 10 * 1024 * 1024;
const MAX_LINES = 5000;
const paramsSchema = z.object({ storeId: z.string().min(1).max(120), month: z.string().regex(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/) });
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const moneySchema = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const kindSchema = z.enum(["pos", "platform", "bank", "expense", "evidence"]);
const importSchema = z.object({
  expectedVersion: versionSchema.optional(), filename: z.string().trim().min(1).max(200), kind: kindSchema,
  content: z.string().max(MAX_FILE_BYTES).optional(), contentBase64: z.string().max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8).optional(),
  mediaType: z.string().max(120).optional(), channel: z.string().trim().max(80).optional(),
  sheetName: z.string().max(100).optional(), headerRow: z.number().int().min(1).max(100).optional(),
  columnMap: z.record(z.string().max(80), z.string().max(200)).optional(),
}).strict();
const policySchema = z.object({
  vatBasis: z.enum(["unresolved", "gross", "net"]), posDeliveryScope: z.enum(["unresolved", "included", "excluded"]),
  attributionBasis: z.enum(["unresolved", "accrual"]), bVatPolicy: z.enum(["unresolved", "add10", "none"]),
  lowProfitPolicy: z.enum(["hold", "available_profit_only"]), partialMonthPolicy: z.enum(["hold", "full_priority", "prorate"]),
  partialMonth: z.boolean(), operatingDays: z.number().int().min(0).max(31), roundingBeneficiary: z.enum(["A", "B"]),
  activeChannels: z.array(z.enum(["pos", "baemin", "coupang", "yogiyo"])).min(1).max(4),
  agreementNote: z.string().trim().max(4000),
}).strict();
const changesSchema = z.object({
  kind: z.enum(["revenue", "expense", "bank", "excluded"]).optional(), category: z.string().trim().min(1).max(100).optional(),
  reviewed: z.boolean().optional(), note: z.string().trim().max(2000).optional(), vat: moneySchema.nullable().optional(),
  approvalSourceId: z.string().max(120).optional(),
  sourceId: z.string().max(120).optional(),
  amount: moneySchema.optional(), date: z.string().optional(), description: z.string().trim().min(1).max(500).optional(),
}).strict();
const expenseBatchSchema = z.object({
  expectedVersion: versionSchema,
  lineIds: z.array(z.string().min(1).max(120)).min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length, "같은 비용을 중복 선택할 수 없습니다."),
  changes: z.object({
    category: z.enum(["ingredients", "labor", "rent", "utilities", "fees", "marketing", "supplies", "other"]).optional(),
    reviewed: z.boolean().optional(),
    sourceId: z.string().min(1).max(120).optional(),
  }).strict().refine(changes => Object.keys(changes).length > 0, "변경할 항목을 선택해 주세요."),
}).strict();

function publicMonth(record: OdaRecord): OdaMonth {
  const { evidenceBytes: _bytes, paymentAmount: _amount, paymentDate: _date, ...data } = record;
  return data;
}
function capabilities(actor: Actor, storeId?: string) {
  const canOperate = actor.role === "store_owner" || actor.role === "hq_master";
  return { edit: ["store_owner", "hq_finance", "hq_master"].includes(actor.role),
    confirmParty: actor.role === "store_owner" ? "A" as const : ["hq_finance", "hq_master"].includes(actor.role) && !!storeId && actor.storeIds.includes(storeId) ? "B" as const : null,
    finalize: canOperate, pay: canOperate, reopen: canOperate };
}
function result(record: OdaRecord, actor: Actor) {
  return { data: publicMonth(record), summary: monthSummary(record), version: record.version,
    evidence: record.sources, history: record.history, capabilities: capabilities(actor, record.storeId),
    payment: record.paymentDate ? { date: record.paymentDate, amount: record.paymentAmount, reference: record.paymentReference } : null };
}
export function monthSummary(record: OdaMonth) {
  const summary = calculateOdaMonth(record);
  const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  if (record.month >= currentMonth) {
    summary.blockers.push({ code: "month_not_ended", message: "당월 전체 자료를 포함하도록 다음 달 1일부터 월 정산을 확정할 수 있습니다." });
    summary.canFinalize = false;
  }
  return summary;
}
async function scope(repository: StateRepository, actor: Actor, storeId: string, edit = false, owner = false) {
  if (!actor.active || !["store_owner", "hq_finance", "hq_master", "auditor"].includes(actor.role)
    || (actor.role === "store_owner" && !actor.storeIds.includes(storeId))
    || (actor.role !== "store_owner" && actor.storeIds.length > 0 && !actor.storeIds.includes(storeId))
    || (edit && !capabilities(actor).edit) || (owner && !["store_owner", "hq_master"].includes(actor.role))) {
    throw new DomainError("ODA_FORBIDDEN", "이 매장의 월 정산을 처리할 권한이 없습니다.", 403);
  }
  if (!(await repository.get<Store>("store", storeId))?.active) throw new DomainError("ODA_STORE_NOT_FOUND", "운영 중인 매장을 찾을 수 없습니다.", 404);
}
async function loadMonth(repository: StateRepository, storeId: string, month: string): Promise<OdaRecord> {
  const id = `${storeId}:${month}`;
  const found = await repository.get<OdaRecord>("oda_month", id);
  if (found) return found;
  const fresh: OdaRecord = { ...createOdaMonth(storeId, month), id, version: 0, evidenceBytes: {} };
  const previous = (await repository.list<OdaRecord>("oda_month", [storeId])).filter((item) => item.month < month)
    .sort((a, b) => b.month.localeCompare(a.month))[0];
  // Policy agreement can carry into the next month; financial source rows never do.
  if (previous) {
    fresh.policy = structuredClone(previous.policy);
    // A previous opening/closing month never silently makes every future month a partial month.
    fresh.policy.partialMonth = false;
    fresh.policy.operatingDays = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  }
  const store = await repository.get<Store>("store", storeId);
  const openDate = store?.openDate;
  if (openDate && /^\d{4}-\d{2}-\d{2}$/.test(openDate) && openDate.startsWith(`${month}-`)
    && Number.isFinite(new Date(`${openDate}T00:00:00Z`).valueOf()) && new Date(`${openDate}T00:00:00Z`).toISOString().slice(0, 10) === openDate
    && Number(openDate.slice(8, 10)) > 1) {
    fresh.policy.partialMonth = true;
    fresh.policy.operatingDays = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() - Number(openDate.slice(8, 10)) + 1;
  }
  return fresh;
}
function dateInMonth(date: string, month?: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(`${date}T00:00:00Z`).valueOf())
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || (month && !date.startsWith(`${month}-`))) {
    throw new DomainError("ODA_DATE_INVALID", "실제 존재하는 해당 정산월의 날짜를 입력해 주세요.", 422);
  }
}
function checkLine(line: OdaLine, record: OdaRecord) {
  dateInMonth(line.date, record.month);
  moneySchema.parse(line.amount);
  moneySchema.nullable().parse(line.vat);
  if (line.vat !== null && (Math.abs(line.vat) > Math.abs(line.amount) || (line.amount !== 0 && line.vat !== 0 && Math.sign(line.vat) !== Math.sign(line.amount)))) {
    throw new DomainError("ODA_VAT_INVALID", "부가세는 금액과 부호가 같고 금액 이내여야 합니다.", 422);
  }
  if (line.sourceId && !record.sources.some((source) => source.id === line.sourceId)) throw new DomainError("ODA_SOURCE_INVALID", "현재 매장·정산월의 증빙만 연결할 수 있습니다.", 422);
  if (record.sources.find((source) => source.id === line.sourceId)?.kind === "bank" && !["bank", "excluded"].includes(line.kind)) {
    const original = record.lines.find((item) => item.id === line.bankLineId && item.kind === "bank");
    if (line.kind !== "expense" || !original || original.amount >= 0 || line.amount !== -original.amount || line.sourceId !== original.sourceId
      || line.date !== original.date || record.lines.some((item) => item.id !== line.id && item.bankLineId === original.id)) {
      throw new DomainError("ODA_BANK_NOT_PL", "통장 출금은 해당 거래의 '비용으로 반영' 확인을 거쳐 한 번만 비용에 반영할 수 있습니다.", 422);
    }
  }
  if (line.approvalSourceId && !record.sources.some((source) => source.id === line.approvalSourceId)) throw new DomainError("ODA_APPROVAL_SOURCE_INVALID", "사전 동의 증빙을 이 정산월에 첨부해 주세요.", 422);
}
function applyLineChanges(line: OdaLine, changes: z.infer<typeof changesSchema>, record: OdaRecord) {
  const sourceKind = record.sources.find((source) => source.id === line.sourceId)?.kind;
  if (changes.sourceId !== undefined && line.sourceId && changes.sourceId !== line.sourceId) throw new DomainError("ODA_SOURCE_IMMUTABLE", "가져온 내역의 원본 연결은 변경할 수 없습니다.", 422);
  if (line.sourceRow !== 0 && (changes.amount !== undefined || changes.date !== undefined || changes.description !== undefined)) throw new DomainError("ODA_SOURCE_LINE_IMMUTABLE", "원본에서 가져온 금액·날짜·내용은 변경할 수 없습니다. 원본 오류는 제외 후 증빙과 함께 수정 내역을 입력해 주세요.", 422);
  const nextKind = changes.kind ?? line.kind;
  if (line.kind === "excluded" && nextKind !== "excluded" && line.originalKind && nextKind !== line.originalKind) {
    throw new DomainError("ODA_KIND_INVALID", "제외한 내역은 제외 전 유형으로만 복원할 수 있습니다.", 422);
  }
  if (((sourceKind === "bank" && !line.bankLineId) || line.kind === "bank") && !["bank", "excluded"].includes(nextKind)) throw new DomainError("ODA_BANK_NOT_PL", "통장 원본은 입금 대사에 사용합니다. 출금을 비용에 반영하려면 '비용으로 반영'을 사용해 주세요.", 422);
  if (nextKind !== line.kind && nextKind !== "excluded" && !["excluded", "bank"].includes(line.kind)) throw new DomainError("ODA_KIND_INVALID", "매출과 비용을 서로 바꿀 수 없습니다. 원본 자료를 확인해 주세요.", 422);
  if ((sourceKind === "expense" || line.sourceRow === 0) && !["expense", "excluded"].includes(nextKind)) throw new DomainError("ODA_KIND_INVALID", "비용 자료를 매출이나 입금으로 바꿀 수 없습니다.", 422);
  if (line.kind !== "excluded" && nextKind === "excluded") {
    line.originalKind = line.kind;
    line.originalCategory = line.category;
  } else if (line.kind === "excluded" && nextKind !== "excluded" && changes.category === undefined && line.originalCategory) {
    line.category = line.originalCategory;
  }
  Object.assign(line, changes);
  checkLine(line, record);
  if (line.externalId.startsWith('repeat:') && line.kind === 'expense' && line.reviewed
    && !record.sources.some(source => source.id === line.sourceId)) {
    throw new DomainError('ODA_REPEAT_SOURCE_REQUIRED', '이번 달 증빙을 연결한 뒤 반복 비용을 확인 완료해 주세요.', 422);
  }
  if (changes.reviewed === true && line.kind === 'expense' && !record.sources.some(source => source.id === line.sourceId)) {
    throw new DomainError('ODA_EXPENSE_SOURCE_REQUIRED', '이번 달 증빙을 연결한 뒤 비용을 확인 완료해 주세요.', 422, { lineId: line.id });
  }
}
function ensureDraft(record: OdaRecord) {
  if (record.status !== "draft") throw new DomainError("ODA_MONTH_LOCKED", "확정된 정산입니다. 사유를 남겨 재개방한 뒤 수정해 주세요.", 409);
}
function snapshot(record: OdaRecord, actor: Actor, reason: string) {
  if (record.history.length >= 100) throw new DomainError("ODA_HISTORY_LIMIT", "이 정산월의 보관 이력 한도를 초과했습니다.", 422);
  record.history.push({ id: randomUUID(), version: record.version + 1, at: new Date().toISOString(), actorId: actor.id,
    actorName: actor.name, reason, lines: structuredClone(record.lines), sources: structuredClone(record.sources),
    policy: structuredClone(record.policy), summary: calculateOdaMonth(record) });
}
function csvCell(input: string | number | null): string {
  let value = input === null ? "" : String(input);
  if (/^[\s]*[=+\-@]/.test(value) && typeof input !== "number") value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}

interface PreparedFile { bytes: Buffer; sha256: string; filename: string; mimeType: string; csv?: string; workbook?: { sheetNames: string[]; sheetName: string; headers: string[] }; headerRow: number; }
async function prepareFile(body: z.infer<typeof importSchema>): Promise<PreparedFile> {
  if ((body.content !== undefined) === (body.contentBase64 !== undefined)) throw new DomainError("ODA_FILE_REQUIRED", "원본 파일 내용 한 가지를 첨부해 주세요.", 422);
  if (body.contentBase64 !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) {
    throw new DomainError("ODA_FILE_INVALID", "파일 인코딩이 올바르지 않습니다.", 422);
  }
  const bytes = body.contentBase64 !== undefined ? Buffer.from(body.contentBase64, "base64") : Buffer.from(body.content!, "utf8");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new DomainError("ODA_FILE_SIZE", "원본 파일은 2MB 이하로 첨부해 주세요.", 422);
  const filename = body.filename.replace(/[\\/\r\n\0]/g, "_");
  const extension = filename.split(".").pop()?.toLowerCase();
  const mimeByExtension: Record<string, string> = { csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const mimeType = extension ? mimeByExtension[extension] : undefined;
  if (!mimeType) throw new DomainError("ODA_FILE_TYPE", "CSV, TSV, XLSX, PDF, PNG, JPG 파일을 첨부해 주세요.", 422);
  const prepared: PreparedFile = { bytes, filename, mimeType, sha256: createHash("sha256").update(bytes).digest("hex"), headerRow: body.headerRow ?? 1 };
  if (extension === "xlsx") {
    try {
      const workbook = await readOdaWorkbook(bytes, { ...(body.sheetName ? { sheetName: body.sheetName } : {}),
        ...(body.headerRow ? { headerRow: body.headerRow } : {}), ...(body.columnMap ? { columnMap: body.columnMap } : {}) });
      prepared.csv = workbook.csv;
      prepared.workbook = { sheetNames: workbook.sheetNames, sheetName: workbook.sheetName, headers: workbook.headers };
    } catch (error) { throw new DomainError("ODA_WORKBOOK_INVALID", error instanceof Error ? error.message : "엑셀 파일을 읽지 못했습니다.", 422); }
  } else if (["csv", "tsv"].includes(extension!)) {
    try { prepared.csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch {
      try {
        prepared.csv = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
        prepared.mimeType = mimeType.replace("charset=utf-8", "charset=euc-kr");
      }
      catch { throw new DomainError("ODA_FILE_ENCODING", "파일의 문자 인코딩을 읽지 못했습니다. UTF-8 CSV로 저장해 주세요.", 422); }
    }
  } else if (body.kind !== "evidence") throw new DomainError("ODA_DATA_FILE_REQUIRED", "자동 집계 자료는 CSV 또는 XLSX를 사용해 주세요. 사진·PDF는 증빙으로 보관할 수 있습니다.", 422);
  return prepared;
}
function parseFile(file: PreparedFile, kind: OdaSourceKind, channel: string | undefined, record: OdaRecord, sourceId: string): OdaCsvResult {
  if (kind === "evidence") return { lines: [], errors: [], warnings: [], duplicateCount: 0, rowCount: 0 };
  const parsed = parseOdaCsv(file.csv!, { sourceId, kind: kind === "pos" || kind === "platform" ? "revenue" : kind,
    ...(channel ? { channel } : kind === "pos" ? { channel: "pos" } : {}), month: record.month, existingLines: record.lines });
  if (file.workbook && file.headerRow > 1) {
    for (const line of parsed.lines) line.sourceRow += file.headerRow - 1;
    for (const issue of [...parsed.errors, ...parsed.warnings]) if (issue.row > 0) issue.row += file.headerRow - 1;
  }
  return parsed;
}

export function registerOdaRoutes(app: FastifyInstance, repository: StateRepository): void {
  const base = "/api/v2/oda/:storeId/:month";
  const mutate = async (request: FastifyRequest, expectedVersion: number, action: string,
    run: (record: OdaRecord, scoped: StateRepository) => void | Promise<void>, options: { owner?: boolean; allowLocked?: boolean; metadata?: Record<string, unknown> } = {}) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId, true, options.owner === true);
    return repository.exclusiveTransaction(`oda:${storeId}:${month}`, async (scoped) => {
      const record = await loadMonth(scoped, storeId, month);
      if (record.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "다른 사용자가 먼저 수정했습니다. 최신 정산을 다시 불러와 주세요.", 409);
      if (!options.allowLocked) ensureDraft(record);
      const before = { version: record.version, status: record.status, summary: calculateOdaMonth(record), policy: structuredClone(record.policy) };
      const previousLines = new Map(record.lines.map((line) => [line.id, structuredClone(line)]));
      await run(record, scoped);
      if (record.lines.length > MAX_LINES) throw new DomainError("ODA_LINE_LIMIT", "월 정산 내역은 최대 5,000행입니다.", 422);
      for (const line of record.lines) checkLine(line, record);
      record.version += 1;
      record.updatedAt = new Date().toISOString();
      await scoped.commit({ changes: [{ type: "oda_month", id: record.id, storeId, expectedVersion: expectedVersion === 0 ? null : expectedVersion, value: record }],
        audits: [audit(request.actor, "oda_month", record.id, action, storeId, before,
          { version: record.version, status: record.status, summary: calculateOdaMonth(record), policy: record.policy },
          { ...options.metadata, lineChanges: record.lines.filter((line) => JSON.stringify(previousLines.get(line.id)) !== JSON.stringify(line))
            .map((line) => ({ before: previousLines.get(line.id) ?? null, after: line })) })] });
      return result(record, request.actor);
    });
  };

  const profilePath = '/api/v2/oda/:storeId/import-profile';
  const profileQuery = z.object({ kind: kindSchema, channel: z.string().trim().max(80).default('') }).strict();
  app.get(profilePath, async request => {
    const { storeId } = z.object({ storeId: z.string().min(1).max(120) }).parse(request.params);
    await scope(repository, request.actor, storeId);
    const { kind, channel } = profileQuery.parse(request.query);
    return getImportProfile(repository, storeId, kind, channel);
  });
  app.post(`${profilePath}/reset`, async (request, reply) => {
    const { storeId } = z.object({ storeId: z.string().min(1).max(120) }).parse(request.params);
    await scope(repository, request.actor, storeId, true);
    const { kind, channel, expectedVersion } = profileQuery.extend({ expectedVersion: versionSchema }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200, tx =>
      saveImportProfile(tx, request.actor, storeId, kind, channel, null, expectedVersion));
  });

  app.get(base, async (request) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId);
    const record = await loadMonth(repository, storeId, month);
    const events = (await repository.listAudit(500, [storeId])).filter((event) => event.aggregateId === record.id).slice(0, 100)
      .map((event) => ({ id: event.id, action: event.action, actorId: event.actorId, at: event.occurredAt, metadata: event.metadata }));
    return { ...result(record, request.actor), audit: events };
  });

  const save = async (request: FastifyRequest) => {
    const body = z.object({ expectedVersion: versionSchema, policy: policySchema }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 정산 기준 저장", (record) => {
      const { acknowledgements: _acks, ...before } = record.policy;
      if (Object.entries(body.policy).some(([key, value]) => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(value))) record.policy = { ...body.policy, acknowledgements: {} };
    });
  };
  app.put(base, save);
  app.post(`${base}/save`, save);

  app.post(`${base}/import/preview`, async (request) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId, true);
    const body = importSchema.parse(request.body);
    const file = await prepareFile(body);
    const record = await loadMonth(repository, storeId, month);
    const parsed = parseFile(file, body.kind, body.channel, record, "preview");
    if (record.sources.some((source) => source.sha256 === file.sha256)) parsed.errors.push({ row: 0, code: "DUPLICATE_FILE", message: "이미 첨부한 동일한 원본 파일입니다." });
    return { ...parsed, ...(file.workbook ? { workbook: file.workbook } : {}) };
  });
  app.post(`${base}/import`, async (request) => {
    const body = importSchema.parse(request.body);
    const expectedVersion = versionSchema.parse(body.expectedVersion);
    const file = await prepareFile(body);
    const sourceId = randomUUID();
    let added = 0; let duplicates = 0;
    const response = await mutate(request, expectedVersion, "ODA 원본 자료 가져오기", async (record, scoped) => {
      if (record.sources.some((source) => source.sha256 === file.sha256)) throw new DomainError("ODA_DUPLICATE_FILE", "이미 첨부한 동일한 원본 파일입니다.", 409);
      if (record.sources.reduce((total, source) => total + source.sizeBytes, 0) + file.bytes.length > MAX_MONTH_BYTES) {
        throw new DomainError("ODA_MONTH_FILE_LIMIT", "정산월 원본 자료는 총 10MB까지 보관할 수 있습니다.", 422);
      }
      const parsed = parseFile(file, body.kind, body.channel, record, sourceId);
      if (parsed.errors.length) throw new DomainError("ODA_IMPORT_INVALID", "원본 자료의 오류를 수정해 주세요. 어떤 행도 저장하지 않았습니다.", 422, parsed.errors);
      const source: OdaSource = { id: sourceId, fileName: file.filename, sha256: file.sha256, kind: body.kind,
        channel: normalizeOdaChannel(body.channel ?? (body.kind === "pos" ? "pos" : "")), importedAt: new Date().toISOString(), importedBy: request.actor.id,
        rowCount: parsed.rowCount, sizeBytes: file.bytes.length, mimeType: file.mimeType };
      record.sources.push(source);
      for (const line of parsed.lines) checkLine(line, record);
      record.lines.push(...parsed.lines.map((line) => ({ ...line, id: randomUUID() })));
      record.evidenceBytes[sourceId] = file.bytes.toString("base64");
      added = parsed.lines.length; duplicates = parsed.duplicateCount;
      if (file.workbook) await saveImportProfile(scoped, request.actor, record.storeId, body.kind, body.channel, {
        headerRow: file.headerRow, sheetName: body.sheetName ?? '', headers: file.workbook.headers, columnMap: body.columnMap ?? {},
      });
    }, { metadata: { sourceId, filename: file.filename, sha256: file.sha256 } });
    return { ...response, importResult: { added, duplicates } };
  });

  const updateLine = async (request: FastifyRequest) => {
    const { lineId } = z.object({ lineId: z.string().min(1).max(120) }).parse(request.params);
    const body = z.object({ expectedVersion: versionSchema, changes: changesSchema }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 내역 확인·분류", (record) => {
      const line = record.lines.find((item) => item.id === lineId);
      if (!line) throw new DomainError("ODA_LINE_NOT_FOUND", "현재 정산월에서 내역을 찾지 못했습니다.", 404);
      applyLineChanges(line, body.changes, record);
    }, { metadata: { lineId, changes: body.changes, reason: body.changes.note?.trim() || "거래 분류·확인 상태 정정" } });
  };
  app.patch(`${base}/lines/:lineId`, updateLine);
  app.post(`${base}/lines/:lineId`, updateLine);


  app.post(`${base}/expenses/batch`, async request => {
    const body = expenseBatchSchema.parse(request.body);
    const selectedIds = new Set(body.lineIds);
    const response = await mutate(request, body.expectedVersion, "ODA 비용 일괄 정리", record => {
      const lines = new Map(record.lines.map(line => [line.id, line]));
      for (const lineId of body.lineIds) {
        const line = lines.get(lineId);
        if (!line) throw new DomainError("ODA_LINE_NOT_FOUND", "현재 정산월에서 선택한 비용을 찾지 못했습니다.", 404, { lineId });
        if (line.kind !== "expense") throw new DomainError("ODA_EXPENSE_REQUIRED", "비용 내역만 한 번에 정리할 수 있습니다. 제외·매출·통장 거래는 개별 내역에서 확인해 주세요.", 422, { lineId });
        applyLineChanges(line, body.changes, record);
      }
      if (body.changes.reviewed === true) {
        const blockers = calculateOdaMonth(record).blockers.filter(issue => issue.lineId && selectedIds.has(issue.lineId));
        if (blockers.length) throw new DomainError("ODA_EXPENSE_REVIEW_BLOCKED", `선택한 비용을 확인 완료할 수 없습니다. ${blockers[0]!.message}`, 422, { blockers });
      }
    }, { metadata: { lineIds: body.lineIds, changes: body.changes, reason: "선택한 비용의 분류·증빙·확인 상태 일괄 정리" } });
    return { ...response, batchResult: { updated: body.lineIds.length } };
  });

  app.post(`${base}/lines`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema, line: z.object({ date: z.string(), kind: z.enum(["expense", "excluded"]),
      description: z.string().trim().min(1).max(500), amount: moneySchema, vat: moneySchema.nullable(), category: z.string().trim().min(1).max(100),
      channel: z.string().trim().max(80).optional(), sourceId: z.string().max(120).optional(), reviewed: z.boolean().optional(),
      note: z.string().trim().max(2000).optional(), approvalSourceId: z.string().max(120).optional() }).strict() }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 예외 비용 입력", (record) => {
      const line: OdaLine = { id: randomUUID(), date: body.line.date, kind: body.line.kind, description: body.line.description,
        amount: body.line.amount, vat: body.line.vat, category: body.line.category, channel: body.line.channel ?? "manual", sourceId: body.line.sourceId ?? "",
        sourceRow: 0, externalId: "", reviewed: body.line.reviewed ?? false, note: body.line.note ?? "",
        ...(body.line.approvalSourceId !== undefined ? { approvalSourceId: body.line.approvalSourceId } : {}) };
      checkLine(line, record);
      if (line.kind === 'expense' && line.reviewed && !record.sources.some(source => source.id === line.sourceId)) {
        throw new DomainError('ODA_EXPENSE_SOURCE_REQUIRED', '이번 달 증빙을 연결한 뒤 비용을 확인 완료해 주세요.', 422);
      }
      record.lines.push(line);
    });
  });

  app.get(`${base}/repeat-previous/preview`, async request => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId, true);
    const previousMonth = previousSettlementMonth(month);
    const [previous, current] = await Promise.all([
      repository.get<OdaRecord>('oda_month', `${storeId}:${previousMonth}`),
      repository.get<OdaRecord>('oda_month', `${storeId}:${month}`),
    ]);
    if (current) ensureDraft(current);
    const status = !previous ? 'missing' : previous.status === 'draft' ? 'unfinalized' : 'available';
    return { month, previousMonth, previousVersion: previous?.version ?? null, targetVersion: current?.version ?? 0, status,
      rows: status === 'available' ? recurringCandidates(previous!, current ?? createOdaMonth(storeId, month)) : [] };
  });

  app.post(`${base}/repeat-previous`, async (request) => {
    const ids = z.array(z.string().min(1).max(120)).min(1).max(MAX_LINES).refine(values => new Set(values).size === values.length);
    const body = z.object({ expectedVersion: versionSchema, previousVersion: versionSchema.optional(), lineIds: ids.optional(),
      confirmedSimilarLineIds: z.array(z.string().min(1).max(120)).max(MAX_LINES).default([]) }).strict()
      .refine(value => (value.lineIds === undefined) === (value.previousVersion === undefined), '미리보기의 이전 정산 버전과 선택 항목을 함께 보내 주세요.').parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 전월 고정비 확인 제안", async (record, scoped) => {
      const previousMonth = previousSettlementMonth(record.month);
      await scoped.exclusiveTransaction(`oda:${record.storeId}:${previousMonth}`, async tx => {
        const previous = await tx.get<OdaRecord>('oda_month', `${record.storeId}:${previousMonth}`);
        if (!previous || previous.status === 'draft') throw new DomainError('ODA_PREVIOUS_NOT_FOUND', '지난달의 확정된 정산서가 없습니다. 지난달 정산을 먼저 확인해 주세요.', 422);
        if (body.previousVersion !== undefined && previous.version !== body.previousVersion)
          throw new DomainError('VERSION_CONFLICT', '지난달 정산이 변경됐습니다. 비용 미리보기를 다시 불러와 주세요.', 409);
        const candidates = recurringCandidates(previous, record);
        const selected = body.lineIds ?? candidates.filter(row => row.status === 'available').map(row => row.lineId);
        const byId = new Map(candidates.map(row => [row.lineId, row]));
        const confirmedSimilar = new Set(body.confirmedSimilarLineIds);
        for (const id of selected) {
          const row = byId.get(id);
          if (!row) throw new DomainError('ODA_REPEAT_INVALID', '지난달 반복 비용 목록의 항목만 선택해 주세요.', 422);
          if (row.status === 'already_added') throw new DomainError('ODA_REPEAT_EXISTS', '이미 가져온 항목입니다. 미리보기를 다시 불러와 주세요.', 409);
          if (row.status === 'similar' && !confirmedSimilar.has(id))
            throw new DomainError('ODA_REPEAT_SIMILAR', '이번 달의 비슷한 비용을 확인한 후 해당 항목을 직접 선택해 주세요.', 409);
          record.lines.push({ id: randomUUID(), date: `${record.month}-01`, kind: 'expense', description: row.description,
            amount: row.amount, vat: row.vat, category: row.category, channel: 'manual', sourceId: '', sourceRow: 0,
            externalId: `repeat:${previousMonth}:${id}`, reviewed: false,
            note: `전월 ${previousMonth} 참고 제안 — 당월 실제 금액·귀속일·증빙 확인 필요`, approvalSourceId: '' });
        }
      });
    });
  });

  app.post(`${base}/bank-expense`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema, bankLineId: z.string().min(1).max(120),
      category: z.string().trim().min(1).max(100), vat: moneySchema.nullable(), note: z.string().trim().max(2000).optional() }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 통장 출금 비용 확인", (record) => {
      const bank = record.lines.find((line) => line.id === body.bankLineId && line.kind === "bank" && line.amount < 0);
      if (!bank) throw new DomainError("ODA_BANK_OUTFLOW_REQUIRED", "현재 정산월의 통장 출금 거래를 선택해 주세요.", 422);
      if (record.lines.some((line) => line.bankLineId === bank.id)) throw new DomainError("ODA_BANK_EXPENSE_EXISTS", "이미 비용 확인한 통장 거래입니다. 기존 비용 내역에서 분류를 수정해 주세요.", 409);
      const category = normalizeOdaCategory(body.category);
      const candidate = record.lines.some((line) => line.kind === "expense" && line.date === bank.date && line.amount === -bank.amount && normalizeOdaCategory(line.category) === category);
      const derived: OdaLine = { id: randomUUID(), date: bank.date, kind: "expense", description: bank.description,
        amount: -bank.amount, vat: body.vat, category, channel: bank.channel, sourceId: bank.sourceId, sourceRow: bank.sourceRow,
        externalId: `bank-expense:${bank.id}`, bankLineId: bank.id, reviewed: !candidate,
        note: `${body.note ?? "통장 출금의 운영비 해당 여부 확인"}${candidate ? " · 동일 날짜·금액·분류의 비용이 있습니다. 영수증과 중복 여부를 확인해 주세요." : ""}` };
      checkLine(derived, record);
      record.lines.push(derived);
    }, { metadata: { bankLineId: body.bankLineId } });
  });

  app.post(`${base}/confirm-policy`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 정산 기준 합의", (record) => {
      const party = capabilities(request.actor, record.storeId).confirmParty;
      if (!party) throw new DomainError("ODA_PARTY_ASSIGNMENT_REQUIRED", "계약상 을의 기준 확인은 해당 매장에 배정된 재무 담당자 계정으로 진행해 주세요.", 403);
      const other = record.policy.acknowledgements[party === "A" ? "B" : "A"];
      if (other?.actorId === request.actor.id) throw new DomainError("ODA_DUAL_SIGNATURE", "갑과 을은 서로 다른 당사자 계정으로 기준을 확인해야 합니다.", 403);
      record.policy.acknowledgements[party] = { actorId: request.actor.id, actorName: request.actor.name, at: new Date().toISOString() };
    });
  });
  app.post(`${base}/finalize`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 월 정산 확정", (record) => {
      const summary = monthSummary(record);
      if (!summary.canFinalize || summary.blockers.length) throw new DomainError("ODA_FINALIZE_BLOCKED", "확인이 필요한 항목을 해결한 뒤 확정해 주세요.", 422, summary.blockers);
      for (const source of record.sources) {
        if (!record.evidenceBytes[source.id]) throw new DomainError("ODA_EVIDENCE_MISSING", "보관된 원본 자료가 누락되어 확정할 수 없습니다.", 422);
        const bytes = Buffer.from(record.evidenceBytes[source.id]!, "base64");
        if (bytes.length !== source.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new DomainError("ODA_EVIDENCE_INTEGRITY", "보관된 원본 자료의 무결성을 확인할 수 없어 확정을 중단했습니다.", 422);
      }
      snapshot(record, request.actor, "월 정산 확정");
      record.status = "finalized"; record.finalizedAt = new Date().toISOString(); record.finalizedBy = request.actor.id;
    }, { owner: true });
  });
  app.post(`${base}/reopen`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema, reason: z.string().trim().min(5).max(2000) }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 월 정산 재개방", (record) => {
      if (record.status === "draft") throw new DomainError("ODA_NOT_FINALIZED", "확정된 정산만 재개방할 수 있습니다.", 409);
      if (record.status === "paid") throw new DomainError("ODA_PAID_LOCKED", "지급 완료된 정산은 수정할 수 없습니다. 다음 정산월에 조정 내역과 증빙을 남겨 주세요.", 409);
      snapshot(record, request.actor, `재개방: ${body.reason}`);
      record.status = "draft"; delete record.finalizedAt; delete record.finalizedBy;
      record.comments.push({ id: randomUUID(), actorId: request.actor.id, actorName: request.actor.name, at: new Date().toISOString(), body: `정산 재개방 사유: ${body.reason}` });
    }, { owner: true, allowLocked: true, metadata: { reason: body.reason } });
  });
  app.post(`${base}/paid`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema, date: z.string(), reference: z.string().trim().min(2).max(200), amount: moneySchema }).strict().parse(request.body);
    dateInMonth(body.date);
    return mutate(request, body.expectedVersion, "ODA 을 지급 완료 기록", (record) => {
      if (record.status !== "finalized") throw new DomainError("ODA_NOT_FINALIZED", "먼저 월 정산을 확정해 주세요.", 409);
      const payable = calculateOdaMonth(record).payableB;
      if (payable === null || body.amount !== payable) throw new DomainError("ODA_PAYMENT_AMOUNT_MISMATCH", "계산된 을 지급액과 실제 이체금액이 정확히 일치해야 합니다.", 422, { expected: payable });
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
      if (body.date < `${record.month}-01` || body.date > today) throw new DomainError("ODA_PAYMENT_DATE_INVALID", "정산월 이후 실제 이체한 날짜를 입력해 주세요.", 422);
      record.status = "paid"; record.paidAt = new Date().toISOString(); record.paidBy = request.actor.id;
      record.paymentReference = body.reference; record.paymentAmount = body.amount; record.paymentDate = body.date;
    }, { owner: true, allowLocked: true, metadata: { date: body.date, reference: body.reference, amount: body.amount } });
  });
  app.post(`${base}/comment`, async (request) => {
    const body = z.object({ expectedVersion: versionSchema, text: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
    return mutate(request, body.expectedVersion, "ODA 정산 의견", (record) => {
      if (record.comments.length >= 500) throw new DomainError("ODA_COMMENT_LIMIT", "정산월 의견 한도를 초과했습니다.", 422);
      record.comments.push({ id: randomUUID(), actorId: request.actor.id, actorName: request.actor.name, at: new Date().toISOString(), body: body.text });
    }, { allowLocked: true, metadata: { text: body.text } });
  });
  app.get(`${base}/evidence/:evidenceId`, async (request, reply) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    const { evidenceId } = z.object({ evidenceId: z.string().min(1).max(120) }).parse(request.params);
    await scope(repository, request.actor, storeId);
    const record = await loadMonth(repository, storeId, month);
    const source = record.sources.find((item) => item.id === evidenceId);
    if (!source || !record.evidenceBytes[evidenceId]) throw new DomainError("ODA_EVIDENCE_NOT_FOUND", "증빙 원본을 찾지 못했습니다.", 404);
    const bytes = Buffer.from(record.evidenceBytes[evidenceId], "base64");
    reply.type(source.mimeType).header("Content-Disposition", `attachment; filename="oda-evidence.${source.fileName.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(source.fileName)}`);
    return reply.send(bytes);
  });
  app.get(`${base}/expenses/export.zip`, async (request, reply) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId);
    const record = await loadMonth(repository, storeId, month);
    const store = await repository.get<Store>("store", storeId);
    const bytes = await buildOdaExpenseExport({ month: publicMonth(record), evidenceBytes: record.evidenceBytes, storeName: store!.name });
    reply.type("application/zip")
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", `attachment; filename="ODA-expenses-${month}.zip"`);
    return reply.send(bytes);
  });
  app.get(`${base}/export.xlsx`, async (request, reply) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId);
    const record = await loadMonth(repository, storeId, month);
    const store = await repository.get<Store>("store", storeId);
    const events = (await repository.listAudit(500, [storeId])).filter((event) => event.aggregateId === record.id).slice(0, 100);
    const bytes = await buildOdaReport({ month: publicMonth(record), summary: monthSummary(record), storeName: store!.name,
      audit: events, ...(record.paymentDate && record.paymentAmount !== undefined ? {
        payment: { date: record.paymentDate, amount: record.paymentAmount, reference: record.paymentReference ?? "" },
      } : {}) });
    reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", `attachment; filename="ODA-settlement-${month}.xlsx"`);
    return reply.send(bytes);
  });
  app.get(`${base}/export.csv`, async (request, reply) => {
    const { storeId, month } = paramsSchema.parse(request.params);
    await scope(repository, request.actor, storeId);
    const record = await loadMonth(repository, storeId, month);
    const summary = calculateOdaMonth(record);
    const rows: Array<Array<string | number | null>> = [["ODA 월 정산", month, record.status, "버전", record.version],
      ["매출", summary.revenue], ["비용", summary.expenses], ["정산 기준 영업이익", summary.profit],
      ["갑 우선배분", summary.priorityA], ["갑 배분", summary.shareA], ["을 배분", summary.shareB],
      ["을 지급 부가세", summary.vatB], ["을 실제 지급액", summary.payableB],
      ["정산서 기한", summary.statementDueDate], ["지급 기한", summary.paymentDueDate],
      ["실제 지급일", record.paymentDate ?? ""], ["실제 이체금액", record.paymentAmount ?? null], ["이체 확인번호", record.paymentReference ?? ""],
      ["손익 부가세 기준", record.policy.vatBasis], ["POS 배달매출 포함", record.policy.posDeliveryScope], ["을 부가세 가산", record.policy.bVatPolicy],
      ["기준 합의 내용", record.policy.agreementNote], ["갑 기준 확인", record.policy.acknowledgements.A?.actorName ?? "미확인"],
      ["을 기준 확인", record.policy.acknowledgements.B?.actorName ?? "미확인"], [],
      ["날짜", "유형", "내용", "금액", "부가세", "분류", "채널", "확인", "원본 파일", "원본 행", "거래ID", "비고"]];
    for (const line of record.lines) rows.push([line.date, line.kind, line.description, line.amount, line.vat, line.category,
      line.channel, line.reviewed ? "확인" : "미확인", record.sources.find((source) => source.id === line.sourceId)?.fileName ?? "증빙 필요", line.sourceRow, line.externalId, line.note]);
    reply.type("text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="ODA-settlement-${month}.csv"`);
    return reply.send(`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`);
  });
}
