import type { OdaOverviewMonth, StateRepository } from '@ofd/db';
import { createOdaMonth, DomainError, type Store } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { monthSummary } from './oda-routes.ts';

const querySchema = z.object({ month: z.string().regex(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/),
  page: z.coerce.number().int().min(1).max(100000).default(1) }).strict();
const pageSize = 20;

export function registerOdaOverview(app: FastifyInstance, repository: StateRepository) {
  app.get('/api/v2/oda/overview', async request => {
    const actor = request.actor;
    if (!actor?.active || !['hq_master', 'hq_finance', 'store_owner', 'auditor'].includes(actor.role))
      throw new DomainError('ODA_FORBIDDEN', '정산 현황을 볼 권한이 없습니다.', 403);
    const { month, page } = querySchema.parse(request.query);
    const scope = actor.role === 'store_owner' || actor.storeIds.length ? actor.storeIds : undefined;
    const stores = (await repository.list<Store>('store', scope)).filter(store => store.active)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));
    const selected = stores.slice((page - 1) * pageSize, page * pageSize);
    const records = new Map((await repository.listOdaOverviewMonths(month, selected.map(store => store.id))).map(record => [record.storeId, record]));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const rows = selected.map(store => overviewRow(store, month, records.get(store.id), today));
    return { month, page, pageSize, total: stores.length, rows };
  });
}

function overviewRow(store: Store, month: string, record: OdaOverviewMonth | undefined, today: string) {
  const row = { storeId: store.id, storeName: store.name, month, updatedAt: record?.updatedAt ?? null,
    amountBasis: record?.status !== 'draft' && record ? '확정본 기준' : record?.policy.vatBasis === 'net' ? '부가세 제외' : record?.policy.vatBasis === 'gross' ? '부가세 포함' : '부가세 기준 미정 · 잠정금액' };
  if (!record || (record.status === 'draft' && !record.lines.length && !record.sources.length)) return { ...row, status: 'not_started',
    revenue: null, expenses: null, profit: null, payableB: null, sourceCount: 0, reviewCount: 0, blockerCount: 0,
    overdue: false, dueDate: null, nextAction: '자료 넣기', tab: 'transactions', anchor: '' };
  try {
    const closed = record.status !== 'draft';
    // Closed figures must come from the same preserved confirmation as the exported statement.
    const summary = closed ? record.frozenSummary : monthSummary({ ...createOdaMonth(store.id, month), ...record });
    if (!summary) throw new Error('Missing confirmation');
    const reviewCount = new Set(summary.blockers.filter(issue => issue.lineId).map(issue => issue.lineId)).size;
    const status = closed ? record.status : summary.canFinalize ? 'ready' : 'draft';
    const dueDate = status === 'paid' ? null : status === 'finalized' ? summary.paymentDueDate : summary.statementDueDate;
    const nextAction = status === 'paid' ? '지급 내역 보기' : status === 'finalized' ? '지급 기록하기'
      : status === 'ready' ? '정산 확정하기' : reviewCount ? '확인할 거래 보기'
      : summary.blockers.some(issue => ['sales_source_missing', 'lines_missing'].includes(issue.code)) ? '누락 자료 넣기'
      : summary.blockers.some(issue => issue.code !== 'month_not_ended') ? '정산 기준 확인' : '월 마감 준비';
    return { ...row, status, revenue: summary.revenue, expenses: summary.expenses, profit: summary.profit,
      payableB: summary.payableB, sourceCount: record.sources.length, reviewCount: closed ? 0 : reviewCount,
      blockerCount: closed ? 0 : summary.blockers.length, dueDate, overdue: Boolean(dueDate && today > dueDate), nextAction,
      tab: !closed && (reviewCount || nextAction === '누락 자료 넣기') ? 'transactions' : nextAction === '정산 기준 확인' ? 'policy' : 'overview',
      anchor: closed || status === 'ready' ? 'oda-payment' : '' };
  } catch {
    return { ...row, status: 'error', revenue: null, expenses: null, profit: null, payableB: null,
      sourceCount: record.sources.length, reviewCount: 0, blockerCount: 0, overdue: false, dueDate: null,
      nextAction: '정산 자료 점검', tab: 'overview', anchor: '' };
  }
}
