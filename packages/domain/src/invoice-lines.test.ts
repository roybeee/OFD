import assert from "node:assert/strict";
import test from "node:test";
import { buildInvoiceLineParts } from "./invoice-lines.ts";

test("205개 품목을 결정론적으로 99·99·7행 세금계산서로 분할한다", () => {
  const inputs = Array.from({ length: 205 }, (_, index) => ({ id: `line-${String(index).padStart(3, "0")}`, description: `품목 ${index}`, quantity: 1, gross: 1_100 }));
  const parts = buildInvoiceLineParts(inputs);
  assert.deepEqual(parts.map((part) => part.length), [99, 99, 7]);
  assert.equal(parts.flat().reduce((sum, line) => sum + line.supply, 0), 205_000);
  assert.equal(parts.flat().reduce((sum, line) => sum + line.vat, 0), 20_500);
});

test("수정세금계산서와 동일하게 최대 행 제한은 99를 넘지 못한다", () => {
  assert.throws(() => buildInvoiceLineParts([{ id: "1", description: "품목", quantity: 1, gross: 1_100 }], 100), /1~99/);
});

test("분할된 각 세금계산서가 독립 문서로 100/110 반올림된다", () => {
  const parts = buildInvoiceLineParts([
    { id: "a", description: "A", quantity: 1, gross: 6 },
    { id: "b", description: "B", quantity: 1, gross: 6 },
  ], 1);
  assert.deepEqual(parts.map((part) => part[0]?.supply), [5, 5]);
  assert.equal(parts.flat().reduce((sum, line) => sum + line.supply, 0), 10);
});
