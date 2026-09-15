import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOdaCsv, normalizeOdaExpenseDescription } from './oda-settlement.ts';
const rules = { version: 3, rules: [{ id: 'shop-rule', description: 'ABC 매장', category: 'supplies' }] };
const parse = (body: string, expenseRules = rules) => parseOdaCsv('date,description,amount,vat,category,kind,feeAmount,payoutAmount\n'+body,
  { sourceId: 'source', kind: 'expense', month: '2026-09', expenseRules });
test('remembers exact normalized descriptions and preserves original amounts, text, VAT and review work', () => {
  const result = parse('2026-09-01,ＡＢＣ  매장,11000,1000,,expense,,');
  assert.equal(normalizeOdaExpenseDescription(' ＡＢＣ  매장 '), 'abc 매장');
  assert.equal(result.errors.length, 0); assert.equal(result.lines[0]?.category, 'supplies');
  assert.equal(result.lines[0]?.description, 'ＡＢＣ  매장'); assert.equal(result.lines[0]?.amount, 11000); assert.equal(result.lines[0]?.vat, 1000);
  assert.equal(result.lines[0]?.reviewed, false); assert.deepEqual(result.lines[0]?.categoryRule, { id: 'shop-rule', version: 3, description: 'ABC 매장', category: 'supplies' });
  assert.equal(result.warnings.at(-1)?.code, 'expense_rule_applied');
});
test('never applies substrings or replaces source classification including unknown source categories', () => {
  const result = parse('2026-09-01,ABC 매장,11000,1000,labor,expense,,\n2026-09-02,ABC 매장 2호,11000,1000,,expense,,\n2026-09-03,ABC 매장,11000,1000,기타코드999,expense,,');
  assert.deepEqual(result.lines.map(line => line.categoryRule), [undefined, undefined, undefined]);
  assert.equal(result.lines[0]?.category, 'labor'); assert.equal(result.lines[2]?.category, 'uncategorized');
});
test('contract exclusions and bank/revenue rows take precedence over remembered categories', () => {
  const set = { version: 1, rules: ['감가상각비', 'A 선공제', '시설 투자', 'ABC 매장'].map(description => ({ id: description, description, category: 'supplies' })) };
  const result = parse('2026-09-01,감가상각비,10000,0,,expense,,\n2026-09-02,A 선공제,3000000,0,,expense,,\n2026-09-03,시설 투자,1100000,100000,,expense,,\n2026-09-04,ABC 매장,11000,1000,,revenue,,\n2026-09-05,ABC 매장,-11000,0,,bank,,', set);
  assert.equal(result.lines.length, 5); assert.ok(result.lines.every(line => !line.categoryRule));
});
test('invalid remembered categories cannot override expenses and derived fee/payout rows do not inherit a rule', () => {
  assert.equal(parse('2026-09-01,ABC 매장,10000,0,,expense,,', { version: 1, rules: [{ ...rules.rules[0]!, category: 'capex' }] }).lines[0]?.categoryRule, undefined);
  const result = parse('2026-09-01,ABC 매장,10000,0,,expense,100,9900');
  assert.ok(result.lines[0]?.categoryRule); assert.equal(result.lines[1]?.categoryRule, undefined); assert.equal(result.lines[2]?.categoryRule, undefined);
});
