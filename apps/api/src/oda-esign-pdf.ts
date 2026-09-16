import PDFDocument from "pdfkit";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { nativeEsignCanonicalJson, verifyNativeContractIntegrity, type NativeContract, type NativeContractSignature } from "@ofd/domain";

/** Resolve only when generating a PDF. Server imports in a Vite/JSDOM test may
 * have an HTTP module URL and a browser URL constructor, whereas deployed src/
 * and dist/ modules use file URLs. No font or filesystem work belongs at import. */
function koreanFontPath(): string {
  const moduleUrl = new NodeURL(import.meta.url);
  if (moduleUrl.protocol === "file:") {
    const besideModule = fileURLToPath(new NodeURL("../assets/fonts/NanumGothic-Regular.ttf", moduleUrl));
    if (existsSync(besideModule)) return besideModule;
  }
  let directory = process.cwd();
  for (;;) {
    for (const relative of ["apps/api/assets/fonts/NanumGothic-Regular.ttf", "assets/fonts/NanumGothic-Regular.ttf"]) {
      const candidate = resolve(directory, relative);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("전자계약 PDF용 한국어 글꼴을 찾을 수 없습니다. API assets/fonts 배포를 확인해 주세요.");
}
const LEFT = 48;
const RIGHT = 48;
const TOP = 78;
const BOTTOM = 62;
const INK = "#152832";
const MUTED = "#526470";
const LINE = "#D9E2E6";
const ACCENT = "#177765";

/** Explicit line layout preserves arbitrarily long Korean clauses without a
 * fixed-height text box, ellipsis, or cutting a UTF-16 surrogate pair. */
class ContractLayout {
  private y = TOP;
  readonly width: number;

  constructor(readonly pdf: PDFKit.PDFDocument, private readonly heading: string, private readonly contractId: string) {
    pdf.registerFont("Korean", koreanFontPath());
    pdf.addPage();
    this.width = pdf.page.width - LEFT - RIGHT;
    this.pageHeader();
  }

  private pageHeader() {
    this.pdf.font("Korean").fontSize(9).fillColor(ACCENT)
      .text(this.heading, LEFT, 31, { lineBreak: false });
    this.pdf.strokeColor(LINE).lineWidth(0.7).moveTo(LEFT, 54).lineTo(this.pdf.page.width - RIGHT, 54).stroke();
    this.y = TOP;
  }

  ensure(height: number) {
    if (this.y + height > this.pdf.page.height - BOTTOM) {
      this.pdf.addPage();
      this.pageHeader();
    }
  }

  gap(height = 10) { this.y += height; }

  text(value: string, options: { size?: number; color?: string; lineHeight?: number; indent?: number } = {}) {
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? size * 1.6;
    const indent = options.indent ?? 0;
    const available = this.width - indent;
    // Newlines and consecutive blank paragraphs remain visible in the document.
    for (const paragraph of String(value).replace(/\r\n?/g, "\n").split("\n")) {
      if (/^(?:\d+\.\s|제\s*\d+\s*조)/.test(paragraph)) this.ensure(lineHeight * 3);
      const chars = Array.from(paragraph.replace(/\t/g, "    "));
      if (!chars.length) { this.ensure(lineHeight); this.y += lineHeight; continue; }
      let offset = 0;
      while (offset < chars.length) {
        this.pdf.font("Korean").fontSize(size);
        let low = 1;
        let high = Math.min(chars.length - offset, 512);
        let count = 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (this.pdf.widthOfString(chars.slice(offset, offset + middle).join("")) <= available) {
            count = middle; low = middle + 1;
          } else high = middle - 1;
        }
        // Prefer a word boundary near the line end, while keeping long hashes
        // and Korean text without spaces fully readable.
        if (offset + count < chars.length) {
          for (let cut = count - 1; cut >= Math.floor(count * 0.7); cut--) {
            if (chars[offset + cut] === " ") { count = cut + 1; break; }
          }
        }
        this.ensure(lineHeight);
        this.pdf.font("Korean").fontSize(size).fillColor(options.color ?? INK)
          .text(chars.slice(offset, offset + count).join(""), LEFT + indent, this.y, { lineBreak: false });
        this.y += lineHeight;
        offset += count;
      }
    }
  }

  title(title: string) { this.text(title, { size: 22, lineHeight: 31 }); this.gap(14); }

  section(title: string) {
    this.ensure(62);
    this.gap(10);
    this.pdf.strokeColor(LINE).lineWidth(0.7).moveTo(LEFT, this.y).lineTo(LEFT + this.width, this.y).stroke();
    this.gap(12);
    this.text(title, { size: 13, color: ACCENT, lineHeight: 21 });
    this.gap(5);
  }

  field(label: string, value: string | undefined | null) {
    this.text(`${label}  ${value || "-"}`, { size: 9.4, lineHeight: 15.2 });
    this.gap(3);
  }

  signature(strokes: Array<Array<{ x: number; y: number }>>, canvasWidth: number, canvasHeight: number) {
    const height = 122;
    this.ensure(height + 12);
    this.pdf.save().roundedRect(LEFT, this.y, this.width, height, 4).fillAndStroke("#F8FAFA", LINE);
    this.pdf.restore();
    const padding = 14;
    const scale = Math.min((this.width - padding * 2) / canvasWidth, (height - padding * 2) / canvasHeight);
    const x = LEFT + (this.width - canvasWidth * scale) / 2;
    const y = this.y + (height - canvasHeight * scale) / 2;
    this.pdf.save().rect(LEFT + 1, this.y + 1, this.width - 2, height - 2).clip();
    this.pdf.lineWidth(1.4).strokeColor(INK).lineCap("round").lineJoin("round");
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      this.pdf.moveTo(x + stroke[0]!.x * scale, y + stroke[0]!.y * scale);
      for (const point of stroke.slice(1)) this.pdf.lineTo(x + point.x * scale, y + point.y * scale);
      if (stroke.length === 1) this.pdf.lineTo(x + stroke[0]!.x * scale + 0.1, y + stroke[0]!.y * scale);
      this.pdf.stroke();
    }
    this.pdf.restore();
    this.y += height + 12;
  }

  footer() {
    const pages = this.pdf.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      this.pdf.switchToPage(index);
      const y = this.pdf.page.height - 38;
      this.pdf.strokeColor(LINE).lineWidth(0.7).moveTo(LEFT, y - 11).lineTo(LEFT + this.width, y - 11).stroke();
      this.pdf.font("Korean").fontSize(7).fillColor(MUTED)
        .text(`ODA · ${this.contractId}`, LEFT, y, { lineBreak: false });
      this.pdf.fontSize(8).text(`${index + 1} / ${pages.count}`, this.pdf.page.width - RIGHT - 52, y, { lineBreak: false });
    }
  }
}

function instant(value: string | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("전자계약 시각이 올바르지 않습니다.");
  return `${new Date(parsed.valueOf() + 9 * 3_600_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} KST (UTC+09:00)`;
}

function signatures(layout: ContractLayout, contract: NativeContract, evidence: boolean) {
  layout.ensure(evidence ? 455 : 375);
  layout.section("당사자 전자서명 기록");
  for (const role of ["employer", "employee"] as const) {
    const signature: NativeContractSignature | undefined = contract.signatures.find(value => value.role === role);
    const roleLabel = role === "employer" ? "사용자" : "근로자";
    layout.ensure(signature ? (evidence ? 400 : 320) : 65);
    layout.text(`${roleLabel} · ${signature?.name ?? (role === "employer" ? contract.employer.signerName : contract.employeeName)}`, { size: 12 });
    if (!signature) { layout.text("서명 전", { color: MUTED }); layout.gap(10); continue; }
    // Browser signature canvas uses a 720:240 aspect ratio and normalized
    // coordinates. Draw the same strokes as PDF vectors, without rasterization.
    layout.signature(signature.strokes.map(stroke => stroke.map(point => ({ x: point.x * 720, y: point.y * 240 }))), 720, 240);
    layout.field("서명 시각", instant(signature.at));
    layout.field("서명 계정", signature.actorId);
    layout.field("계정 확인", "비밀번호 재확인 (password_reauthentication)");
    layout.field("재확인 시각", instant(signature.reauthenticatedAt));
    layout.field("확인 문서 SHA-256", signature.documentHash);
    layout.field("동의 버전", signature.consentVersion);
    layout.field("서명 의사", signature.intentText);
    if (evidence) {
      layout.field("서명 식별자", signature.id);
      layout.field("접속 IP", signature.ip);
      layout.field("접속 환경", signature.userAgent);
      layout.field("서명기록 SHA-256", createHash("sha256").update(nativeEsignCanonicalJson(signature)).digest("hex"));
    }
    layout.gap(14);
  }
}

const EVENT_LABELS: Record<string, string> = {
  "contract.created": "계약 초안 생성", "contract.updated": "계약 초안 수정",
  "contract.requested": "서명 요청 및 원문 확정", "signature.employer": "사용자 서명",
  "signature.employee": "근로자 서명", "contract.completed": "양 당사자 서명 완료",
  "contract.declined": "서명 거절", "contract.cancelled": "서명 요청 취소",
  "copy.employee_download": "근로자 사본 내려받기", "copy.manual_handover": "사본 수동 교부 기록",
  "hr.applied": "인사정보 반영",
};

/** Render from the stored snapshot, never by reconstructing today's employee or
 * employer data. Persist returned bytes once for a completed contract. Metadata
 * dates depend only on that snapshot, making identical inputs byte reproducible. */
export async function createNativeContractPdf(contract: NativeContract, kind: "contract" | "evidence"): Promise<Buffer> {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (!verifyNativeContractIntegrity(contract, hash)) throw new Error("전자계약 원문 또는 진행기록 무결성을 확인하지 못했습니다.");
  const evidence = kind === "evidence";
  const title = evidence ? "ODA 계약 진행기록" : "ODA 전자근로계약";
  // A contract copy remains stable when later download/delivery records change.
  // The evidence report describes its exact audit snapshot, so uses that time.
  const at = evidence ? contract.audit.at(-1)?.at ?? contract.updatedAt : contract.completedAt ?? contract.requestedAt ?? contract.createdAt;
  const metadataDate = new Date(at);
  if (!Number.isFinite(metadataDate.valueOf())) throw new Error("전자계약 기준 시각이 올바르지 않습니다.");
  const pdf = new PDFDocument({
    size: "A4", margins: { top: TOP, bottom: BOTTOM, left: LEFT, right: RIGHT },
    autoFirstPage: false, bufferPages: true, compress: true,
    info: { Title: title, Author: "ODA", Subject: contract.title, Creator: "ODA Workstation", Producer: "ODA Workstation / PDFKit",
      CreationDate: metadataDate, ModDate: metadataDate },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  try {
    const layout = new ContractLayout(pdf, title, contract.id);
    layout.title(title);
    layout.text(contract.title, { size: 13, color: MUTED });
    layout.gap(12);
    if (contract.status !== "completed") {
      layout.text("서명 완료 전 미리보기", { size: 12, color: "#965817" });
      layout.text("이 문서는 현재 진행 상태의 사본입니다. 양 당사자의 서명 완료본과 구분하여 확인해 주세요.", { size: 9, color: MUTED });
      layout.gap(10);
    }
    layout.field("문서번호", contract.id);
    layout.field("사용자", contract.employer.legalName);
    layout.field("사업자등록번호", contract.employer.businessNumber.replace(/^(\d{3})(\d{2})(\d{5})$/, "$1-$2-$3"));
    layout.field("근로자", contract.employeeName);
    layout.field("양식 버전", contract.templateKey);
    layout.field("서명 요청 시각", instant(contract.requestedAt));
    layout.field("체결 완료 시각", instant(contract.completedAt));
    layout.field("확정 원문 SHA-256", contract.documentHash || "원문 확정 전");
    if (!evidence) {
      layout.section("계약 원문");
      layout.text(contract.documentText, { size: 10, lineHeight: 16.5 });
      layout.section("문서 확인");
      layout.text("이 사본은 ODA에 저장된 계약 원문과 당사자 서명기록으로 생성되었습니다. 위 원문 SHA-256은 서명 요청 시 확정된 계약 텍스트의 해시이며, PDF 파일 자체의 해시와 구분됩니다.", { size: 9, color: MUTED });
      signatures(layout, contract, false);
    } else {
      layout.section("진행기록의 범위");
      layout.text("이 문서는 ODA 내부 시스템이 저장한 계약 진행기록입니다. 제3자 인증서나 공인 시점확인 증명서가 아닙니다. 각 사건의 해시는 기록 간 연결을 확인하는 값이며, 별도의 외부 시각 인증을 의미하지 않습니다.", { size: 9, color: MUTED });
      if (contract.status === "completed") layout.text("완료본과 함께 보관된 이 파일은 체결 시점의 기록입니다. 이후 사본 제공 및 인사정보 반영 기록은 ODA 계약 상세 화면에서 확인합니다.", { size: 9, color: MUTED });
      layout.field("기록 기준 시각", instant(at));
      layout.field("기록 버전", String(contract.version));
      layout.field("진행 상태", { draft: "작성 중", pending: "서명 진행 중", completed: "서명 완료", declined: "서명 거절", cancelled: "서명 요청 취소" }[contract.status]);
      layout.field("총 사건 수", String(contract.audit.length));
      layout.field("마지막 사건 SHA-256", contract.audit.at(-1)?.hash);
      signatures(layout, contract, true);
      layout.section("사건별 기록 및 해시 연결");
      for (const event of contract.audit) {
        layout.ensure(83);
        layout.text(`${event.sequence}. ${EVENT_LABELS[event.action] ?? event.action}`, { size: 11, color: ACCENT });
        layout.field("사건", `${event.action} / ${event.id}`);
        layout.field("기록 시각", instant(event.at));
        layout.field("수행 계정", event.actorId);
        layout.field("원문 SHA-256", event.documentHash || "원문 확정 전");
        layout.field("이전 사건 SHA-256", event.previousHash || "최초 사건");
        layout.field("현재 사건 SHA-256", event.hash);
        layout.field("추가 정보", nativeEsignCanonicalJson(event.details));
        layout.gap(13);
      }
      layout.section("사본 제공 및 접근 기록");
      if (!contract.deliveries.length) layout.text("이 기록 시점에 별도 사본 제공·접근 기록이 없습니다.", { size: 9, color: MUTED });
      for (const delivery of contract.deliveries) {
        layout.ensure(66);
        layout.field("기록 구분", delivery.method === "employee_download" ? "근로자 내려받기 요청·파일 응답 기록" : "담당자 수동 교부 기록");
        layout.field("시각 / 수행 계정", `${instant(delivery.at)} / ${delivery.actorId}`);
        layout.field("기록 식별자", delivery.id);
        layout.field("근거", delivery.evidenceNote || "별도 기재 없음");
        layout.gap(9);
      }
      layout.text("내려받기 기록만으로 실제 파일 저장이나 법적 교부 완료를 단정하지 않습니다. 사본 제공 경로와 사실관계는 별도로 확인합니다.", { size: 9, color: MUTED });
    }
    layout.footer();
    pdf.end();
  } catch (error) {
    pdf.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return output;
}
