import { useCallback, useEffect, useState } from 'react';
import { searchAuditV2, type AuditRow } from '../api/client';
import { Button } from '../components/ui';
import { seoulShortDateTime } from '../lib/datetime';
import type { BootstrapData, Toast } from '../types';

const ROLE_LABEL: Record<string, string> = {
  hq_master: '마스터', hq_finance: '재무', hq_ops: '운영', auditor: '감사', driver: '기사',
  store_owner: '점주', store_staff: '매장', system: '시스템',
};
const formatKst = seoulShortDateTime;

/** V1 감사 로그 화면 이식 — 해시체인 원장은 서버에 있고, 여기서는 검색·열람만 한다 */
export function HqAuditPage({ data, notify }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [filters, setFilters] = useState({ q: '', from: '', to: '', noSched: true, limit: 50 });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const search = useCallback(async (targetPage: number, current: typeof filters) => {
    setState('loading');
    try {
      const result = await searchAuditV2({
        ...(current.q.trim() ? { q: current.q.trim() } : {}),
        ...(current.from ? { from: current.from } : {}),
        ...(current.to ? { to: current.to } : {}),
        noSched: current.noSched, page: targetPage, limit: current.limit,
      });
      setRows(result.rows);
      setTotal(result.total);
      setPage(targetPage);
      setState('ready');
    } catch (cause) {
      setState('error');
      notify(cause instanceof Error ? cause.message : '감사 로그를 불러오지 못했습니다.', 'warning');
    }
  }, [notify]);

  useEffect(() => { void search(1, filters); /* 최초 1회 */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxPage = Math.max(Math.ceil(total / filters.limit), 1);
  const actorName = (id: string) => data.availableActors?.find((actor) => actor.id === id)?.name
    ?? (id === data.actor.id ? data.actor.name : id.slice(0, 8));
  const storeName = (id?: string) => id ? (data.stores.find((store) => store.id === id)?.name ?? id.slice(0, 8)) : '—';

  return (
    <section className="page" aria-labelledby="audit-heading">
      <header className="page-head">
        <div>
          <h1 id="audit-heading">감사 로그</h1>
          <p>모든 변경은 해시체인 원장에 남습니다 · 검색은 행위·대상·수행자·메타데이터를 함께 봅니다</p>
        </div>
      </header>

      <form className="panel audit-filter" aria-label="감사 로그 검색"
        onSubmit={(event) => { event.preventDefault(); void search(1, filters); }}>
        <div className="form-grid">
          <label>키워드<input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="예: 숙려, store.updated, 매장명" /></label>
          <label>시작일<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label>종료일<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
          <label className="inline-check"><input type="checkbox" checked={filters.noSched} onChange={(event) => setFilters({ ...filters, noSched: event.target.checked })} /> 시스템(스케줄러) 제외</label>
          <label>페이지 크기
            <select value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: Number(event.target.value) })}>
              <option value={50}>50</option><option value={100}>100</option><option value={200}>200</option>
            </select>
          </label>
          <Button type="submit" disabled={state === 'loading'}>{state === 'loading' ? '검색 중…' : '검색'}</Button>
        </div>
      </form>

      <div className="table-wrap">
        <table className="data-table compact" aria-label="감사 로그">
          <thead><tr>
            <th scope="col">시각(KST)</th><th scope="col">행위</th><th scope="col">대상</th>
            <th scope="col">수행자</th><th scope="col">매장</th><th scope="col">상세</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const detail = JSON.stringify(row.metadata);
              return (
                <tr key={row.id}>
                  <td className="num muted">{formatKst(row.occurredAt)}</td>
                  <td className="strong">{row.action}</td>
                  <td className="muted">{row.aggregateType}<small> · {row.aggregateId.slice(0, 8)}</small></td>
                  <td>{actorName(row.actorId)}<small className="muted"> · {ROLE_LABEL[row.actorRole] ?? row.actorRole}</small></td>
                  <td>{storeName(row.storeId)}</td>
                  <td className="muted" title={detail}>{detail.length > 60 ? `${detail.slice(0, 60)}…` : detail === '{}' ? '—' : detail}</td>
                </tr>
              );
            })}
            {state === 'ready' && rows.length === 0 && <tr><td colSpan={6} className="muted">조건에 맞는 기록이 없습니다.</td></tr>}
            {state === 'error' && <tr><td colSpan={6} className="muted">불러오지 못했습니다. 다시 검색해 주세요.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="pager" role="navigation" aria-label="감사 로그 페이지">
        <span className="muted">{total.toLocaleString('ko-KR')}건 · {page}/{maxPage} 페이지</span>
        <span className="row-actions">
          <Button type="button" variant="ghost" disabled={page <= 1 || state === 'loading'} onClick={() => void search(page - 1, filters)}>이전</Button>
          <Button type="button" variant="ghost" disabled={page >= maxPage || state === 'loading'} onClick={() => void search(page + 1, filters)}>다음</Button>
        </span>
      </div>
    </section>
  );
}
