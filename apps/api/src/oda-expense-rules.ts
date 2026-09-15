import { createHash } from 'node:crypto';
import type { StateRepository } from '@ofd/db';
import { DomainError, normalizeOdaExpenseDescription, ODA_EXPENSE_CATEGORIES, type Actor } from '@ofd/domain';
import { audit } from './events.ts';

type Rule = { id: string; description: string; category: string; updatedAt: string };
export type ExpenseRules = { version: number; rules: Rule[] };
type Record = ExpenseRules & { id: string; storeId: string; updatedBy: string };
const identity = (storeId: string) => createHash('sha256').update(JSON.stringify(['oda-expense-rules', storeId])).digest('hex');
export const expenseRulesLock = (storeId: string) => `oda:expense-rules:${identity(storeId)}`;
export async function getExpenseRules(repository: StateRepository, storeId: string): Promise<ExpenseRules> {
  const record = await repository.get<Record>('oda_expense_rules', identity(storeId));
  return { version: record?.version ?? 0, rules: record?.rules ?? [] };
}
export function requireExpenseRulesVersion(actual: number, expected: number) {
  if (actual !== expected) throw new DomainError('ODA_RULES_VERSION_CONFLICT', '기억한 분류가 변경되었습니다. 분류 목록 또는 파일 미리보기를 새로고침해 주세요.', 409);
}
/** Called inside the monthly transaction when remembering a batch classification. */
export async function changeExpenseRules(repository: StateRepository, actor: Actor, storeId: string, expectedVersion: number,
  input: { descriptions: string[]; category: string } | { removeId: string }): Promise<ExpenseRules> {
  return repository.exclusiveTransaction(expenseRulesLock(storeId), async tx => {
    const before = await getExpenseRules(tx, storeId);
    requireExpenseRulesVersion(before.version, expectedVersion);
    const rules = new Map(before.rules.map(rule => [rule.id, rule]));
    if ('removeId' in input) {
      if (!rules.delete(input.removeId)) throw new DomainError('ODA_RULE_NOT_FOUND', '기억한 분류를 찾지 못했습니다.', 404);
    } else {
      if (!ODA_EXPENSE_CATEGORIES.some(item => item.value === input.category)) throw new DomainError('ODA_RULE_CATEGORY', '운영비 분류를 선택해 주세요.', 422);
      for (const description of input.descriptions) {
        const normalized = normalizeOdaExpenseDescription(description);
        if (normalized.length < 2 || normalized.length > 500 || /^(비용|기타|거래|expense)$/u.test(normalized))
          throw new DomainError('ODA_RULE_DESCRIPTION', '거래를 구별할 수 있는 구체적인 내용만 기억할 수 있습니다. 비용 상세에서 내용을 확인해 주세요.', 422);
        const id = createHash('sha256').update(JSON.stringify([storeId, normalized])).digest('hex');
        const existing = rules.get(id);
        if (existing?.category === input.category) continue;
        rules.set(id, { id, description: description.trim(), category: input.category, updatedAt: new Date().toISOString() });
      }
      if (rules.size > 500) throw new DomainError('ODA_RULE_LIMIT', '매장별 분류 기억은 최대 500개입니다. 사용하지 않는 항목을 지워 주세요.', 422);
    }
    const next = [...rules.values()];
    if (JSON.stringify(next) === JSON.stringify(before.rules)) return before;
    const value: Record = { id: identity(storeId), storeId, version: before.version + 1, rules: next, updatedBy: actor.id };
    await tx.commit({ changes: [{ type: 'oda_expense_rules', id: value.id, storeId, expectedVersion: before.version || null, value }],
      audits: [audit(actor, 'oda_expense_rules', value.id, 'removeId' in input ? 'ODA 비용 분류 기억 해제' : 'ODA 비용 분류 기억', storeId, before, { version: value.version, rules: next })] });
    return { version: value.version, rules: next };
  });
}
