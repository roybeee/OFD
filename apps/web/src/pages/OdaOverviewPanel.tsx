import { useEffect, useState } from 'react';
import { getOdaOverview, type OdaOverview } from '../api/oda-client';
import { Button } from '../components/ui';
import { odaMasterSettlementPath } from '../lib/oda-navigation';

const labels = { not_started: '자료 미등록', draft: '확인 필요', ready: '확정 가능', finalized: '지급 대기', paid: '지급 완료', error: '자료 점검 필요' };
const amount = (value: number | null) => value === null ? '—' : `${value.toLocaleString('ko-KR')}원`;
export function previousOdaMonth(date: string) {
  const parsed = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf())) return '';
  parsed.setUTCMonth(parsed.getUTCMonth() - 1);
  return parsed.toISOString().slice(0, 7);
}

export function OdaOverviewPanel({ operationalDate, onNavigate }: { operationalDate?: string; onNavigate: (path: string) => void }) {
  const today = operationalDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const [month, setMonth] = useState(previousOdaMonth(today));
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<OdaOverview | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError('');
    if (!/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(month)) { setError('정산월을 선택해 주세요.'); return () => controller.abort(); }
    void getOdaOverview(month, page, controller.signal).then(value => { if (!controller.signal.aborted) {
      const lastPage = Math.max(1, Math.ceil(value.total / value.pageSize));
      if (page > lastPage) setPage(lastPage); else setResult(value);
    } })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '정산 현황을 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [month, page, retry]);
  return <section className="oda-overview" aria-labelledby="oda-overview-title">
    <div className="oda-master-section-heading"><div><h2 id="oda-overview-title">매장별 월 정산 현황</h2><p>지난달 정산부터 확인합니다. 금액은 현재 입력된 자료 기준이며, 확정 후에는 보관된 정산서 기준입니다.</p></div>
      <label className="oda-overview-month">정산월<input type="month" value={month} onChange={event => { setMonth(event.target.value); setPage(1); }} /></label></div>
    {error ? <div className="oda-master-error" role="alert">{error}<Button variant="secondary" onClick={() => setRetry(value => value + 1)}>현황 다시 불러오기</Button></div>
      : !result ? <p role="status">정산 현황을 불러옵니다.</p> : <>
        <div className="oda-overview-tools"><p>{month} · 매장 {result.total}개{result.total > result.pageSize ? ` · ${page}페이지` : ''}</p><Button variant="ghost" onClick={() => setRetry(value => value + 1)}>현황 새로고침</Button></div>
        {!result.rows.length ? <p className="oda-master-empty">표시할 매장이 없습니다. 매장 관리에서 작업공간을 추가해 주세요.</p>
          : <div className="oda-overview-list">{result.rows.map(row => <article className="oda-overview-row" key={row.storeId}>
            <div className="oda-overview-store"><h3>{row.storeName}</h3><span className={`oda-overview-status ${row.status}`}>{labels[row.status]}</span>
              {row.dueDate && <p className={row.overdue ? 'oda-overview-overdue' : ''}>{row.status === 'finalized' ? '지급' : '정산'} 기한 {row.dueDate}{row.overdue ? ' · 기한 지남' : ''}</p>}</div>
            <div><p className="oda-overview-basis">{row.status !== 'not_started' && row.status !== 'error' ? row.amountBasis : '자료 등록 후 금액 표시'}</p><dl className="oda-overview-amounts"><div><dt>매출</dt><dd>{amount(row.revenue)}</dd></div><div><dt>운영비</dt><dd>{amount(row.expenses)}</dd></div><div><dt>영업이익</dt><dd>{amount(row.profit)}</dd></div><div><dt>{row.status === 'draft' || row.status === 'ready' ? 'B 예상 지급액' : 'B 지급액'}</dt><dd>{row.status === 'not_started' || row.status === 'error' ? '—' : row.payableB === null ? '합의 확인 필요' : amount(row.payableB)}</dd></div></dl></div>
            <div className="oda-overview-action"><p>자료 {row.sourceCount}개{row.reviewCount > 0 ? ` · 확인할 거래 ${row.reviewCount}건` : row.blockerCount > 0 ? ` · 확인 항목 ${row.blockerCount}개` : ''}</p>
              <Button variant={row.status === 'paid' ? 'secondary' : 'primary'} onClick={() => onNavigate(odaMasterSettlementPath(row.storeId, row.tab, row.anchor, month))}>{row.nextAction}</Button></div>
          </article>)}</div>}
        {result.total > result.pageSize && <div className="oda-overview-pagination"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(value => value - 1)}>이전 매장</Button><span>{page} / {Math.ceil(result.total / result.pageSize)}</span><Button variant="secondary" disabled={page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>다음 매장</Button></div>}
      </>}
  </section>;
}
