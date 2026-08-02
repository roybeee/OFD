import { invariant } from "./errors.ts";

export interface VatLineInput {
  id: string;
  gross: number;
}

export interface VatLineResult extends VatLineInput {
  supply: number;
  vat: number;
}

export interface VatBreakdown {
  gross: number;
  supply: number;
  vat: number;
  lines: VatLineResult[];
}

/**
 * 모든 금액은 원 단위 정수다. 총액을 문서 단위로 100/110 반올림한 후,
 * 각 행의 나머지가 큰 순서로 1원씩 배분해 행 합계와 문서 합계를 항상 맞춘다.
 */
export function splitVatInclusive(lines: VatLineInput[]): VatBreakdown {
  invariant(lines.length > 0, "EMPTY_LINES", "금액 행이 하나 이상 필요합니다.");
  for (const line of lines) {
    invariant(line.id.length > 0, "INVALID_LINE_ID", "행 식별자가 필요합니다.");
    invariant(Number.isSafeInteger(line.gross) && line.gross >= 0, "INVALID_MONEY", "금액은 0 이상의 원 단위 정수여야 합니다.");
  }

  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  invariant(Number.isSafeInteger(gross), "MONEY_OVERFLOW", "금액 합계가 안전한 범위를 벗어났습니다.");
  const supplyBig = (BigInt(gross) * 100n + 55n) / 110n;
  invariant(supplyBig <= BigInt(Number.MAX_SAFE_INTEGER), "MONEY_OVERFLOW", "공급가액이 안전한 범위를 벗어났습니다.");
  const supply = Number(supplyBig);
  const allocations = lines.map((line, index) => ({
    ...line,
    index,
    base: Number((BigInt(line.gross) * 100n) / 110n),
    remainder: Number((BigInt(line.gross) * 100n) % 110n),
  }));
  let remaining = supply - allocations.reduce((sum, line) => sum + line.base, 0);
  const priority = [...allocations].sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id) || a.index - b.index);
  const extra = new Set<number>();
  for (let cursor = 0; cursor < remaining; cursor += 1) extra.add(priority[cursor]!.index);

  const resultLines = allocations.map((line) => {
    const lineSupply = line.base + (extra.has(line.index) ? 1 : 0);
    return { id: line.id, gross: line.gross, supply: lineSupply, vat: line.gross - lineSupply };
  });
  return { gross, supply, vat: gross - supply, lines: resultLines };
}

export function calculateLineGross(unitGross: number, quantity: number): number {
  invariant(Number.isSafeInteger(unitGross) && unitGross >= 0, "INVALID_UNIT_PRICE", "단가는 0 이상의 원 단위 정수여야 합니다.");
  invariant(Number.isSafeInteger(quantity) && quantity > 0, "INVALID_QUANTITY", "수량은 1 이상의 정수여야 합니다.");
  const gross = unitGross * quantity;
  invariant(Number.isSafeInteger(gross), "MONEY_OVERFLOW", "행 금액이 안전한 범위를 벗어났습니다.");
  return gross;
}
