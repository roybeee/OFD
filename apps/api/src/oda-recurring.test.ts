import { expect, it } from 'vitest';
import { createOdaMonth, type OdaLine } from '@ofd/domain';
import { previousSettlementMonth, recurringCandidates } from './oda-recurring.ts';

const line = (id: string, extra: Partial<OdaLine> = {}): OdaLine => ({ id, kind: 'expense', date: '2026-08-31', description: '8월 임차료',
  amount: 1100000, vat: 100000, category: 'rent', channel: 'manual', sourceId: 'prior', sourceRow: 0, externalId: '', reviewed: true, note: '', ...extra });
it('only proposes reviewed positive recurring costs and never re-adds dismissed proposals', () => {
  const prior = createOdaMonth('store', '2026-08'); const current = createOdaMonth('store', '2026-09');
  prior.lines = [line('rent'), line('labor', { category: '급여' }), line('utility', { category: '관리비' }),
    line('refund', { amount: -1000, vat: 0 }), line('ingredient', { category: 'ingredients' }), line('unreviewed', { reviewed: false })];
  current.lines = [line('dismissed', { kind: 'excluded', externalId: 'repeat:2026-08:rent' })];
  expect(recurringCandidates(prior, current).map(row => [row.lineId, row.status])).toEqual([
    ['rent', 'already_added'], ['labor', 'available'], ['utility', 'available'],
  ]);
  expect(previousSettlementMonth('2026-01')).toBe('2025-12');
});
it('warns on same category with either month-normalized description or amount, and bounds matching detail', () => {
  const prior = createOdaMonth('store', '2026-08'); const current = createOdaMonth('store', '2026-09');
  prior.lines = [line('rent')];
  current.lines = Array.from({ length: 100 }, (_, index) => line(`current-${index}`, { date: '2026-09-01', description: '9월 임차료' }));
  const [candidate] = recurringCandidates(prior, current);
  expect(candidate).toMatchObject({ status: 'similar', matchCount: 100 });
  expect(candidate!.matches).toHaveLength(3);
  current.lines = [line('description-match', { description: '9월 임차료', amount: 1200000 }), line('amount-match', { description: '다른 내용' }),
    line('other-category', { category: 'labor' }), line('excluded', { kind: 'excluded' })];
  expect(recurringCandidates(prior, current)[0]!.matchCount).toBe(2);
});
