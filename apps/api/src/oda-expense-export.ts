import { createHash } from "node:crypto";
import JSZip from "jszip";
import { calculateOdaMonth, normalizeOdaCategory, ODA_EXPENSE_CATEGORIES, type OdaMonth } from "@ofd/domain";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MONTH_BYTES = 10 * 1024 * 1024;
const EXCLUDED = new Set(["capex", "deposit", "a_priority", "depreciation", "b_distribution", "owner_transfer"]);
const CATEGORY_NAMES: Record<string, string> = { ...Object.fromEntries(ODA_EXPENSE_CATEGORIES.map((item) => [item.value, item.label])),
  capex: "투자비", deposit: "보증금", a_priority: "A 우선배분", depreciation: "감가상각", b_distribution: "B 배분금", owner_transfer: "사업주 이체", uncategorized: "미분류", bank: "계좌 대사" };
const STATUS = { draft: "작성 중 · 미확정", finalized: "정산 확정", paid: "지급 기록 완료" } as const;

export interface OdaExpenseExportInput {
  /** Route must authorize this store/month before loading either argument. */
  month: OdaMonth;
  /** Only the same monthly aggregate's private original bytes; never a global file map. */
  evidenceBytes: Readonly<Record<string, string>>;
  storeName: string;
  exportedAt?: Date;
}

/** All textual cells are inert even when a spreadsheet interprets CSV on open. */
function csv(rows: (string | number | null)[][]): Buffer {
  return Buffer.from("\uFEFF" + rows.map((row) => row.map((value) => {
    if (value === null) return '""';
    if (typeof value === "number") return String(value);
    const safe = /^[\s\u0000-\u001f\u007f]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n") + "\r\n", "utf8");
}

function safeName(value: string): string {
  const leaf = value.split(/[\\/]/u).at(-1) ?? "";
  const safe = leaf.normalize("NFC").replace(/[\u0000-\u001f\u007f\p{Cf}<>:"/\\|?*]/gu, "_").replace(/^\.+/u, "").replace(/[. ]+$/u, "") || "evidence";
  const extension = /\.[a-z0-9]{1,10}$/iu.exec(safe)?.[0] ?? "";
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  let shortened = "";
  for (const char of stem) {
    if (Buffer.byteLength(shortened + char + extension, "utf8") > 150) break;
    shortened += char;
  }
  return (shortened || "evidence") + extension;
}

/** One original file per source, alongside a traceable register; does not mutate the books. */
export async function buildOdaExpenseExport(input: OdaExpenseExportInput): Promise<Buffer> {
  const { month: record } = input;
  const snapshot = record.status === "draft" ? undefined : [...record.history].reverse().find((entry) => entry.reason === "월 정산 확정" && entry.version <= record.version);
  const lines = snapshot?.lines ?? record.lines;
  const sources = snapshot?.sources ?? record.sources;
  if (lines.length > 5_000 || sources.length > 10_000 || lines.some((line) => line.date.slice(0, 7) !== record.month)) throw new Error("내보낼 월 자료의 범위가 올바르지 않습니다.");
  const summary = snapshot?.summary ?? calculateOdaMonth(record);
  const excludedByDomain = new Set(summary.warnings.filter((issue) => ["excluded_contract_cost", "contract_cost_description"].includes(issue.code)).map((issue) => issue.lineId));
  // Excluded rows are intentionally separate, including excluded former revenue rows.
  // Their original kind is retained so an accountant never mistakes them for costs.
  const relevant = lines.filter((line) => line.kind === "expense" || line.kind === "excluded");
  const relatedIds = new Set(relevant.flatMap((line) => [line.sourceId, line.approvalSourceId ?? ""]).filter(Boolean));
  const relatedLines = new Map<string, string[]>();
  for (const line of relevant) for (const sourceId of new Set([line.sourceId, line.approvalSourceId ?? ""])) {
    if (sourceId) {
      const linked = relatedLines.get(sourceId) ?? [];
      linked.push(line.id);
      relatedLines.set(sourceId, linked);
    }
  }
  const allReferencedIds = new Set(lines.flatMap((line) => [line.sourceId, line.approvalSourceId ?? ""]).filter(Boolean));
  const includedSources = sources.filter((source) => relatedIds.has(source.id) || ["expense", "evidence"].includes(source.kind) && !allReferencedIds.has(source.id));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  if (sourceById.size !== sources.length) throw new Error("중복된 증빙 ID가 있어 내보내기를 중단했습니다.");
  const zip = new JSZip();
  const exportedAt = input.exportedAt ?? new Date();
  const fileOptions = { date: exportedAt, createFolders: false };
  const filePaths = new Map<string, string>();
  const fileStates = new Map<string, string>();
  const manifest: (string | number | null)[][] = [["증빙 ID", "원본 파일명", "묶음 안 파일 경로", "원본 상태", "연결 상태", "연결 거래 ID", "자료 구분", "SHA-256", "원본 크기 (bytes)", "첨부 시각 (UTC)"]];
  let totalBytes = 0;
  for (const [index, source] of includedSources.entries()) {
    const encoded = Object.hasOwn(input.evidenceBytes, source.id) ? input.evidenceBytes[source.id] : undefined;
    let fileState = "원본 파일 누락";
    let path = "";
    if (encoded !== undefined) {
      if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error("원본 파일의 내보내기 용량 한도를 초과했습니다.");
      const bytes = Buffer.from(encoded, "base64");
      totalBytes += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_MONTH_BYTES) throw new Error("월 증빙의 내보내기 용량 한도를 초과했습니다.");
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.toString("base64") !== encoded || hash !== source.sha256 || bytes.length !== source.sizeBytes) fileState = "원본 검증 실패 · 파일 제외";
      else {
        path = `증빙/${String(index + 1).padStart(4, "0")}-${createHash("sha256").update(source.id).digest("hex").slice(0, 12)}-${safeName(source.fileName)}`;
        zip.file(path, bytes, fileOptions);
        filePaths.set(source.id, path);
        fileState = "원본 포함 · 해시 확인";
      }
    }
    fileStates.set(source.id, fileState);
    const linked = relatedLines.get(source.id) ?? [];
    manifest.push([source.id, source.fileName, path, fileState, linked.length ? "거래 연결" : "미연결 · 용도 확인 필요", linked.join(" | "), source.kind, source.sha256, source.sizeBytes, source.importedAt]);
  }
  const headers = ["귀속일", "내용", "원본 금액 (원·부가세 포함)", "기록된 부가세 (원)", "부가세 확인", "분류", "등록 구분", "제외 전 구분", "검토 상태", "손익 반영 참고", "증빙 연결", "원본 파일 경로", "증빙 ID", "사전동의 증빙 ID", "사전동의 파일 경로", "원본 행", "거래 ID", "거래번호", "비고", "확인 필요"];
  const operating: (string | number | null)[][] = [headers];
  const excluded: (string | number | null)[][] = [headers];
  const issuesById = new Map<string, string[]>();
  for (const issue of [...summary.blockers, ...summary.warnings]) if (issue.lineId) issuesById.set(issue.lineId, [...(issuesById.get(issue.lineId) ?? []), issue.message]);
  for (const line of relevant) {
    const isExcluded = line.kind === "excluded" || EXCLUDED.has(normalizeOdaCategory(line.category)) || excludedByDomain.has(line.id);
    const proposal = line.externalId.startsWith("repeat:") && !line.reviewed;
    const sourceState = !sourceById.has(line.sourceId) ? "증빙 미연결" : fileStates.get(line.sourceId) ?? "원본 파일 누락";
    const row = [line.date, line.description, line.amount, line.vat, line.vat === null ? "미확인" : line.vat === 0 ? "0원으로 기록" : "기록됨",
      CATEGORY_NAMES[normalizeOdaCategory(line.category)] ?? line.category, line.kind, line.originalKind ?? "", line.reviewed ? "확인 완료" : "확인 필요",
      proposal ? "반복 비용 제안 · 손익 미반영" : isExcluded ? "손익 제외" : "월 정산 계산 결과 참고",
      sourceState, filePaths.get(line.sourceId) ?? "", line.sourceId, line.approvalSourceId ?? "", filePaths.get(line.approvalSourceId ?? "") ?? "",
      line.sourceRow, line.id, line.externalId, line.note, (issuesById.get(line.id) ?? []).join(" | ")];
    (isExcluded ? excluded : operating).push(row);
  }
  zip.file("운영비등록.csv", csv(operating), fileOptions);
  zip.file("손익제외.csv", csv(excluded), fileOptions);
  zip.file("증빙목록.csv", csv(manifest), fileOptions);
  zip.file("읽어주세요.txt", Buffer.from([
    "ODA 비용·증빙 전달 자료", `매장: ${input.storeName}`, `매장 ID: ${record.storeId}`, `귀속월: ${record.month}`,
    `정산 상태: ${STATUS[record.status]}`, `기록 버전: ${record.version}`, `자료 기준: ${snapshot ? `확정 당시 보관본 v${snapshot.version}` : "현재 등록 자료"}`, `내보낸 시각 (UTC): ${exportedAt.toISOString()}`,
    "", "운영비등록.csv: 운영비로 등록한 내역과 확인할 항목입니다. 미확인 반복 비용 제안도 표시하되 손익에는 반영하지 않습니다.",
    "손익제외.csv: 투자비·보증금·배분금 등 손익에서 제외한 내역입니다. 제외 전 구분과 등록 구분을 확인해 주세요. 제외한 매출도 포함될 수 있습니다.",
    "증빙목록.csv: 각 원본의 파일 경로, 증빙 ID, SHA-256 및 연결 여부입니다. 미연결 비용·증빙 자료도 담았습니다.",
    "증빙/ 폴더: 이 월의 관련 원본만 담았습니다. 이전 달의 원본은 반복 비용 제안과 함께 복사하지 않습니다. 해시 또는 크기 검증에 실패한 파일은 포함하지 않고 목록에 표시합니다.",
    "", "금액은 원 단위 원본 부가세 포함액입니다. 부가세 미확인은 빈칸으로 유지하며 0원과 구분합니다. 부가세를 임의로 역산하지 않았습니다.",
    "CSV 행을 단순 합산한 금액은 월 손익이 아닙니다. 중복·미확인·제외·반복 제안 상태와 워크스테이션의 월 정산 보고서를 함께 확인해 주세요.",
    "작성 중 자료는 미확정입니다. 확정·지급 상태의 자료는 확정 당시 보관본을 우선 사용합니다.",
    "파일 연결 및 확인 완료 표시는 매장에서 기록한 검토 상태이며 세무상 적격 증빙, 비용 인정 또는 매입세액 공제를 판정하지 않습니다. 기장 전 담당자와 원본을 확인해 주세요.",
    "이 자료는 매장 비용 정리와 전달을 위한 묶음이며 재무제표나 세무 신고서가 아닙니다. 자동으로 외부에 전송하지 않습니다.",
    "CSV 텍스트 앞의 작은따옴표는 수식 실행을 막기 위한 문자입니다. 워크스테이션의 원본 내용은 변경하지 않았습니다.", "",
  ].join("\r\n"), "utf8"), fileOptions);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS", streamFiles: false });
}
