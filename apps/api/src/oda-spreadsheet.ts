import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";

export interface OdaWorkbookOptions {
  sheetName?: string;
  headerRow?: number;
  /** Canonical settlement field -> exact source column header. */
  columnMap?: Record<string, string>;
}

export interface OdaWorkbookResult {
  csv: string;
  sheetNames: string[];
  sheetName: string;
  /** The original header labels, before applying columnMap. */
  headers: string[];
}

const MAX_COMPRESSED = 2 * 1024 * 1024;
const MAX_EXPANDED = 20 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_SHEETS = 10;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 40;
const MAX_CELLS = 100_000;
const MAX_TEXT_LENGTH = 32_767;
const CANONICAL_FIELDS = new Set([
  "date", "description", "amount", "vat", "category", "channel", "externalId", "kind", "note",
  "feeAmount", "feeVat", "payoutAmount", "creditAmount", "debitAmount",
]);

function invalid(message: string): never {
  throw new Error(message);
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return match?.[1] ?? match?.[2];
}

function checkCellReference(reference: string): void {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference);
  if (!match) invalid("엑셀의 셀 주소가 올바르지 않습니다.");
  const column = [...match[1]!].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  if (column > MAX_COLUMNS || Number(match[2]) > MAX_ROWS) {
    invalid("엑셀 시트는 10,000행, 40열 이내여야 합니다. 필요한 월의 자료만 내려받아 주세요.");
  }
}

/** Check compressed AND actual expanded sizes before ExcelJS/JSZip allocates a workbook. */
function inspectArchive(bytes: Buffer): void {
  if (bytes.length > MAX_COMPRESSED) invalid("엑셀 파일은 2MB 이하만 업로드할 수 있습니다.");
  if (bytes.length < 22) invalid("올바른 XLSX 파일이 아닙니다.");

  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      end = index;
      break;
    }
  }
  if (end < 0) invalid("올바른 XLSX 파일이 아닙니다. CSV 또는 XLSX로 다시 저장해 주세요.");
  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== entryCount || entryCount === 0 || entryCount > MAX_ENTRIES
    || directoryStart + directorySize !== end) invalid("분할 압축 또는 비표준 XLSX 파일은 지원하지 않습니다.");

  let cursor = directoryStart;
  let expanded = 0;
  let worksheetCount = 0;
  let cellCount = 0;
  const names = new Set<string>();
  const occupied: Array<[number, number]> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid("엑셀 압축 구조가 손상되었습니다.");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || disk !== 0 || (flags & 0x0041) !== 0 || ![0, 8].includes(method)) {
      invalid("암호화되었거나 지원하지 않는 압축 형식의 엑셀 파일입니다.");
    }
    if (expandedSize > MAX_EXPANDED - expanded) invalid("엑셀 압축 해제 크기는 총 20MB 이내여야 합니다.");
    let name: string;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { invalid("엑셀 내부 파일명이 올바르지 않습니다."); }
    if (name.includes("\\") || name.startsWith("/") || name.includes("\0") || name.split("/").includes("..") || names.has(name)) {
      invalid("엑셀 내부 파일 경로가 올바르지 않습니다.");
    }
    names.add(name);
    if (/(?:vbaProject|externalLinks|activeX|embeddings|customUI|macrosheets)/i.test(name)) {
      invalid("매크로, 외부 연결, 첨부 개체가 있는 엑셀은 지원하지 않습니다. 값만 복사한 XLSX를 올려 주세요.");
    }
    if (localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      invalid("엑셀 압축 데이터가 손상되었습니다.");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > directoryStart || dataOffset > directoryStart
      || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method
      || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
      || occupied.some(([start, finish]) => localOffset < finish && dataEnd > start)) {
      invalid("엑셀 압축 데이터가 일치하지 않습니다.");
    }
    occupied.push([localOffset, dataEnd]);
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let content: Buffer;
    try {
      content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, expandedSize) });
    } catch { invalid("엑셀 압축 데이터가 손상되었거나 압축 해제 제한을 초과했습니다."); }
    if (content.length !== expandedSize) invalid("엑셀 압축 해제 크기가 파일 정보와 일치하지 않습니다.");
    expanded += content.length;

    if (/\.(?:xml|rels)$/i.test(name)) {
      let xml: string;
      try { xml = decoder.decode(content); }
      catch { invalid("UTF-8 형식의 XLSX 파일만 지원합니다."); }
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /\bTargetMode\s*=\s*["']External["']/i.test(xml)
        || /macroEnabled|vbaProject|externalLink|relationships\/(?:oleObject|package)/i.test(xml)) {
        invalid("매크로 또는 외부 연결이 있는 엑셀은 지원하지 않습니다. 값만 복사한 XLSX를 올려 주세요.");
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
        worksheetCount += 1;
        if (worksheetCount > MAX_SHEETS) invalid("엑셀 시트는 최대 10개까지 지원합니다.");
        if (/<(?:[\w.-]+:)?f(?:\s|\/?>)/.test(xml)) {
          invalid("수식이 있는 엑셀은 정산 금액을 검증할 수 없습니다. 수식을 값으로 붙여넣은 XLSX를 올려 주세요.");
        }
        let rowCount = 0;
        for (const match of xml.matchAll(/<(?:[\w.-]+:)?(row|c|mergeCell|col)\b([^>]*)>/g)) {
          const tag = match[1];
          const attributes = match[2]!;
          if (tag === "row") {
            rowCount += 1;
            const reference = xmlAttribute(attributes, "r");
            if (rowCount > MAX_ROWS || (reference !== undefined && (!/^[1-9]\d*$/.test(reference) || Number(reference) > MAX_ROWS))) {
              invalid("엑셀 시트는 10,000행 이내여야 합니다.");
            }
          } else if (tag === "c") {
            cellCount += 1;
            if (cellCount > MAX_CELLS) invalid("엑셀 전체 셀 수는 100,000개 이내여야 합니다.");
            const reference = xmlAttribute(attributes, "r");
            if (reference) checkCellReference(reference);
          } else if (tag === "mergeCell") {
            const reference = xmlAttribute(attributes, "ref");
            if (reference) reference.split(":").forEach(checkCellReference);
          } else if (tag === "col") {
            const minimum = xmlAttribute(attributes, "min");
            const maximum = xmlAttribute(attributes, "max");
            if (minimum === undefined || maximum === undefined || !/^[1-9]\d*$/.test(minimum)
              || !/^[1-9]\d*$/.test(maximum) || Number(minimum) > Number(maximum) || Number(maximum) > MAX_COLUMNS) {
              invalid("엑셀 열 범위는 서식이 설정된 열을 포함하여 40열 이내여야 합니다.");
            }
          }
        }
      }
    }
    cursor = next;
  }
  if (cursor !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml") || worksheetCount === 0) {
    invalid("워크시트가 포함된 XLSX 파일을 올려 주세요.");
  }
}

function cellText(cell: ExcelJS.Cell, sheetName: string): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (cell.type === ExcelJS.ValueType.Merge) invalid(`${sheetName}!${cell.address}: 병합된 데이터 셀은 지원하지 않습니다.`);
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH || value.includes("\0")) invalid(`${sheetName}!${cell.address}: 셀 텍스트가 너무 길거나 올바르지 않습니다.`);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
    invalid(`${sheetName}!${cell.address}: 수식 대신 확정된 값을 업로드해 주세요.`);
  }
  invalid(`${sheetName}!${cell.address}: 오류, 링크, 서식 있는 텍스트 등은 지원하지 않습니다. 일반 텍스트·숫자·날짜로 바꿔 주세요.`);
}

function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Does not calculate formulas or discard rows silently. Original bytes remain the API's evidence. */
export async function readOdaWorkbook(bytes: Buffer, options: OdaWorkbookOptions = {}): Promise<OdaWorkbookResult> {
  const headerRow = options.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > MAX_ROWS) invalid("제목 행은 1~10,000 사이의 정수여야 합니다.");
  inspectArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  catch { invalid("엑셀 내용을 읽지 못했습니다. XLSX로 다시 저장하거나 CSV를 올려 주세요."); }
  if (workbook.worksheets.length > MAX_SHEETS) invalid("엑셀 시트는 최대 10개까지 지원합니다.");
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const nonempty = workbook.worksheets.filter((sheet) => sheet.actualRowCount > 0);
  const sheet = options.sheetName === undefined
    ? (nonempty.length === 1 ? nonempty[0] : undefined)
    : workbook.getWorksheet(options.sheetName);
  if (!sheet) {
    if (options.sheetName !== undefined) invalid(`'${options.sheetName}' 시트가 없습니다. 사용 가능한 시트: ${sheetNames.join(", ")}`);
    if (nonempty.length === 0) invalid("엑셀에 정산할 데이터가 없습니다.");
    invalid(`여러 시트에 데이터가 있습니다. 가져올 시트를 선택해 주세요: ${nonempty.map((entry) => entry.name).join(", ")}`);
  }
  if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) invalid("엑셀 시트는 10,000행, 40열 이내여야 합니다.");
  if (headerRow > sheet.rowCount) invalid("선택한 제목 행이 데이터 범위를 벗어났습니다.");

  const rows: string[][] = [];
  for (let rowNumber = headerRow; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(Array.from({ length: sheet.columnCount }, (_, index) => cellText(row.getCell(index + 1), sheet.name)));
  }
  const headers = rows[0]!.map((value) => value.trim());
  if (!headers.some(Boolean)) invalid("선택한 제목 행이 비어 있습니다. 열 제목이 있는 행을 선택해 주세요.");
  const headerSet = new Set<string>();
  for (const header of headers.filter(Boolean)) {
    if (headerSet.has(header.toLowerCase())) invalid(`중복된 열 제목 '${header}'이 있습니다. 열 제목을 구분해 주세요.`);
    headerSet.add(header.toLowerCase());
  }
  const mapped = [...headers];
  const usedSources = new Set<string>();
  for (const [canonical, sourceHeader] of Object.entries(options.columnMap ?? {})) {
    if (!CANONICAL_FIELDS.has(canonical) || typeof sourceHeader !== "string" || !sourceHeader.trim()) {
      invalid("열 연결 정보가 올바르지 않습니다.");
    }
    const source = sourceHeader.trim();
    const sourceIndex = headers.indexOf(source);
    if (sourceIndex < 0) invalid(`'${source}' 열을 찾을 수 없습니다.`);
    if (usedSources.has(source)) invalid(`'${source}' 열을 두 항목에 중복 연결할 수 없습니다.`);
    usedSources.add(source);
    mapped[sourceIndex] = canonical;
  }
  const mappedNonempty = mapped.filter(Boolean).map((header) => header.toLowerCase());
  if (new Set(mappedNonempty).size !== mappedNonempty.length) invalid("열 연결 결과에 중복된 항목이 있습니다.");
  rows[0] = mapped;
  return { csv: rows.map((row) => row.map(quoteCsv).join(",")).join("\n"), sheetNames, sheetName: sheet.name, headers };
}
