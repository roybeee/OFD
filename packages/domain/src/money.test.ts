import assert from "node:assert/strict";
import test from "node:test";
import { calculateLineGross, splitVatInclusive } from "./money.ts";

test("VAT 포함 총액을 문서 단위로 반올림하고 행 합계를 일치시킨다", () => {
  const result = splitVatInclusive([
    { id: "b", gross: 1_001 },
    { id: "a", gross: 2_002 },
    { id: "c", gross: 3_003 },
  ]);
  assert.equal(result.gross, 6_006);
  assert.equal(result.supply, Math.round(6_006 * 100 / 110));
  assert.equal(result.vat, result.gross - result.supply);
  assert.equal(result.lines.reduce((sum, line) => sum + line.supply, 0), result.supply);
  assert.equal(result.lines.reduce((sum, line) => sum + line.vat, 0), result.vat);
});

test("같은 나머지는 행 ID 순으로 결정론적으로 배분한다", () => {
  const result = splitVatInclusive([{ id: "b", gross: 6 }, { id: "a", gross: 6 }]);
  assert.deepEqual(result.lines.map(({ id, supply }) => ({ id, supply })), [
    { id: "b", supply: 5 },
    { id: "a", supply: 6 },
  ]);
});

test("수량과 단가 검증 후 행 총액을 계산한다", () => {
  assert.equal(calculateLineGross(18_900, 3), 56_700);
  assert.throws(() => calculateLineGross(10_000, 0), /수량/);
});
