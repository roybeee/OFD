import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readOdaWorkbook } from "./oda-spreadsheet.ts";

async function workbookBytes(setup?: (workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("9월 매출");
  sheet.addRow(["거래일", "적요", "결제금액", "부가세"]);
  sheet.addRow([new Date("2026-09-17T00:00:00.000Z"), "마르게리타", 13_200, 1_200]);
  setup?.(workbook, sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Deliberately minimal ZIP; rejected preflight fixtures never reach the workbook parser. */
function zipFixture(name: string, body: Buffer, statedSize = body.length, method = 0): Buffer {
  const nameBytes = Buffer.from(name);
  const compressed = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(statedSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(method, 10);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(statedSize, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, directory, nameBytes, end]);
}

describe("ODA native XLSX import", () => {
  it("converts typed Excel dates and exact signed numbers to CSV with original header metadata", async () => {
    const bytes = await workbookBytes((_workbook, sheet) => {
      sheet.addRow([new Date("2026-09-18T00:00:00.000Z"), '환불, "부분"\n취소', -2_200, -200]);
    });
    const result = await readOdaWorkbook(bytes, { columnMap: { date: "거래일", description: "적요", amount: "결제금액", vat: "부가세" } });
    expect(result).toEqual({
      csv: 'date,description,amount,vat\n2026-09-17,마르게리타,13200,1200\n2026-09-18,"환불, ""부분""\n취소",-2200,-200',
      sheetNames: ["9월 매출"], sheetName: "9월 매출", headers: ["거래일", "적요", "결제금액", "부가세"],
    });
  });

  it("selects a header row and retains blank data rows for evidence row matching", async () => {
    const bytes = await workbookBytes((_workbook, sheet) => {
      sheet.spliceRows(1, 0, ["POS 월간 보고서"]);
      sheet.getCell("A5").value = "2026-09-19";
      sheet.getCell("C5").value = 15_000;
    });
    const result = await readOdaWorkbook(bytes, { headerRow: 2 });
    expect(result.csv).toBe("거래일,적요,결제금액,부가세\n2026-09-17,마르게리타,13200,1200\n,,,\n2026-09-19,,15000,");
  });

  it("does not infer a sheet when multiple sheets contain data, and imports only the explicit selection", async () => {
    const bytes = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("배달 매출");
      sheet.addRows([["date", "amount"], ["2026-09-18", 25_000]]);
      workbook.addWorksheet("빈 시트");
    });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("가져올 시트를 선택");
    const selected = await readOdaWorkbook(bytes, { sheetName: "배달 매출" });
    expect(selected.sheetNames).toEqual(["9월 매출", "배달 매출", "빈 시트"]);
    expect(selected.csv).toBe("date,amount\n2026-09-18,25000");
    await expect(readOdaWorkbook(bytes, { sheetName: "없는 시트" })).rejects.toThrow("시트가 없습니다");
  });

  it("ignores truly empty worksheets for automatic single-sheet selection", async () => {
    const bytes = await workbookBytes((workbook) => { workbook.addWorksheet("빈 시트"); });
    expect((await readOdaWorkbook(bytes)).sheetName).toBe("9월 매출");
  });

  it("rejects formulas even when their cached result looks valid", async () => {
    const bytes = await workbookBytes((_workbook, sheet) => {
      sheet.getCell("C2").value = { formula: "12000*1.1", result: 13_200 };
    });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("수식");
  });

  it.each([
    { error: "#VALUE!" },
    { richText: [{ text: "검증되지 않은 금액" }] },
    true,
  ] as ExcelJS.CellValue[])("rejects unsupported or error cell values (%j)", async (value) => {
    const bytes = await workbookBytes((_workbook, sheet) => { sheet.getCell("C2").value = value; });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("지원하지 않습니다");
  });

  it("rejects external relationships and embedded macro payloads", async () => {
    const bytes = await workbookBytes((_workbook, sheet) => {
      sheet.getCell("B2").value = { text: "영수증", hyperlink: "https://example.com/receipt" };
    });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("외부 연결");
    await expect(readOdaWorkbook(zipFixture("xl/vbaProject.bin", Buffer.from("macro")))).rejects.toThrow("매크로");
  });

  it("rejects compressed and declared expanded limits before allocating workbook data", async () => {
    await expect(readOdaWorkbook(Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toThrow("2MB");
    await expect(readOdaWorkbook(zipFixture("xl/worksheets/sheet1.xml", Buffer.from("small"), 20 * 1024 * 1024 + 1)))
      .rejects.toThrow("20MB");
  });

  it("bounds actual inflation when the ZIP directory lies about the uncompressed size", async () => {
    const bytes = zipFixture("xl/worksheets/sheet1.xml", Buffer.alloc(1024 * 1024, 65), 100, 8);
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("압축 해제 제한");
  });

  it.each(["A10001", "AO2"])("rejects sparse out-of-limit cell %s before workbook loading", async (address) => {
    const bytes = await workbookBytes((_workbook, sheet) => { sheet.getCell(address).value = 100; });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow(/10,000행|40열/);
  });

  it("rejects excessive worksheet counts", async () => {
    const bytes = await workbookBytes((workbook) => {
      for (let index = 0; index < 10; index += 1) workbook.addWorksheet(`추가${index}`);
    });
    await expect(readOdaWorkbook(bytes)).rejects.toThrow("최대 10개");
  });

  it("blocks a huge formatted column range before ExcelJS expands column objects", async () => {
    const xml = Buffer.from('<worksheet><cols><col min="1" max="999999999" width="10"/></cols></worksheet>');
    await expect(readOdaWorkbook(zipFixture("xl/worksheets/sheet1.xml", xml))).rejects.toThrow("40열");
  });

  it("maps platform gross sales, fee, fee VAT and bank payout independently", async () => {
    const bytes = await workbookBytes((_workbook, sheet) => {
      sheet.getRow(1).values = ["주문일", "주문금액", "이용료", "이용료 세액", "입금액"];
      sheet.getRow(2).values = ["2026-09-17", 20_000, 2_200, 200, 17_800];
    });
    const result = await readOdaWorkbook(bytes, {
      columnMap: { date: "주문일", amount: "주문금액", feeAmount: "이용료", feeVat: "이용료 세액", payoutAmount: "입금액" },
    });
    expect(result.csv).toBe("date,amount,feeAmount,feeVat,payoutAmount\n2026-09-17,20000,2200,200,17800");
  });

  it("rejects missing and ambiguous header mappings", async () => {
    const bytes = await workbookBytes();
    await expect(readOdaWorkbook(bytes, { columnMap: { amount: "누락된 금액" } })).rejects.toThrow("열을 찾을 수 없습니다");
    await expect(readOdaWorkbook(bytes, { columnMap: { amount: "결제금액", vat: "결제금액" } })).rejects.toThrow("중복 연결");
    await expect(readOdaWorkbook(bytes, { columnMap: { unknownField: "결제금액" } })).rejects.toThrow("열 연결 정보");
    await expect(readOdaWorkbook(bytes, { headerRow: 0 })).rejects.toThrow("제목 행");
    await expect(readOdaWorkbook(bytes, { headerRow: 3 })).rejects.toThrow("범위를 벗어났습니다");
    const repeated = await workbookBytes((_workbook, sheet) => { sheet.getCell("D1").value = "결제금액"; });
    await expect(readOdaWorkbook(repeated)).rejects.toThrow("중복된 열 제목");
  });
});
