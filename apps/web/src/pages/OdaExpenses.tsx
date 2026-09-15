import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../components/ui';
import { ArrowDownToLine, Check, FileCheck2, Plus, Search } from '../components/icons';
import { odaUrl, type OdaLine, type OdaResponse } from '../api/oda-client';

export const expenseCategories = [
  { value: 'ingredients', label: '식재료비' }, { value: 'labor', label: '인건비' },
  { value: 'rent', label: '임차료' }, { value: 'utilities', label: '관리비·공과금' },
  { value: 'fees', label: '수수료' }, { value: 'marketing', label: '마케팅비' },
  { value: 'supplies', label: '소모품비' }, { value: 'other', label: '기타 운영비' },
];
type Filter = 'all' | 'review' | 'source' | 'category' | 'vat' | 'excluded';
type Props = {
  state: OdaResponse; storeId: string; month: string; editable: boolean; busy: boolean;
  onBatch: (lineIds: string[], changes: Record<string, unknown>, version: number) => Promise<boolean>;
  onUpload: () => void; onAdd: (sourceId?: string) => void;
  renderLine: (line: OdaLine) => ReactNode; manual: ReactNode; recurring: ReactNode;
};
const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;

export function OdaExpenses({ state, storeId, month, editable, busy, onBatch, onUpload, onAdd, renderLine, manual, recurring }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchCategory, setBatchCategory] = useState('');
  const [batchSource, setBatchSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const disabled = !editable || busy || saving || failed;
  useEffect(() => { setSelected([]); setBatchSource(''); setBatchCategory(''); setFailed(false); }, [state, storeId, month]);
  useEffect(() => { setPage(0); setSelected([]); }, [filter, search, category]);
  const sources = useMemo(() => new Map(state.data.sources.map(source => [source.id, source])), [state.data.sources]);
  const issues = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const issue of state.summary.blockers) if (issue.lineId) result.set(issue.lineId, [...(result.get(issue.lineId) ?? []), issue.code]);
    return result;
  }, [state.summary.blockers]);
  const expenses = state.data.lines.filter(line => line.kind === 'expense');
  const excluded = state.data.lines.filter(line => line.kind === 'excluded');
  const missingSource = (line: OdaLine) => !sources.has(line.sourceId);
  const missingCategory = (line: OdaLine) => !expenseCategories.some(item => item.value === line.category);
  const needsReview = (line: OdaLine) => !line.reviewed || missingSource(line) || Boolean(issues.get(line.id)?.length);
  const counts = { all: expenses.length, review: expenses.filter(needsReview).length,
    source: expenses.filter(missingSource).length, category: expenses.filter(missingCategory).length,
    vat: expenses.filter(line => line.vat === null).length, excluded: excluded.length };
  const filtered = (filter === 'excluded' ? excluded : expenses).filter(line =>
    (filter !== 'review' || needsReview(line)) && (filter !== 'source' || missingSource(line)) &&
    (filter !== 'category' || missingCategory(line)) && (filter !== 'vat' || line.vat === null) &&
    (!category || line.category === category) && (!search || `${line.description} ${line.note} ${sources.get(line.sourceId)?.fileName ?? ''}`.toLowerCase().includes(search.toLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const selectedSet = new Set(selected);
  const selectedLines = expenses.filter(line => selectedSet.has(line.id));
  const ready = selectedLines.length > 0 && selectedLines.every(line => !missingSource(line) && !missingCategory(line) &&
    !(state.data.policy.vatBasis === 'net' && line.vat === null) && !(issues.get(line.id) ?? []).some(code => code !== 'line_unreviewed'));
  const canAttach = batchSource && selectedLines.every(line => !line.sourceId || line.sourceId === batchSource);
  const linked = new Set(state.data.lines.flatMap(line => [line.sourceId, line.approvalSourceId ?? '']));
  const unattached = state.data.sources.filter(source => (source.kind === 'expense' || source.kind === 'evidence') && !linked.has(source.id));
  const pending = expenses.filter(line => line.externalId.startsWith('repeat:') && !line.reviewed);
  async function save(changes: Record<string, unknown>) {
    if (disabled || !selected.length) return;
    setSaving(true);
    try { if (await onBatch(selected, changes, state.version)) setSelected([]); else setFailed(true); }
    finally { setSaving(false); }
  }
  return <section className="oda-stack oda-expenses" aria-label="매장 비용 관리">
    <section className="oda-card">
      <div className="oda-card-head"><div><h2>이번 달 비용을 한곳에서</h2><p>비용 추가 → 증빙 연결 → 확인. 저장한 내역은 월 정산에 함께 반영됩니다.</p></div>
        <div className="oda-inline-tools">{editable && <><Button variant="secondary" disabled={busy || saving} onClick={onUpload}><FileCheck2 size={16} /> 파일·영수증 넣기</Button><Button disabled={busy || saving} onClick={() => onAdd()}><Plus size={16} /> 비용 직접 추가</Button></>}</div></div>
      <div className="oda-expense-stats" aria-label="비용 준비 현황">
        <div><small>손익 반영 운영비</small><strong>{expenses.length ? won(state.summary.expenses) : '—'}</strong><span>{state.data.policy.vatBasis === 'net' ? '입력된 부가세 제외' : state.data.policy.vatBasis === 'gross' ? '부가세 포함' : '부가세 기준 확인 전'} · {state.data.status === 'draft' ? '잠정 금액' : '확정 금액'}</span></div>
        <button onClick={() => setFilter('review')}><small>확인할 비용</small><strong>{counts.review}<em>건</em></strong><span>금액·분류·증빙 확인</span></button>
        <button onClick={() => setFilter('source')}><small>증빙 미연결</small><strong>{counts.source}<em>건</em></strong><span>빠진 증빙부터 연결하세요</span></button>
        <button onClick={() => setFilter('vat')}><small>부가세 미입력</small><strong>{counts.vat}<em>건</em></strong><span>모르는 금액은 0원과 구별</span></button>
      </div>
      {pending.length > 0 && <p className="oda-pnl-note">지난달에서 가져온 미확인 비용 {pending.length}건 · {won(pending.reduce((sum, line) => sum + line.amount, 0))}은 확인 전까지 손익에서 제외됩니다.</p>}
      {manual}
    </section>
    <section className="oda-card">
      <div className="oda-card-head"><div><h2>비용 목록</h2><p>목록 금액은 부가세 포함 원본 금액입니다. 상세에서 금액·메모·증빙을 확인하세요.</p></div><span className="oda-badge">운영비 {expenses.length}건</span></div>
      <div className="oda-filterbar"><div className="oda-filters">{([{ value: 'all', label: '전체 비용' }, { value: 'review', label: '확인 필요' }, { value: 'source', label: '증빙 미연결' }, { value: 'category', label: '분류 필요' }, { value: 'vat', label: '부가세 미입력' }, { value: 'excluded', label: '손익 제외' }] as const).map(item => <button key={item.value} aria-pressed={filter === item.value} className={filter === item.value ? 'active' : ''} onClick={() => setFilter(item.value)}>{item.label} {counts[item.value]}</button>)}</div>
        <div className="oda-expense-search"><label className="oda-search"><Search size={16} /><input aria-label="비용 검색" placeholder="거래 내용·메모·증빙 파일명" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="비용 분류 필터" value={category} onChange={e => setCategory(e.target.value)}><option value="">모든 분류</option>{expenseCategories.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div></div>
      {editable && filter !== 'excluded' && expenses.length > 0 && <div className="oda-expense-batch">
        <div className="oda-inline-tools"><Button variant="secondary" disabled={disabled || !visible.length} onClick={() => setSelected([...new Set([...selected, ...visible.map(line => line.id)])].slice(0, 200))}>현재 페이지 선택</Button><Button variant="secondary" disabled={!selected.length || busy || saving} onClick={() => setSelected([])}>선택 해제</Button><span aria-live="polite">선택 {selected.length}건 · {won(selectedLines.reduce((sum, line) => sum + line.amount, 0))}</span></div>
        {selected.length > 0 && <><div className="oda-expense-batch-actions"><label className="oda-field">선택 비용 분류<select value={batchCategory} disabled={disabled} onChange={e => setBatchCategory(e.target.value)}><option value="">분류 선택</option>{expenseCategories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><Button variant="secondary" disabled={disabled || !batchCategory} onClick={() => void save({ category: batchCategory })}>분류 일괄 적용</Button><label className="oda-field">선택 비용에 연결할 증빙<select value={batchSource} disabled={disabled} onChange={e => setBatchSource(e.target.value)}><option value="">이번 달 증빙 선택</option>{state.data.sources.filter(source => source.kind === 'expense' || source.kind === 'evidence').map(source => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label><Button variant="secondary" disabled={disabled || !canAttach} onClick={() => void save({ sourceId: batchSource })}>증빙 일괄 연결</Button><Button disabled={disabled || !ready} onClick={() => void save({ reviewed: true })}><Check size={16} /> 선택 {selected.length}건 확인 완료</Button></div><p className="oda-mini-note">선택한 거래가 같은 증빙에 있는지 확인 후 연결하세요. 기존 원본 연결은 유지됩니다. 증빙·분류 등 필수 항목을 갖춘 비용만 한 번에 확인할 수 있습니다. 한 번에 최대 200건입니다.</p></>}
        {failed && <p role="alert">저장하지 못했습니다. 상단의 정산 새로고침으로 최신 내역을 불러온 뒤 다시 선택해 주세요.</p>}
      </div>}
      {visible.map(line => <div key={`${line.id}:${state.version}`} className="oda-expense-item">{editable && line.kind === 'expense' && <label className="oda-expense-select"><input type="checkbox" aria-label={`${line.description} 선택`} disabled={disabled || selected.length >= 200 && !selectedSet.has(line.id)} checked={selectedSet.has(line.id)} onChange={e => setSelected(e.target.checked ? [...selected, line.id] : selected.filter(id => id !== line.id))} /></label>}<div>{renderLine(line)}<div className="oda-expense-source">{sources.has(line.sourceId) ? <a href={odaUrl(storeId, month, `/evidence/${encodeURIComponent(line.sourceId)}`)}><FileCheck2 size={14} /> {sources.get(line.sourceId)!.fileName}{line.sourceRow > 0 ? ` · ${line.sourceRow}행` : ''}</a> : <span className="oda-expense-missing">증빙 미연결</span>}{line.vat === null && <span>부가세 미입력</span>}{line.externalId.startsWith('repeat:') && !line.reviewed && line.kind === 'expense' && <span>반복 비용 확인 대기</span>}</div></div></div>)}
      {!visible.length && <div className="oda-empty"><FileCheck2 /><strong>{expenses.length || excluded.length ? '조건에 맞는 비용이 없습니다' : '첫 비용을 추가해 보세요'}</strong><p>{expenses.length || excluded.length ? '검색어나 분류를 바꾸면 다른 비용을 볼 수 있습니다.' : '비용 파일을 넣거나 금액을 직접 입력하고 영수증을 연결하세요.'}</p></div>}
      {filtered.length > 50 && <div className="oda-policy-footer"><p>{filtered.length}건 · {currentPage + 1} / {pages}페이지</p><div className="oda-inline-tools"><Button variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전 비용</Button><Button variant="secondary" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>다음 비용</Button></div></div>}
    </section>
    {unattached.length > 0 && <section className="oda-card"><div className="oda-card-head"><div><h2>아직 거래에 연결하지 않은 자료</h2><p>기존 비용이면 목록에서 연결하고, 아직 없는 비용만 추가하세요.</p></div><span className="oda-badge">{unattached.length}개</span></div><div className="oda-evidence-list">{unattached.map(source => <div className="oda-evidence" key={source.id}><FileCheck2 size={20} /><div><strong>{source.fileName}</strong><small>{source.kind === 'evidence' ? '영수증·첨부 자료' : '비용 파일'} · 거래 미연결</small></div><a aria-label={`${source.fileName} 원본 다운로드`} href={odaUrl(storeId, month, `/evidence/${encodeURIComponent(source.id)}`)}><ArrowDownToLine size={18} /></a>{editable && <Button variant="secondary" disabled={busy || saving} onClick={() => onAdd(source.id)}>비용 추가</Button>}</div>)}</div></section>}
    {recurring}
    <section className="oda-card"><div className="oda-card-head"><div><h2>세무사 전달 자료 준비</h2><p>비용대장·손익 제외 내역·증빙목록과 원본 파일을 함께 받습니다. 미확인 항목도 표시됩니다.</p></div><a className="button button-secondary" href={odaUrl(storeId, month, '/expenses/export.zip')}><ArrowDownToLine size={16} /> 비용·증빙 묶음 받기</a></div><p className="oda-pnl-note">{state.data.status === 'draft' ? '정산 준비 중인 자료입니다. 확정 전 금액은 달라질 수 있습니다. ' : ''}내려받은 자료를 검토한 뒤 직접 전달하세요. 영수증 보관 여부와 세무상 비용 인정은 구별해 확인합니다.</p></section>
  </section>;
}
