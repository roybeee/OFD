import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  createNativeEmployer, createNativeContract, requestNativeContract, signNativeContract,
  recordNativeContractDelivery, NATIVE_ESIGN_CONSENT_VERSION,
  type NativeContract, type NativeEsignContext,
} from "@ofd/domain";
import { describe, expect, it } from "vitest";
import { assertNativeContractPdfText, createNativeContractPdf } from "./oda-esign-pdf.ts";

function fixture(additionalTerms = "매장 운영에 필요한 업무를 성실하게 수행합니다.", options: { employeeName?: string; userAgent?: string } = {}) {
  let sequence = 0;
  const now = "2026-09-16T03:00:00.000Z";
  const context: NativeEsignContext = { actorId: "owner-1", manager: true, now, id: () => `pdf-${++sequence}`,
    hash: value => createHash("sha256").update(value).digest("hex"), authMethod: "password_reauthentication", reauthenticatedAt: now,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}) };
  const employeeName = options.employeeName ?? "김도윤";
  const employer = createNativeEmployer({ storeId: "store-oda", legalName: "주식회사 밀집", businessNumber: "1234567891", representativeName: "황인범", address: "서울특별시 성동구 성수동", signerActorId: "owner-1", signerName: "황인범" }, context);
  const draft = createNativeContract({ storeId: "store-oda", employeeId: "staff-1", employeeActorId: "staff-login-1", employeeName, title: "ODA 외대점 근로계약서", templateKey: "oda-labor-v1", terms: {
    employmentType: "part_time", payType: "hourly", basePay: 12000, effectiveDate: "2026-09-17", endDate: "", jobTitle: "매장 운영", workplace: "ODA 외대점",
    workDays: "월요일, 수요일, 금요일", dailyWorkHours: "월·수·금 09:00~18:00 (휴게 1시간)", workStart: "09:00", workEnd: "18:00", breakMinutes: 60,
    payday: "매월 10일", payCalculation: "시급 × 실제 근로시간, 법정수당 별도 산정", payMethod: "근로자 본인 계좌 이체", holidays: "주휴일은 일요일", annualLeave: "관계 법령에 따름", additionalTerms,
  } }, employer, context);
  const requested = requestNativeContract(draft, { expectedVersion: draft.version, expiresAt: "2026-09-20T03:00:00.000Z" }, context);
  const signed = signNativeContract(requested, { expectedVersion: requested.version, role: "employer", typedName: "황인범", consent: true, consentVersion: NATIVE_ESIGN_CONSENT_VERSION, documentHash: requested.documentHash,
    strokes: [[{ x: .1, y: .6 }, { x: .35, y: .15 }, { x: .5, y: .7 }, { x: .85, y: .4 }]] }, context);
  const completed = signNativeContract(signed, { expectedVersion: signed.version, role: "employee", typedName: employeeName, consent: true, consentVersion: NATIVE_ESIGN_CONSENT_VERSION, documentHash: signed.documentHash,
    strokes: [[{ x: .2, y: .5 }, { x: .4, y: .3 }, { x: .6, y: .8 }], [{ x: .45, y: .2 }, { x: .75, y: .4 }]] }, { ...context, actorId: "staff-login-1", manager: false });
  return { draft, requested, completed, context };
}

/** Read PDF streams and the embedded font's ToUnicode map. This checks actual
 * searchable PDF text, rather than looking for labels in the generator source. */
function pdfContents(bytes: Buffer): { text: string; streams: string[]; pages: number } {
  const binary = bytes.toString("latin1");
  const streams = [...binary.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(match => {
    try { return [inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")]; } catch { return []; }
  });
  const cmap = streams.find(value => value.includes("beginbfrange")) ?? "";
  const unicode = new Map<number, string>();
  for (const range of cmap.matchAll(/<([\da-f]+)>\s+<([\da-f]+)>\s+\[([^\]]+)\]/gi)) {
    let index = parseInt(range[1]!, 16);
    for (const value of range[3]!.matchAll(/<([\da-f\s]+)>/gi)) {
      unicode.set(index++, (value[1]!.replace(/\s/g, "").match(/.{4}/g) ?? []).map(unit => String.fromCharCode(parseInt(unit, 16))).join(""));
    }
  }
  const text = streams.filter(value => value.includes(" TJ")).map(stream => [...stream.matchAll(/\[([^\]]+)\]\s*TJ/g)].map(run => [...run[1]!.matchAll(/<([\da-f]+)>/gi)].map(hex =>
    (hex[1]!.match(/.{4}/g) ?? []).map(unit => unicode.get(parseInt(unit, 16)) ?? "�").join("")).join("")).join("\n")).join("\n");
  return { text, streams, pages: [...binary.matchAll(/\/Type \/Page\b/g)].length };
}

describe("native contract PDF", () => {
  it("preserves Vietnamese and CJK names and unit symbols as searchable agreement text", async () => {
    const employeeName = "Nguyễn Văn Đạt · 李华 · 田中太郎 · 𠮷";
    const clause = "근무 공간 50㎡, 보관 온도 4℃. 담당자 张伟 및 Nguyễn Văn Đạt에게 보고합니다.";
    const { requested, completed } = fixture(clause, { employeeName });
    expect(() => assertNativeContractPdfText(requested)).not.toThrow();
    const content = pdfContents(await createNativeContractPdf(completed, "contract"));
    expect(content.text).toContain(employeeName);
    expect(content.text.replace(/\s/g, "")).toContain(clause.replace(/\s/g, ""));
    expect(content.text).not.toContain("�");
  });

  it("rejects unsupported agreement characters instead of silently dropping them", async () => {
    const { requested, completed } = fixture("계약 특약 🙏");
    expect(() => assertNativeContractPdfText(requested)).toThrow("U+1F64F");
    await expect(createNativeContractPdf(completed, "contract")).rejects.toMatchObject({ code: "ESIGN_UNSUPPORTED_TEXT", statusCode: 422 });
  });

  it("escapes unsupported technical metadata while retaining its original signature hash", async () => {
    const { completed } = fixture(undefined, { userAgent: "Synthetic client 🙏" });
    const content = pdfContents(await createNativeContractPdf(completed, "evidence"));
    expect(content.text).toContain("Synthetic client \\u{1F64F}");
    expect(completed.signatures[0]!.userAgent).toBe("Synthetic client 🙏");
    expect(content.text.replace(/\s/g, "")).toContain(completed.audit.find(event => event.action === "signature.employer")!.details.signatureHash);
  });

  it("embeds searchable Korean, immutable terms, both signature vectors and verifiable identity records", async () => {
    const { completed } = fixture();
    const bytes = await createNativeContractPdf(completed, "contract");
    const content = pdfContents(bytes);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    for (const value of ["ODA 전자근로계약", "주식회사 밀집", "123-45-67891", "김도윤", "황인범", "password_reauthentication", completed.documentHash, "매장 운영에 필요한 업무를 성실하게 수행합니다."]) expect(content.text).toContain(value);
    expect(content.text).not.toContain("�");
    expect(content.text).not.toContain("서명 완료 전 미리보기");
    expect(content.pages).toBeGreaterThan(1);
    // There are actual stroked paths on both signature panels, not just names.
    expect(content.streams.join("\n").match(/\n[\d.]+ [\d.]+ m\n[\d.]+ [\d.]+ l\n[\d.]+ [\d.]+ l/g)?.length).toBeGreaterThanOrEqual(2);
    expect(content.text).toContain(`1 / ${content.pages}`);
    expect(content.text).toContain(`${content.pages} / ${content.pages}`);
  });

  it("retains the end of a long multi-page agreement and every clause", async () => {
    const clauses = Array.from({ length: 72 }, (_, index) => `추가조항 ${String(index + 1).padStart(3, "0")}: 매장별 업무 범위, 소정근로일, 휴게시간 및 임금 구성에 관하여 양 당사자가 확인합니다.`);
    const { completed } = fixture(`${clauses.join("\n")}\n최종 약정 마지막 문장입니다.`);
    const content = pdfContents(await createNativeContractPdf(completed, "contract"));
    for (let index = 1; index <= 72; index++) expect(content.text).toContain(`추가조항 ${String(index).padStart(3, "0")}`);
    expect(content.text).toContain("최종 약정 마지막 문장입니다.");
    expect(content.pages).toBeGreaterThanOrEqual(5);
  });

  it("produces byte-stable completed copies after later delivery activity", async () => {
    const { completed, context } = fixture();
    const first = await createNativeContractPdf(completed, "contract");
    expect(await createNativeContractPdf(completed, "contract")).toEqual(first);
    const delivered = recordNativeContractDelivery(completed, { expectedVersion: completed.version, method: "manual_handover", evidenceNote: "사본을 직원에게 전달하고 확인함" }, { ...context, now: "2026-09-17T03:00:00.000Z" });
    expect(await createNativeContractPdf(delivered, "contract")).toEqual(first);
  });

  it("records the full hash chain and labels preview and in-house evidence accurately", async () => {
    const { completed, requested } = fixture();
    const preview = pdfContents(await createNativeContractPdf(requested, "contract"));
    expect(preview.text).toContain("서명 완료 전 미리보기");
    const evidence = pdfContents(await createNativeContractPdf(completed, "evidence"));
    expect(evidence.text).toContain("ODA 계약 진행기록");
    expect(evidence.text).toContain("ODA 내부 시스템");
    for (const event of completed.audit) expect(evidence.text.replace(/\s/g, "")).toContain(event.hash);
    expect(evidence.text).toContain("contract.completed");
    expect(evidence.text).toContain("별도 사본 제공·접근 기록이 없습니다.");
  });

  it("refuses to render an altered document instead of giving it a credible PDF appearance", async () => {
    const { completed } = fixture();
    const tampered: NativeContract = { ...completed, documentText: `${completed.documentText}\n임금 변경` };
    await expect(createNativeContractPdf(tampered, "contract")).rejects.toThrow("무결성");
  });
});
