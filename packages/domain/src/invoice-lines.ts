import { invariant } from "./errors.ts";
import { splitVatInclusive } from "./money.ts";
import type { TaxInvoiceLine } from "./types.ts";

export interface InvoiceLineInput {
  id: string;
  description: string;
  quantity: number;
  gross: number;
}

/** 동일 입력은 항상 동일 순서와 99행 이하 part를 만든다. VAT 1원 배분은 전체 그룹 기준이다. */
export function buildInvoiceLineParts(inputs: InvoiceLineInput[], maxLines = 99): TaxInvoiceLine[][] {
  invariant(Number.isInteger(maxLines) && maxLines >= 1 && maxLines <= 99, "INVALID_INVOICE_LINE_LIMIT", "세금계산서 행 제한은 1~99여야 합니다.");
  invariant(inputs.length > 0, "EMPTY_INVOICE_LINES", "세금계산서 품목이 필요합니다.");
  const sorted = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  const parts: TaxInvoiceLine[][] = [];
  for (let index = 0; index < sorted.length; index += maxLines) {
    const chunk = sorted.slice(index, index + maxLines);
    const vat = splitVatInclusive(chunk.map(({ id, gross }) => ({ id, gross })));
    parts.push(chunk.map((input, lineIndex) => {
      const tax = vat.lines[lineIndex]!;
      return { ...input, supply: tax.supply, vat: tax.vat };
    }));
  }
  return parts;
}
