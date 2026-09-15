import { createHash } from "node:crypto";
import { calculateOdaMonth, createOdaMonth, type OdaLine, type OdaSource } from "@ofd/domain";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildOdaExpenseExport } from "./oda-expense-export.ts";

const NOW = new Date("2026-09-15T02:00:00.000Z");
function fixture() {
  const month = createOdaMonth("store-oda", "2026-09", NOW.toISOString());
  const evidenceBytes: Record<string, string> = {};
  const addSource = (id: string, fileName = "영수증.pdf", kind: OdaSource["kind"] = "evidence", body = Buffer.from(`original ${id}`)) => {
    const source: OdaSource = { id, fileName, kind, sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length,
      channel: "manual", importedAt: NOW.toISOString(), importedBy: "store-owner", rowCount: 0, mimeType: "application/pdf" };
    month.sources.push(source); evidenceBytes[id] = body.toString("base64"); return source;
  };
  const addLine = (id: string, values: Partial<OdaLine> = {}) => {
    const line: OdaLine = { id, date: "2026-09-10", kind: "expense", description: "원두", amount: 11000, vat: 1000, category: "ingredients", channel: "manual", sourceId: "", sourceRow: 0, externalId: "", note: "", reviewed: false, ...values };
    month.lines.push(line); return line;
  };
  return { month, evidenceBytes, storeName: "ODA 한글점", exportedAt: NOW, addSource, addLine };
}
async function unpack(input: ReturnType<typeof fixture>) {
  const bytes = await buildOdaExpenseExport(input);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const read = async (name: string) => zip.file(name)!.async("string");
  return { bytes, zip, read };
}

describe("ODA expense evidence handoff", () => {
  it("creates a CRC-valid UTF-8 ZIP with exact original bytes and only this month's relevant or unattached cost sources", async () => {
    const input = fixture();
    const original = Buffer.from([0, 1, 2, 255, 254, 37, 80, 68, 70]);
    input.addSource("receipt", "매장 영수증.pdf", "evidence", original);
    input.addSource("unattached", "미연결 카드내역.csv", "expense");
    input.addSource("sales-only", "POS.csv", "pos");
    input.addSource("bank-unused", "통장.csv", "bank");
    input.addLine("coffee", { sourceId: "receipt", reviewed: true });
    input.addLine("sale", { kind: "revenue", category: "sales", sourceId: "sales-only" });
    input.evidenceBytes["other-store"] = Buffer.from("other store private bytes").toString("base64");
    input.evidenceBytes["prior-month"] = Buffer.from("prior month private bytes").toString("base64");
    const { zip, read } = await unpack(input);
    const evidenceFiles = Object.keys(zip.files).filter((name) => name.startsWith("증빙/"));
    expect(evidenceFiles).toHaveLength(2);
    const receiptPath = evidenceFiles.find((name) => name.endsWith("매장 영수증.pdf"))!;
    expect(await zip.file(receiptPath)!.async("nodebuffer")).toEqual(original);
    const manifest = await read("증빙목록.csv");
    expect(manifest).toContain(receiptPath);
    expect(manifest).toContain(input.month.sources[0]!.sha256);
    expect(manifest).toContain("미연결 · 용도 확인 필요");
    expect(manifest).not.toContain("sales-only");
    expect(manifest).not.toContain("bank-unused");
    expect(manifest).not.toContain("other-store");
    expect(manifest).not.toContain("prior-month");
    expect((await zip.file("운영비등록.csv")!.async("nodebuffer")).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(await read("읽어주세요.txt")).toContain("작성 중 · 미확정");
    expect(await read("읽어주세요.txt")).toContain("매장 ID: store-oda");
  });

  it("retains unknown VAT, missing proof, credit amounts and pending recurring proposals without creating a second P&L", async () => {
    const input = fixture();
    input.addLine("unknown", { vat: null });
    input.addLine("zero", { vat: 0 });
    input.addLine("credit", { amount: -1100, vat: -100 });
    input.addLine("repeat", { externalId: "repeat:2026-08:prior", description: "월세", category: "rent", amount: 2000000 });
    const { read } = await unpack(input);
    const costs = await read("운영비등록.csv");
    expect(costs).toContain('11000,"","미확인"');
    expect(costs).toContain('11000,0,"0원으로 기록"');
    expect(costs).toContain('-1100,-100');
    expect(costs).toContain("증빙 미연결");
    expect(costs).toContain("반복 비용 제안 · 손익 미반영");
    expect(await read("읽어주세요.txt")).toContain("CSV 행을 단순 합산한 금액은 월 손익이 아닙니다");
  });

  it("separates contract exclusions, investment consent originals and explicitly excluded revenue", async () => {
    const input = fixture();
    input.addSource("investment"); input.addSource("consent", "사전동의.pdf");
    input.addLine("equipment", { category: "capex", description: "장비", sourceId: "investment", approvalSourceId: "consent", amount: 1200000 });
    input.addLine("priority", { description: "A 선공제", category: "labor" });
    input.addLine("excluded-sale", { kind: "excluded", originalKind: "revenue", description: "중복 매출", category: "sales" });
    input.addLine("normal", { description: "포장재", category: "supplies" });
    const { read, zip } = await unpack(input);
    const costs = await read("운영비등록.csv"); const excluded = await read("손익제외.csv");
    expect(costs).toContain("포장재"); expect(costs).not.toContain("equipment"); expect(costs).not.toContain("priority");
    expect(excluded).toContain("equipment"); expect(excluded).toContain("priority"); expect(excluded).toContain('"excluded","revenue"');
    expect(excluded).toContain("사전동의.pdf");
    expect(Object.keys(zip.files).filter((name) => name.startsWith("증빙/"))).toHaveLength(2);
  });

  it("neutralizes CSV formulas and gives unsafe or duplicate source filenames unique portable paths", async () => {
    const input = fixture();
    input.addSource("file/a", "../../=receipt.pdf"); input.addSource("file?a", "../../=receipt.pdf");
    input.addSource("long-name", "영수증".repeat(80) + ".pdf");
    input.addLine("=cmd", { description: '=HYPERLINK("https://evil.invalid","open")', note: "\t=1+1", sourceId: "file/a", externalId: "+cmd", category: "supplies" });
    input.addLine("second", { description: "  @SUM(1)", sourceId: "file?a" });
    const { zip, read } = await unpack(input);
    const costs = await read("운영비등록.csv");
    expect(costs).toContain('"\'=HYPERLINK(""https://evil.invalid"",""open"")"');
    expect(costs).toContain('"\'\t=1+1"'); expect(costs).toContain('"\'  @SUM(1)"'); expect(costs).toContain('"\'+cmd"');
    const files = Object.keys(zip.files).filter((name) => name.startsWith("증빙/"));
    expect(files).toHaveLength(3); expect(new Set(files).size).toBe(3);
    expect(files.every((name) => name.split("/").length === 2 && !name.includes("..") && !name.includes("\\"))).toBe(true);
    expect(files.every((name) => Buffer.byteLength(name.split("/")[1]!, "utf8") < 255 && name.endsWith(".pdf"))).toBe(true);
  });

  it("reports missing or corrupted originals explicitly and never substitutes different bytes", async () => {
    const input = fixture();
    input.addSource("missing"); input.addSource("corrupt");
    input.addLine("one", { sourceId: "missing" }); input.addLine("two", { sourceId: "corrupt" });
    delete input.evidenceBytes.missing;
    input.evidenceBytes.corrupt = Buffer.from("wrong bytes").toString("base64");
    const { zip, read } = await unpack(input);
    expect(Object.keys(zip.files).filter((name) => name.startsWith("증빙/"))).toEqual([]);
    expect(await read("증빙목록.csv")).toContain("원본 파일 누락");
    expect(await read("증빙목록.csv")).toContain("원본 검증 실패 · 파일 제외");
    expect(await read("운영비등록.csv")).toContain("원본 검증 실패 · 파일 제외");
  });

  it("uses the frozen finalized snapshot and does not pull prior history originals into drafts", async () => {
    const input = fixture();
    input.addSource("frozen"); input.addLine("frozen-line", { sourceId: "frozen", description: "확정 기록", reviewed: true });
    input.month.history = [{ id: "snapshot", version: 1, at: NOW.toISOString(), actorId: "owner", actorName: "점주", reason: "월 정산 확정", lines: structuredClone(input.month.lines), sources: structuredClone(input.month.sources), policy: structuredClone(input.month.policy), summary: calculateOdaMonth(input.month) }];
    input.month.status = "finalized"; input.month.version = 2;
    input.month.lines = []; input.month.sources = [];
    input.addSource("current-extra"); input.addLine("current-line", { sourceId: "current-extra", description: "현재 기록" });
    let result = await unpack(input);
    expect(await result.read("운영비등록.csv")).toContain("확정 기록");
    expect(await result.read("운영비등록.csv")).not.toContain("현재 기록");
    expect(await result.read("읽어주세요.txt")).toContain("확정 당시 보관본 v1");
    input.month.status = "draft";
    result = await unpack(input);
    expect(await result.read("증빙목록.csv")).not.toContain("frozen");
    expect(await result.read("운영비등록.csv")).toContain("현재 기록");
  });

  it("rejects out-of-month lines and over-limit evidence without constructing a partial ZIP", async () => {
    const input = fixture(); input.addLine("wrong", { date: "2026-08-31" });
    await expect(buildOdaExpenseExport(input)).rejects.toThrow("범위");
    input.month.lines = [];
    input.addSource("large", "large.pdf", "evidence", Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(buildOdaExpenseExport(input)).rejects.toThrow("용량 한도");
  });
});
