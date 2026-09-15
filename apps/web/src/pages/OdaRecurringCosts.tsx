import { useEffect, useState } from 'react';
import { getOdaRecurringPreview, type OdaRecurringPreview, type OdaRecurringSelection } from '../api/oda-client';
import { Button } from '../components/ui';

const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const labels: Record<string, string> = { rent: '임차료', labor: '인건비', utilities: '관리비·공과금' };
const PAGE_SIZE = 20;
export function OdaRecurringCosts({ storeId, month, version, disabled, onImport }: {
  storeId: string; month: string; version: number; disabled: boolean; onImport: (selection: OdaRecurringSelection) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<OdaRecurringPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null); setSelected([]); setError(''); setPage(1);
    void getOdaRecurringPreview(storeId, month, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setResult(value); setSelected(value.rows.filter(row => row.status === 'available').map(row => row.lineId));
    }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '지난달 비용을 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [open, storeId, month, version, retry]);
  const rows = result?.rows ?? [];
  const selectedSet = new Set(selected);
  const chosen = rows.filter(row => selectedSet.has(row.lineId));
  const selectedTotal = chosen.reduce((total, row) => total + row.amount, 0);
  const locked = disabled || saving;
  async function save() {
    if (locked || !result || !chosen.length || result.previousVersion === null) return;
    setSaving(true);
    try {
      if (await onImport({ expectedVersion: result.targetVersion, previousVersion: result.previousVersion,
        lineIds: selected, confirmedSimilarLineIds: chosen.filter(row => row.status === 'similar').map(row => row.lineId) })) setOpen(false);
      else setError('가져오지 못했습니다. 최신 비용 목록을 다시 확인해 주세요.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '비용을 가져오지 못했습니다.'); }
    finally { setSaving(false); }
  }
  return <div className="oda-recurring">
    <Button variant="secondary" disabled={locked} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '지난달 비용 닫기' : '지난달 비용 미리보기'}</Button>
    {open && <div className="oda-recurring-panel" aria-label="지난달 반복 비용 선택">
      <p>임차료·인건비·관리비 중 빠진 항목을 선택하세요. <strong>확인 대기로 추가되며, 실제 금액·귀속일·당월 증빙을 확인하기 전에는 손익에 포함하지 않습니다.</strong></p>
      {error && <p className="oda-error" role="alert">{error}</p>}
      <Button variant="ghost" disabled={locked} onClick={() => setRetry(value => value + 1)}>비용 목록 다시 불러오기</Button>
      {!result && !error && <p role="status">지난달 비용을 비교하고 있습니다…</p>}
      {result && (result.status !== 'available' ? <p className="oda-mini-note">{result.previousMonth} 정산이 {result.status === 'missing' ? '아직 등록되지 않았습니다.' : '아직 확정되지 않았습니다.'} 지난달 정산을 먼저 확인하거나 필요한 비용을 직접 추가하세요.</p>
        : !rows.length ? <p className="oda-mini-note">{result.previousMonth} 확정본에 가져올 임차료·인건비·관리비가 없습니다.</p> : <>
          <div className="oda-recurring-tools"><span>{result.previousMonth} 확정본 · {rows.length}건 · 금액은 전월 부가세 포함 총액</span>
            <Button variant="ghost" disabled={locked} onClick={() => setSelected(rows.filter(row => row.status === 'available').map(row => row.lineId))}>중복 표시 없는 항목 선택</Button>
            <Button variant="ghost" disabled={locked} onClick={() => setSelected([])}>선택 해제</Button></div>
          {rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row => <article className={`oda-recurring-row ${row.status}`} key={row.lineId}>
            <label><input type="checkbox" aria-label={`${row.description} 가져오기`} checked={selectedSet.has(row.lineId)} disabled={locked || row.status === 'already_added'}
              onChange={event => setSelected(value => event.target.checked ? [...value, row.lineId] : value.filter(id => id !== row.lineId))} />
              <span><strong>{row.description}</strong><small>{labels[row.category] || row.category} · {row.previousDate}</small></span><b>{money(row.amount)}</b></label>
            {row.status === 'already_added' && <p>이미 가져온 항목 · 제외 처리한 제안도 다시 추가하지 않습니다.</p>}
            {row.status === 'similar' && <div className="oda-recurring-match"><p>이번 달에 비슷한 비용 {row.matchCount}건이 있습니다. 아래 내역과 별도 비용일 때만 선택하세요.</p>
              <ul>{row.matches.map(match => <li key={match.lineId}>{match.date} · {match.description} · {money(match.amount)}</li>)}</ul>
              {row.matchCount > row.matches.length && <p>나머지 {row.matchCount - row.matches.length}건은 거래 내역에서 확인하세요.</p>}</div>}
          </article>)}
          {rows.length > PAGE_SIZE && <div className="oda-recurring-tools"><Button variant="ghost" disabled={locked || page === 1} onClick={() => setPage(value => value - 1)}>이전 비용</Button><span>{page} / {Math.ceil(rows.length / PAGE_SIZE)}</span><Button variant="ghost" disabled={locked || page * PAGE_SIZE >= rows.length} onClick={() => setPage(value => value + 1)}>다음 비용</Button></div>}
          <div className="oda-recurring-tools"><span>선택 {chosen.length}건 · 참고 금액 {money(selectedTotal)}{chosen.some(row => row.status === 'similar') ? ' · 비슷한 비용 확인 후 선택한 항목 포함' : ''}</span>
            <Button disabled={locked || !chosen.length || Boolean(error)} onClick={() => void save()}>{saving ? '가져오는 중…' : `선택한 ${chosen.length}건 확인 대기로 가져오기`}</Button></div>
        </>)}
    </div>}
  </div>;
}
