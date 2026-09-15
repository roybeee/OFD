import { useCallback, useEffect, useRef, useState } from 'react';
import type { BootstrapData } from '../types';
import { Button } from '../components/ui';
import { AlertTriangle, ArrowDownToLine, ArrowRight, CalendarDays, Check, ChevronDown, CircleDollarSign, Clock3, FileCheck2, ImagePlus, Info, LockKeyhole, Plus, ReceiptText, RefreshCcw, Search, Send, ShieldCheck, X } from '../components/icons';
import { downloadOdaText, getOdaMonth, getOdaImportProfile, resetOdaImportProfile, odaMutation, odaUrl, prepareOdaFile, previewOdaImport } from '../api/oda-client';
import type { OdaImport, OdaImportProfile as ImportProfile, OdaLine, OdaPolicy, OdaPreview, OdaResponse, OdaSource, OdaSourceKind, OdaSummary } from '../api/oda-client';
import { OdaRecurringCosts } from './OdaRecurringCosts';
import { OdaExpenses, expenseCategories } from './OdaExpenses';
import '../oda.css';

type Props = { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void };
type Tab = 'overview' | 'expenses' | 'transactions' | 'policy' | 'history';
type Filter = 'review' | 'all' | 'revenue' | 'expense' | 'bank' | 'excluded';
type PendingFile = { id: string; input: OdaImport; preview: OdaPreview | null; error?: string };
const profileKey = (storeId: string, kind: string, channel: string) => `oda:import-profile:v1:${storeId}:${kind}:${channel}`;
function readImportProfile(key: string): ImportProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as ImportProfile | null;
    if (!value || !Number.isInteger(value.headerRow) || value.headerRow < 1 || value.headerRow > 100 || typeof value.sheetName !== 'string' || !Array.isArray(value.headers) || !value.headers.every((header) => typeof header === 'string') || !value.columnMap || typeof value.columnMap !== 'object' || !Object.values(value.columnMap).every((header) => typeof header === 'string')) return null;
    return value;
  } catch { return null; }
}
const categories = expenseCategories;
const exclusions = [{ value: 'capex', label: '시설·설비 투자비' }, { value: 'deposit', label: '보증금' }, { value: 'a_priority', label: 'A 우선배분금' }, { value: 'depreciation', label: '감가상각비' }, { value: 'b_distribution', label: 'B 배분금' }, { value: 'owner_transfer', label: '사업주 자금이체' }];
const channels = [{ value: 'pos', label: '매장 POS' }, { value: 'baemin', label: '배달의민족' }, { value: 'coupang', label: '쿠팡이츠' }, { value: 'yogiyo', label: '요기요' }];
const kinds: Record<string, string> = { revenue: '매출', expense: '비용', bank: '계좌 대사', excluded: '손익 제외', pos: '매장 POS', platform: '배달 플랫폼', evidence: '증빙' };
const categoryLabel = (value: string) => [...categories, ...exclusions].find((item) => item.value === value)?.label || (value === 'uncategorized' ? '분류 필요' : value || '분류 필요');
const channelLabel = (value: string) => channels.find((item) => item.value === value)?.label || value;
const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null) => value === null ? '확인 필요' : `${number(value)}원`;
const dateTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const statusLabel = (status: string) => status === 'paid' ? '지급 완료' : status === 'finalized' ? '정산 확정' : '정산 준비 중';
export function odaSettlementLocation(search: string, stores: ReadonlyArray<{ id: string }>) {
  const params = new URLSearchParams(search);
  const value = params.get('tab');
  const tab: Tab = value === 'expenses' || value === 'transactions' || value === 'policy' || value === 'history' ? value : 'overview';
  const storeId = params.get('store') ?? '';
  const month = params.get('month') ?? '';
  return { tab, storeId: stores.some(store => store.id === storeId) ? storeId : '',
    ...(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(month) ? { month } : {}) };
}

export function OdaSettlementPage({ data, notify }: Props) {
  const location = odaSettlementLocation(window.location.search, data.stores);
  const [storeId, setStoreId] = useState(location.storeId || data.store.id || data.stores[0]?.id || '');
  const [month, setMonth] = useState(location.month || (data.meta.operationalDate || today()).slice(0, 7));
  const [state, setState] = useState<OdaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [readingUpload, setReadingUpload] = useState(false);
  const [tab, setTab] = useState<Tab>(location.tab);
  const [filter, setFilter] = useState<Filter>('review');
  const [search, setSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(50);
  useEffect(() => { setVisibleLimit(50); }, [filter, search, storeId, month]);
  const [showManual, setShowManual] = useState(false);
  const [manualSource, setManualSource] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [policy, setPolicy] = useState<OdaPolicy | null>(null);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [paymentReference, setPaymentReference] = useState('');
  const version = useRef(0);
  const initialFocus = useRef(window.location.hash === '#oda-exports' || window.location.hash === '#oda-payment' ? window.location.hash.slice(1) : '');
  const context = useRef('');
  context.current = `${storeId}/${month}`;

  const accept = useCallback((response: OdaResponse) => {
    setState(response); version.current = response.version;
    setPolicy(response.data.policy); setError('');
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!storeId || !/^\d{4}-\d{2}$/.test(month)) { setLoading(false); return; }
    const requestedContext = `${storeId}/${month}`;
    setLoading(true); setError('');
    try { const response = await getOdaMonth(storeId, month, signal); if (context.current === requestedContext) accept(response); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError') && context.current === requestedContext) setError(e instanceof Error ? e.message : '정산 정보를 불러오지 못했습니다.'); }
    finally { if (!signal?.aborted && context.current === requestedContext) setLoading(false); }
  }, [storeId, month, accept]);
  useEffect(() => { const controller = new AbortController(); setState(null); setShowManual(false); setShowUpload(false); void load(controller.signal); return () => controller.abort(); }, [load, data.actor.id]);
  useEffect(() => {
    if (!state || !initialFocus.current) return;
    const element = document.getElementById(initialFocus.current);
    if (element) { element.scrollIntoView?.({ block: 'center' }); element.focus({ preventScroll: true }); initialFocus.current = ''; }
  }, [state]);

  async function mutate(action: string, body: Record<string, unknown> = {}, message = '저장했습니다.', expectedVersion = version.current) {
    if (busy) return false;
    const requestedContext = `${storeId}/${month}`;
    setBusy(action); setError('');
    try {
      const response = await odaMutation(storeId, month, action, expectedVersion, body);
      if (context.current === requestedContext) accept(response);
      notify(message, 'success'); return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : '변경사항을 저장하지 못했습니다.';
      setError(message); notify(message, 'warning'); return false;
    } finally { setBusy(''); }
  }
  async function importFiles(files: PendingFile[], onSaved?: (file: PendingFile) => void) {
    if (busy) return false;
    setBusy('import'); setShowUpload(true); setError('');
    const requestedContext = `${storeId}/${month}`;
    let added = 0;
    try {
      for (const file of files) {
        const response = await odaMutation(storeId, month, '/import', version.current, file.input);
        added += response.importResult?.added ?? 0;
        if (context.current === requestedContext) accept(response);
        onSaved?.(file);
      }
      notify(`자료 ${files.length}개를 저장했습니다.${added ? ` 거래 ${added}건이 반영되었습니다.` : ''}`, 'success');
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : '자료를 저장하지 못했습니다.';
      setError(message); notify(`${message} 앞서 저장된 파일은 유지됩니다.`, 'warning'); return false;
    } finally { setBusy(''); }
  }

  const summary = state?.summary;
  const locked = state?.data.status !== 'draft';
  const editable = Boolean(state?.capabilities.edit && !locked);
  const hasLines = Boolean(state?.data.lines.length);
  const reviewLines = state?.data.lines.filter((line) => !line.reviewed || summary?.blockers.some((issue) => issue.lineId === line.id)) ?? [];
  const lineIssues = summary?.blockers.filter((issue) => issue.lineId) ?? [];
  const policyIssues = summary?.blockers.filter((issue) => !issue.lineId) ?? [];
  const filtered = state?.data.lines.filter((line) => (filter === 'all' || filter === 'review' ? filter === 'all' || reviewLines.some((item) => item.id === line.id) : line.kind === filter) && (!search || `${line.description} ${line.category} ${line.channel} ${line.externalId}`.toLowerCase().includes(search.toLowerCase()))) ?? [];
  const stores = data.stores.length ? data.stores : [{ id: data.store.id, name: data.store.name }];
  const actorParty = state?.capabilities.confirmParty;
  const missingChannels = state?.data.policy.activeChannels.filter((channel) => !state.data.sources.some((source) => source.channel === channel && (source.kind === 'pos' || source.kind === 'platform'))) ?? [];
  const agreementIssues = policyIssues.filter((issue) => !['sales_source_missing', 'lines_missing'].includes(issue.code));
  const metricValue = (amount: number | null | undefined) => !hasLines ? '—' : amount === null || amount === undefined ? '확인 필요' : number(amount);
  const gotoReview = () => { setTab('transactions'); setFilter('review'); };
  const upload = state && <UploadBox key={`${storeId}/${month}`} storeId={storeId} month={month} disabled={!editable || Boolean(busy)} busy={busy === 'import'} onImport={importFiles} onReading={setReadingUpload} notify={notify} requestedKind={tab === 'expenses' ? 'expense' : undefined} />;

  return <main id="main-content" className="page oda-page" tabIndex={-1} data-testid="oda-settlement-screen">
    <header className="oda-heading"><div><p className="oda-kicker">ODA PIZZERIA · OPERATIONS</p><h1>{tab === 'expenses' ? '비용 관리' : '월 정산'}</h1><p>{tab === 'expenses' ? '매장 비용과 증빙을 한 화면에서 정리하세요.' : '자료를 모으면, 확인할 항목만 남습니다.'}</p></div><div className="oda-context"><label className="oda-field">매장<select aria-label="정산 매장" value={storeId} disabled={Boolean(busy) || readingUpload} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label className="oda-field">정산월<input type="month" aria-label="정산월" value={month} disabled={Boolean(busy) || readingUpload} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} /></label><Button variant="secondary" aria-label="정산 새로고침" disabled={loading || Boolean(busy)} onClick={() => void load()}><RefreshCcw size={18} /></Button></div></header>
    {error && <div className="oda-error" role="alert">{error}<div><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void load()}>다시 불러오기</Button></div></div>}
    {loading && !state ? <div className="oda-loading" role="status"><RefreshCcw size={27} /><span>이번 달 정산 자료를 불러옵니다.</span></div> : !state ? <div className="oda-empty"><ReceiptText /><strong>{storeId ? '정산 자료에 연결할 수 없습니다.' : '배정된 매장이 없습니다.'}</strong><p>{storeId ? '연결 상태를 확인하고 다시 불러와 주세요.' : '계정 관리자에게 매장 배정을 요청해 주세요.'}</p></div> : <>
      <div className="oda-status-row"><div className="oda-status-text"><span className={`oda-badge ${locked ? 'green' : 'amber'}`}>{locked ? <LockKeyhole size={14} /> : <Clock3 size={14} />}{statusLabel(state.data.status)}</span><span><ShieldCheck size={14} /> 원본·변경 이력 보관</span><span>{state.version ? `저장본 v${state.version}` : '자료 등록 전'}</span></div><div className="oda-calendar"><span><CalendarDays size={15} /> 정산서 <b>{summary?.statementDueDate.slice(5).replace('-', '/')}</b></span><span>지급 <b>{summary?.paymentDueDate.slice(5).replace('-', '/')}</b></span></div></div>
      <section className="oda-metrics" aria-label="이번 달 정산 요약" hidden={tab === 'expenses'}>
        {[{ label: '매출 합계', value: summary?.revenue, detail: hasLines ? `${state.data.lines.filter((line) => line.kind === 'revenue').length}건 · ${state.data.policy.vatBasis === 'net' ? '부가세 제외' : state.data.policy.vatBasis === 'gross' ? '부가세 포함' : '부가세 기준 확인 전'}` : '원본 매출 자료를 넣어 주세요', icon: <CircleDollarSign size={18} /> }, { label: '운영 비용', value: summary?.expenses, detail: '월 운영비 · 투자비 별도', icon: <ReceiptText size={18} /> }, { label: '배분 전 영업이익', value: summary?.profit, detail: hasLines && summary?.revenue ? `매출 대비 ${(summary.profit / summary.revenue * 100).toFixed(1)}%` : '매출 − 운영 비용', icon: <ArrowRight size={18} /> }, { label: 'B 지급 예정액', value: summary?.payableB, detail: locked ? statusLabel(state.data.status) : summary?.canFinalize ? '양측 확인 완료 · 확정 가능' : '기준·증빙 확인 후 확정', icon: <FileCheck2 size={18} /> }].map((metric) => <article className="oda-metric" key={metric.label}><p className="oda-metric-label">{metric.label}{metric.icon}</p><strong>{metricValue(metric.value)}{hasLines && metric.value != null && <em>원</em>}</strong><small>{metric.detail}</small></article>)}
      </section>
      <nav className="oda-tabs" aria-label="정산 상세"><button className={tab === 'overview' ? 'active' : ''} aria-current={tab === 'overview' ? 'page' : undefined} onClick={() => setTab('overview')}>월 정산</button><button className={tab === 'expenses' ? 'active' : ''} aria-current={tab === 'expenses' ? 'page' : undefined} onClick={() => setTab('expenses')}>비용 관리</button><button className={tab === 'transactions' ? 'active' : ''} aria-current={tab === 'transactions' ? 'page' : undefined} onClick={() => setTab('transactions')}>거래·증빙{reviewLines.length > 0 && <span className="oda-tab-count">{reviewLines.length}</span>}</button><button className={tab === 'policy' ? 'active' : ''} aria-current={tab === 'policy' ? 'page' : undefined} onClick={() => setTab('policy')}>정산 기준</button><button className={tab === 'history' ? 'active' : ''} aria-current={tab === 'history' ? 'page' : undefined} onClick={() => { setTab('history'); void load(); }}>변경 기록</button></nav>
      {tab === 'overview' && <section className="oda-next-action" aria-label="이번 달 해야 할 일"><div><p className="oda-kicker">이번 달 해야 할 일</p><h2>{locked ? state.data.status === 'paid' ? '지급까지 완료했습니다' : '정산을 확정했습니다' : !hasLines ? '매출·비용 원본부터 넣어 주세요' : missingChannels.length ? `${missingChannels.map(channelLabel).join('·')} 자료가 아직 없습니다` : reviewLines.length ? `확인할 거래 ${reviewLines.length}건만 살펴보세요` : agreementIssues.length ? '남은 정산 기준을 확인해 주세요' : '확인 완료 · 정산서를 확정할 수 있습니다'}</h2><p>{locked ? '확정본과 원본 증빙은 거래·증빙, 변경 기록에서 확인할 수 있습니다.' : !hasLines || missingChannels.length ? '원본 파일을 넣으면 금액을 읽고 중복·분류·증빙을 확인합니다.' : reviewLines.length ? `전체 ${state.data.lines.length}건 중 확인이 필요한 항목만 모았습니다.` : agreementIssues.length ? '기존 정산 기준은 다음 달에도 이어집니다. 변경이 있을 때만 수정하세요.' : '손익과 배분액을 확인한 뒤 아래 정산 확인에서 확정하세요.'}</p></div>{!locked && hasLines && (missingChannels.length ? <Button variant="secondary" onClick={() => { setTab('transactions'); }}>빠진 자료 추가 <Plus size={16} /></Button> : reviewLines.length ? <Button onClick={gotoReview}>확인할 거래 보기 <ArrowRight size={16} /></Button> : agreementIssues.length ? <Button variant="secondary" onClick={() => setTab('policy')}>남은 기준 확인 <ArrowRight size={16} /></Button> : null)}</section>}
      {editable && <div className="oda-upload-panel" id="oda-expense-upload" hidden={!((tab === 'overview' && (!hasLines || showUpload)) || tab === 'transactions' || (tab === 'expenses' && showUpload))}>{upload}</div>}
      {tab === 'overview' && <>

        <div className="oda-steps"><div className={`oda-step ${hasLines ? 'done' : 'active'}`}><span>{hasLines ? <Check size={16} /> : '1'}</span><div><strong>자료 넣기</strong><small>매출·비용 파일 한 번에</small></div></div><div className={`oda-step ${hasLines && !summary?.canFinalize && !locked ? 'active' : summary?.canFinalize || locked ? 'done' : ''}`}><span>{summary?.canFinalize || locked ? <Check size={16} /> : '2'}</span><div><strong>확인할 항목만</strong><small>{reviewLines.length ? `${reviewLines.length}건 확인 필요` : hasLines ? '정산 기준과 증빙 확인' : '중복·누락·분류 확인'}</small></div></div><div className={`oda-step ${summary?.canFinalize || locked ? 'active' : ''}`}><span>{locked ? <Check size={16} /> : '3'}</span><div><strong>정산서 확정</strong><small>원본 보관 · 지급 기록</small></div></div></div>
        <div className="oda-layout"><div className="oda-stack">
          {editable && hasLines && !showUpload && <section className="oda-card"><div className="oda-card-head"><div><h2>이번 달 자료가 모였습니다</h2><p>자료 {state.data.sources.length}개 · 거래 {state.data.lines.length}건</p></div><Button variant="secondary" onClick={() => setShowUpload(true)}><Plus size={17} /> 자료 추가</Button></div></section>}
          <section className="oda-card" id="oda-exports" tabIndex={-1}><div className="oda-card-head"><div><h2>한눈에 보는 손익계산서</h2><p>{month.replace('-', '년 ')}월 · {state.data.policy.vatBasis === 'net' ? '공급가액 기준' : state.data.policy.vatBasis === 'gross' ? '부가세 포함 기준' : '부가세 기준은 정산 기준에서 확인하세요'}</p></div><div className="oda-inline-tools" aria-label="정산서 내려받기"><a className="button button-secondary" href={odaUrl(storeId, month, '/export.xlsx')}><ArrowDownToLine size={16} /><span>엑셀</span></a><a className="button button-secondary" href={odaUrl(storeId, month, '/export.csv')}><ArrowDownToLine size={16} /><span>CSV</span></a></div></div>
            {!hasLines ? <div className="oda-empty"><ReceiptText /><strong>첫 자료를 넣으면 손익이 계산됩니다</strong><p>매출·비용은 귀속월 기준으로 합산하고,<br />계좌 입금은 중복 매출로 더하지 않습니다.</p></div> : <div className="oda-pnl"><div className="oda-pnl-row"><strong>매출 합계</strong><b>{money(summary!.revenue)}</b></div>{summary!.revenueByChannel.map((item) => <div className="oda-pnl-row sub" key={item.category}><span>{channelLabel(item.category) || '기타 매출'}</span><b>{money(item.amount)}</b></div>)}<div className="oda-pnl-row"><strong>운영 비용</strong><b>− {money(summary!.expenses)}</b></div>{summary!.expenseByCategory.map((item) => <div className="oda-pnl-row sub" key={item.category}><span>{categoryLabel(item.category)} <span aria-label="거래 수">· {item.count}건</span></span><b>{money(item.amount)}</b></div>)}<div className="oda-pnl-row total"><span>배분 전 영업이익</span><b>{money(summary!.profit)}</b></div></div>}
            <p className="oda-pnl-note">A 우선배분금 300만원은 비용 차감 후 이익에서 배분합니다. 계약에 따라 감가상각은 비용에서 제외합니다. 시설 투자·보증금·배분금은 앱에서 운영비와 별도로 분류합니다.</p>
          </section>
          {hasLines && <section className="oda-card"><div className="oda-card-head"><div><h2>확인할 항목 {reviewLines.length}건</h2><p>확인된 거래는 다시 입력하지 않습니다. 금액·분류·증빙의 예외만 확인하세요.</p></div><Button variant="secondary" onClick={gotoReview}>확인하기 <ArrowRight size={16} /></Button></div>{reviewLines.length ? <div className="oda-card-body"><ul className="oda-issues">{reviewLines.slice(0, 4).map((line) => <li key={line.id}><AlertTriangle size={16} /><span>{line.description} · {money(line.amount)}<br />{lineIssues.find((issue) => issue.lineId === line.id)?.message || '금액·분류와 원본을 확인해 주세요.'}</span></li>)}</ul></div> : <div className="oda-card-body"><p><Check size={17} /> 거래 확인이 완료되었습니다. 정산 기준과 양측 확인을 마치면 확정할 수 있습니다.</p></div>}</section>}
        </div><aside className="oda-stack">
          <SplitCard summary={summary!} hasLines={hasLines} policy={state.data.policy} />
          <section className="oda-card" id="oda-payment" tabIndex={-1}><div className="oda-card-head"><div><h2>{locked ? '확정된 정산서' : '정산 확인'}</h2><p>{locked ? '변경 시 사유를 남기고 재정산합니다.' : '양측이 같은 기준을 확인합니다.'}</p></div></div><div className="oda-card-body">
            {policyIssues.length > 0 && !locked && <ul className="oda-issues">{policyIssues.slice(0, 4).map((issue) => <li key={issue.code}><AlertTriangle size={16} /><span>{issue.message}</span></li>)}{policyIssues.length > 4 && <li>그 외 {policyIssues.length - 4}개 항목은 정산 기준에서 확인하세요.</li>}</ul>}
            <Approvals policy={state.data.policy} />
            <div className="oda-confirm-actions">{!locked && <Button variant="secondary" onClick={() => setTab('policy')}>정산 기준 확인 <ArrowRight size={16} /></Button>}{!locked && actorParty && <Button variant="secondary" disabled={Boolean(busy) || Boolean(state.data.policy.acknowledgements[actorParty])} onClick={() => void mutate('/confirm-policy', {}, `${actorParty}의 정산 기준 확인을 기록했습니다.`)}>{state.data.policy.acknowledgements[actorParty] ? `${actorParty} 확인 완료` : `${actorParty} 정산 기준 확인`}</Button>}{!locked && <Button disabled={!state.capabilities.finalize || !summary?.canFinalize || Boolean(busy)} onClick={() => void mutate('/finalize', {}, '정산서를 확정하고 원본을 보관했습니다.')}><LockKeyhole size={17} />{busy === '/finalize' ? '확정 중…' : '정산서 확정'}</Button>}{locked && <Button variant="secondary" onClick={() => window.print()}><FileCheck2 size={17} /> 정산서 인쇄·PDF</Button>}</div>
            {!locked && !summary?.canFinalize && <p className="oda-mini-note" style={{ marginTop: 13 }}>미확인 항목이 해결되면 확정 버튼이 활성화됩니다.</p>}
            {state.data.status === 'finalized' && state.capabilities.pay && <div className="oda-comment-form" style={{ marginTop: 22 }}><label className="oda-field">실제 지급일<input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></label><label className="oda-field">이체 확인번호·메모<input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="은행 이체번호 또는 확인 내용" maxLength={500} /></label><Button disabled={Boolean(busy) || !paymentDate || paymentReference.trim().length < 3} onClick={() => void mutate('/paid', { date: paymentDate, reference: paymentReference.trim(), amount: summary!.payableB }, '지급 완료를 기록했습니다.')}>지급 {money(summary!.payableB)} 기록</Button></div>}
            {state.data.status === 'paid' && <p className="oda-mini-note" style={{ marginTop: 16 }}>지급 기록: {state.payment?.date || (state.data.paidAt ? dateTime(state.data.paidAt) : '')}<br />{state.data.paymentReference}</p>}
          </div></section>
        </aside></div>
      </>}
      {tab === 'expenses' && <OdaExpenses key={`${storeId}/${month}`} state={state} storeId={storeId} month={month} editable={editable} busy={Boolean(busy)}
        onUpload={() => { setShowUpload(true); requestAnimationFrame(() => document.getElementById('oda-expense-upload')?.scrollIntoView?.({ block: 'start' })); }} onAdd={(sourceId = '') => { setManualSource(sourceId); setShowManual(true); requestAnimationFrame(() => document.getElementById('oda-expense-manual')?.scrollIntoView?.({ block: 'center' })); }}
        onBatch={(lineIds, changes, expectedVersion) => mutate('/expenses/batch', { lineIds, changes }, `비용 ${lineIds.length}건을 저장했습니다.`, expectedVersion)}
        renderLine={line => <LineRow key={`${line.id}:${state.version}`} line={line} sources={state.data.sources} issues={summary!.blockers.filter(issue => issue.lineId === line.id).map(issue => issue.message)} disabled={!editable || Boolean(busy)} storeId={storeId} month={month} onSave={changes => mutate(`/lines/${encodeURIComponent(line.id)}`, { changes }, '비용 확인을 저장했습니다.')} />}
        manual={editable && showManual ? <div id="oda-expense-manual"><div className="oda-card-head"><h3>비용 직접 추가</h3><Button variant="secondary" disabled={Boolean(busy)} onClick={() => setShowManual(false)}>닫기</Button></div><ManualExpense key={`${storeId}/${month}/${manualSource}`} month={month} initialSourceId={manualSource} sources={state.data.sources} busy={Boolean(busy)} onSave={async line => { if (await mutate('/lines', { line }, '비용을 추가했습니다.')) setShowManual(false); }} /></div> : null}
        recurring={editable ? <section className="oda-card"><div className="oda-card-head"><div><h2>매달 나가는 비용</h2><p>지난달 임차료·인건비·공과금을 선택해서 가져올 수 있습니다.</p></div></div><OdaRecurringCosts storeId={storeId} month={month} version={state.version} disabled={Boolean(busy)} onImport={({ expectedVersion, ...selection }) => mutate('/repeat-previous', selection, '선택한 반복 비용을 확인 대기로 가져왔습니다.', expectedVersion)} /></section> : null} />}
      {tab === 'transactions' && <div className="oda-stack">
        {editable && <><section className="oda-card"><div className="oda-card-head"><div><h2>파일에 없는 비용만 추가하세요</h2><p>반복 비용은 지난달 내역을 가져온 뒤 이번 달 증빙을 연결합니다.</p></div><div className="oda-inline-tools"><Button variant="secondary" onClick={() => setShowManual(!showManual)}>{showManual ? <X size={16} /> : <Plus size={16} />}{showManual ? '닫기' : '비용 직접 추가'}</Button></div></div><OdaRecurringCosts key={`${storeId}/${month}`} storeId={storeId} month={month} version={state.version} disabled={Boolean(busy)} onImport={async ({ expectedVersion, ...selection }) => { const saved = await mutate('/repeat-previous', selection, '선택한 비용을 확인 대기로 가져왔습니다. 실제 금액·귀속일·이번 달 증빙을 확인해 주세요.', expectedVersion); if (saved) gotoReview(); return saved; }} />{showManual && <ManualExpense month={month} sources={state.data.sources} busy={Boolean(busy)} onSave={async (line) => { const saved = await mutate('/lines', { line }, '비용을 추가했습니다.'); if (saved) setShowManual(false); }} />}</section></>}
        <section className="oda-card"><div className="oda-card-head"><div><h2>거래 내역</h2><p>원본 행까지 연결해 금액·분류·증빙을 확인합니다.</p></div><span className="oda-badge">{state.data.lines.length}건</span></div><div className="oda-filterbar"><div className="oda-filters">{[{ value: 'review', label: `확인 필요 ${reviewLines.length}` }, { value: 'all', label: '전체' }, { value: 'revenue', label: '매출' }, { value: 'expense', label: '비용' }, { value: 'bank', label: '계좌' }, { value: 'excluded', label: '제외' }].map((item) => <button key={item.value} className={filter === item.value ? 'active' : ''} aria-pressed={filter === item.value} onClick={() => setFilter(item.value as Filter)}>{item.label}</button>)}</div><label className="oda-search"><Search size={16} /><input aria-label="거래 내역 검색" placeholder="거래명·거래번호 검색" value={search} onChange={(e) => setSearch(e.target.value)} /></label></div>
          {filtered.length ? filtered.slice(0, visibleLimit).map((line) => <LineRow key={`${line.id}:${line.reviewed}:${line.category}:${line.note}:${line.sourceId}:${line.vat}`} line={line} sources={state.data.sources} issues={summary!.blockers.filter((issue) => issue.lineId === line.id).map((issue) => issue.message)} disabled={!editable || Boolean(busy)} storeId={storeId} month={month} onSave={(changes) => mutate(`/lines/${encodeURIComponent(line.id)}`, { changes }, '거래 확인을 저장했습니다.')} onBankExpense={state.data.lines.some((item) => item.bankLineId === line.id) ? undefined : (body) => mutate('/bank-expense', body, '계좌 출금을 비용으로 반영했습니다. 원본 계좌 내역은 그대로 보관합니다.')} />) : <div className="oda-empty"><Check /><strong>{filter === 'review' && hasLines ? '확인할 거래가 없습니다' : '표시할 거래가 없습니다'}</strong><p>{hasLines ? '다른 필터를 선택하면 저장된 거래를 확인할 수 있습니다.' : '매출·비용 파일을 올려 정산을 시작하세요.'}</p></div>}{filtered.length > visibleLimit && <div className="oda-policy-footer"><p>{filtered.length}건 중 {visibleLimit}건 표시</p><Button variant="secondary" onClick={() => setVisibleLimit((count) => count + 50)}>다음 50건 더 보기</Button></div>}
        </section>
        <section className="oda-card"><div className="oda-card-head"><div><h2>원본 자료와 증빙</h2><p>사진·PDF는 증빙으로 보관됩니다. 금액은 확인한 뒤 비용에 연결하세요.</p></div><span className="oda-badge">{state.data.sources.length}개</span></div>{state.data.sources.length ? <div className="oda-evidence-list">{state.data.sources.map((source) => <div className="oda-evidence" key={source.id}><FileCheck2 size={22} /><div><strong>{source.fileName}</strong><small>{kinds[source.kind]} · {source.rowCount}행 · {dateTime(source.importedAt)}<br />무결성 해시 {source.sha256.slice(0, 14)}…</small></div><a aria-label={`${source.fileName} 원본 다운로드`} href={odaUrl(storeId, month, `/evidence/${encodeURIComponent(source.id)}`)}><ArrowDownToLine size={18} /></a></div>)}</div> : <div className="oda-empty"><FileCheck2 /><strong>아직 등록된 자료가 없습니다</strong><p>매출 파일과 영수증을 이곳에서 함께 관리합니다.</p></div>}</section>
        {hasLines && <div className="oda-notice">계좌는 현금 흐름 확인용입니다. 입금 {money(summary!.bankInflow)} · 출금 {money(summary!.bankOutflow)}를 손익에 다시 더하지 않습니다. 손익 제외 {summary!.excludedCount}건 · {money(summary!.excluded)}.</div>}
      </div>}
      {tab === 'policy' && policy && <div className="oda-policy-grid"><section className="oda-card"><div className="oda-card-head"><div><h2>이번 달 정산 기준</h2><p>저장된 기준을 다음 달에도 사용합니다. 변경된 항목만 수정하세요.</p></div><span className="oda-badge">{month}</span></div><div className="oda-policy-section"><h3>01. 매출 집계</h3><div className="oda-form-grid"><label className="oda-field">손익의 부가세 기준<select disabled={!editable || Boolean(busy)} value={policy.vatBasis} onChange={(e) => setPolicy({ ...policy, vatBasis: e.target.value as OdaPolicy['vatBasis'] })}><option value="unresolved">양측 합의 필요</option><option value="net">부가세 제외 · 공급가액</option><option value="gross">부가세 포함 · 결제금액</option></select><small>부가세 제외 시 각 거래의 부가세액이 필요합니다.</small></label><label className="oda-field">POS에 배달 매출이 포함되나요?<select disabled={!editable || Boolean(busy)} value={policy.posDeliveryScope} onChange={(e) => setPolicy({ ...policy, posDeliveryScope: e.target.value as OdaPolicy['posDeliveryScope'] })}><option value="unresolved">확인 필요</option><option value="included">포함됨 · POS 매출 기준</option><option value="excluded">별도 · POS + 배달 매출</option></select><small>같은 배달 매출이 두 번 더해지지 않게 합니다.</small></label><label className="oda-field full">손익 귀속 기준<select disabled={!editable || Boolean(busy)} value={policy.attributionBasis} onChange={(e) => setPolicy({ ...policy, attributionBasis: e.target.value as OdaPolicy['attributionBasis'] })}><option value="unresolved">양측 확인 필요</option><option value="accrual">매출·비용 발생월 기준</option></select><small>입금일과 무관하게 해당 매출·비용이 발생한 달에 반영합니다.</small></label><div className="oda-field full"><span>운영 중인 판매 채널</span><div className="oda-checks">{channels.map((channel) => <label key={channel.value} className="oda-checkbox"><input type="checkbox" disabled={!editable || Boolean(busy)} checked={policy.activeChannels.includes(channel.value)} onChange={(e) => setPolicy({ ...policy, activeChannels: e.target.checked ? [...policy.activeChannels, channel.value] : policy.activeChannels.filter((item) => item !== channel.value) })} />{channel.label}</label>)}</div><small>선택한 채널의 월 자료가 있어야 누락 없이 정산을 확정합니다.</small></div></div></div>
        <div className="oda-policy-section"><h3>02. 이익 배분과 세금계산서</h3><div className="oda-form-grid"><label className="oda-field">B 배분금 부가세<select disabled={!editable || Boolean(busy)} value={policy.bVatPolicy} onChange={(e) => setPolicy({ ...policy, bVatPolicy: e.target.value as OdaPolicy['bVatPolicy'] })}><option value="unresolved">세금계산서 처리 합의 필요</option><option value="add10">배분금에 부가세 10% 가산</option><option value="none">부가세 가산 없음 · 합의 근거 필요</option></select></label><label className="oda-field">이익이 우선배분금보다 적을 때<select disabled={!editable || Boolean(busy)} value={policy.lowProfitPolicy} onChange={(e) => setPolicy({ ...policy, lowProfitPolicy: e.target.value as OdaPolicy['lowProfitPolicy'] })}><option value="hold">정산 보류 · 별도 합의</option><option value="available_profit_only">발생 이익 한도 내 A 배분 · 부족분 이월 없음</option></select><small>적자월은 별도 협의가 필요해 확정을 보류합니다.</small></label><label className="oda-field">1원 미만 배분 잔액<select disabled={!editable || Boolean(busy)} value={policy.roundingBeneficiary} onChange={(e) => setPolicy({ ...policy, roundingBeneficiary: e.target.value as OdaPolicy['roundingBeneficiary'] })}><option value="A">A에게 잔액 배분</option><option value="B">B에게 잔액 배분</option></select></label></div></div>
        <div className="oda-policy-section"><h3>03. 중도 개점·종료</h3><label className="oda-checkbox"><input type="checkbox" disabled={!editable || Boolean(busy)} checked={policy.partialMonth} onChange={(e) => setPolicy({ ...policy, partialMonth: e.target.checked })} />한 달 전체를 운영하지 않았습니다</label>{policy.partialMonth && <div className="oda-form-grid" style={{ marginTop: 14 }}><label className="oda-field">실제 운영일<input type="number" min="1" max="31" disabled={!editable || Boolean(busy)} value={policy.operatingDays} onChange={(e) => setPolicy({ ...policy, operatingDays: Number(e.target.value) })} /></label><label className="oda-field">우선배분금 적용<select disabled={!editable || Boolean(busy)} value={policy.partialMonthPolicy} onChange={(e) => setPolicy({ ...policy, partialMonthPolicy: e.target.value as OdaPolicy['partialMonthPolicy'] })}><option value="hold">합의 전 정산 보류</option><option value="full_priority">300만원 전액 적용</option><option value="prorate">달력일 대비 운영일로 일할 계산</option></select></label></div>}</div>
        <div className="oda-policy-section"><h3>04. 양측 합의 근거</h3><label className="oda-field">확인 내용·합의 문서 참조<textarea disabled={!editable || Boolean(busy)} value={policy.agreementNote} onChange={(e) => setPolicy({ ...policy, agreementNote: e.target.value })} maxLength={4000} placeholder="부가세·정산 방식 등 양측이 확인한 내용과 문서명을 남겨 주세요." /></label><Approvals policy={state.data.policy} /><p className="oda-mini-note" style={{ marginTop: 15 }}>기준이 바뀌면 기존 확인은 해제됩니다. 각 당사자가 본인 계정으로 다시 확인합니다.</p></div><footer className="oda-policy-footer"><p>{locked ? '확정된 기준입니다. 변경하려면 정산을 다시 열어야 합니다.' : '저장 후 각 당사자가 같은 정산 기준을 확인합니다.'}</p><Button disabled={!editable || Boolean(busy)} onClick={() => { const { acknowledgements: _acknowledgements, ...editablePolicy } = policy; void mutate('/save', { policy: editablePolicy }, '정산 기준을 저장했습니다. 양측 확인이 필요합니다.'); }}>정산 기준 저장</Button></footer></section>
        <aside className="oda-stack"><section className="oda-card"><div className="oda-card-head"><div><h2>계약서 적용 기준</h2><p>매장 운영 계약서 · 제5·8·9조</p></div></div><div className="oda-card-body"><dl className="oda-contract-list"><div><dt>매월 정산 일정</dt><dd>익월 5일까지 정산서<br />익월 10일까지 배분금 지급</dd></div><div><dt>배분 순서</dt><dd>A에게 300만원 우선 배분<br />남은 영업이익을 A : B = 50 : 50</dd></div><div><dt>운영비와 배분금</dt><dd>A 선공제금은 인건비에서 제외<br />인테리어 등 감가상각비는 비용에서 제외</dd></div><div><dt>추가 투자</dt><dd>통상 운영 범위를 벗어나는 100만원 이상 투자 시 B 사전 서면 동의</dd></div><div><dt>계좌와 세금계산서</dt><dd>제9조는 부가세 별도 가산을 명시합니다. 정산 조항 인용 오류와 비용처리 범위를 양측이 확인 후 적용합니다.</dd></div></dl></div></section>{summary!.blockers.length > 0 && <section className="oda-card"><div className="oda-card-head"><h2>확정 전 확인사항</h2></div><div className="oda-card-body"><ul className="oda-issues">{summary!.blockers.filter((issue) => !issue.lineId).map((issue) => <li key={`${issue.code}:${issue.message}`}><AlertTriangle size={16} /><span>{issue.message}</span></li>)}{lineIssues.length > 0 && <li><AlertTriangle size={16} /><span>거래 내역에서 {reviewLines.length}건의 금액·분류·증빙을 확인하세요.</span></li>}</ul></div></section>}</aside></div>}
      {tab === 'history' && <div className="oda-layout"><section className="oda-card"><div className="oda-card-head"><div><h2>정산 기록</h2><p>확정 시점의 거래·기준·계산 결과를 함께 보관합니다.</p></div><span className="oda-badge">확정본 {state.data.history.length}개</span></div><div className="oda-history-list">{[...state.data.history].reverse().map((snapshot) => <article className="oda-history-event" key={snapshot.id}><header><strong>정산 확정본 v{snapshot.version}</strong><small>{dateTime(snapshot.at)} · {snapshot.actorName}</small></header>{snapshot.reason && <p>{snapshot.reason}</p>}<div className="oda-pnl-row"><span>배분 전 영업이익</span><b>{money(snapshot.summary.profit)}</b></div><div className="oda-pnl-row"><span>B 지급액</span><b>{money(snapshot.summary.payableB)}</b></div><details><summary className="oda-quiet-link">당시 계산 근거</summary><p>원본 {snapshot.sources.length}개 · 거래 {snapshot.lines.length}건<br />매출 {money(snapshot.summary.revenue)} − 비용 {money(snapshot.summary.expenses)}<br />A 우선배분 {money(snapshot.summary.priorityA)} · B 배분 {money(snapshot.summary.shareB)} · B 부가세 {money(snapshot.summary.vatB)}</p></details></article>)}{[...state.data.comments].reverse().map((entry) => <article className="oda-history-event" key={entry.id}><header><strong>{entry.actorName}</strong><small>{dateTime(entry.at)}</small></header><p>{entry.body}</p></article>)}{state.audit?.map((event) => <AuditEvent key={event.id} event={event} actorName={event.actorId === data.actor.id ? data.actor.name : data.availableActors?.find((actor) => actor.id === event.actorId)?.name || event.actorId} />)}</div>{!state.data.history.length && !state.data.comments.length && !state.audit?.length && <div className="oda-empty"><Clock3 /><strong>기록은 이곳에 차곡차곡 쌓입니다</strong><p>정산 확정본과 양측 확인 메모를 함께 볼 수 있습니다.</p></div>}</section><aside className="oda-stack"><section className="oda-card"><div className="oda-card-head"><h2>정산 메모 남기기</h2></div><div className="oda-card-body">{state.capabilities.edit ? <form className="oda-comment-form" onSubmit={(e) => { e.preventDefault(); void mutate('/comment', { text: comment.trim() }, '정산 메모를 기록했습니다.').then((saved) => { if (saved) setComment(''); }); }}><label className="oda-field">공유할 확인 내용<textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="예: 9/30 매출의 10/2 입금 내역을 확인했습니다." maxLength={4000} /></label><Button type="submit" disabled={Boolean(busy) || comment.trim().length < 3}><Send size={16} /> 메모 기록</Button></form> : <p className="oda-mini-note">조회 권한으로 정산 기록을 열람하고 있습니다.</p>}</div></section>{locked && state.capabilities.reopen && <section className="oda-card"><div className="oda-card-head"><div><h2>정산 다시 열기</h2><p>기존 확정본은 그대로 보관합니다.</p></div></div><div className="oda-card-body"><label className="oda-field">변경 사유<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="누락·정정 내용과 변경 사유를 적어 주세요." /></label><Button style={{ marginTop: 14 }} variant="secondary" disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => void mutate('/reopen', { reason: reason.trim() }, '정산을 다시 열었습니다. 수정 후 양측 확인과 재확정이 필요합니다.')}>사유를 기록하고 다시 열기</Button></div></section>}</aside></div>}
    </>}
  </main>;
}

function Approvals({ policy }: { policy: OdaPolicy }) {
  return <div className="oda-approval">{(['A', 'B'] as const).map((party) => <div key={party}><strong>{party === 'A' ? 'A · 매장 운영자' : 'B · 운영 지원자'}</strong><span>{policy.acknowledgements[party] ? <><Check size={15} /> 확인 완료</> : <><Clock3 size={15} /> 확인 대기</>}</span>{policy.acknowledgements[party] && <small>{policy.acknowledgements[party]!.actorName}<br />{dateTime(policy.acknowledgements[party]!.at)}</small>}</div>)}</div>;
}

function SplitCard({ summary, hasLines, policy }: { summary: OdaSummary; hasLines: boolean; policy: OdaPolicy }) {
  const value = (amount: number | null) => hasLines ? money(amount) : '—';
  const limited = policy.lowProfitPolicy === 'available_profit_only' && summary.profit >= 0 && summary.profit < summary.priorityA;
  const appliedPriority = limited ? summary.profit : summary.priorityA;
  const appliedResidual = limited ? 0 : summary.residualProfit;
  return <section className="oda-card oda-split"><div className="oda-card-head"><div><h2>배분은 이렇게 계산됩니다</h2><p>계약 및 추가 합의 기준</p></div></div><div className="oda-card-body"><div className="oda-split-row"><span>배분 전 영업이익</span><b>{value(summary.profit)}</b></div><div className="oda-split-row"><span>A 우선배분<small>{policy.partialMonth && policy.partialMonthPolicy === 'prorate' ? '월 300만원을 운영일로 일할 적용' : '계약 기준 월 300만원'}</small></span><b>− {value(appliedPriority)}</b></div><div className="oda-split-row oda-split-divider"><span>남은 배분 대상 이익</span><b>{value(appliedResidual)}</b></div><div className="oda-split-row"><span>A 최종 배분<small>우선배분 + 남은 이익 50%</small></span><b>{value(summary.shareA)}</b></div><div className="oda-split-row"><span>B 배분<small>남은 이익 50%</small></span><b>{value(summary.shareB)}</b></div><div className="oda-split-row"><span>B 부가세<small>{policy.bVatPolicy === 'add10' ? '배분금 × 10%' : policy.bVatPolicy === 'none' ? '가산 없음' : '양측 합의 후 적용'}</small></span><b>{value(summary.vatB)}</b></div>{limited && <p className="oda-mini-note" style={{ color: '#d9cba9', marginBottom: 15 }}>합의에 따라 발생 이익 한도만 배분합니다. 부족분 {money(summary.priorityA - summary.profit)}은 이월하지 않습니다.</p>}<div className="oda-split-total"><p>B 지급 예정액</p><strong>{value(summary.payableB)}</strong><small>{summary.payableB === null && hasLines ? '배분 기준 확인 전입니다. 저이익·적자월은 합의 없이 확정하지 않습니다.' : '배분금 + 적용 부가세 · 확정 전 예상액'}</small></div></div></section>;
}

function UploadBox({ storeId, month, disabled, busy, onImport, onReading, notify, requestedKind }: { requestedKind?: OdaSourceKind; storeId: string; month: string; disabled: boolean; busy: boolean; onImport: (files: PendingFile[], onSaved?: (file: PendingFile) => void) => Promise<boolean>; onReading: (reading: boolean) => void; notify: Props['notify'] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<OdaSourceKind>(requestedKind || 'pos');
  const [channel, setChannel] = useState(requestedKind === 'expense' ? 'manual' : 'pos');
  const [files, setFiles] = useState<PendingFile[]>([]);
  useEffect(() => { if (requestedKind && !files.length) { setKind(requestedKind); setChannel('manual'); } }, [requestedKind]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [mappingWorking, setMappingWorking] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileVersion, setProfileVersion] = useState(0);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [profileError, setProfileError] = useState('');
  const checking = reading || mappingWorking || profileLoading;
  const [readProgress, setReadProgress] = useState({ done: 0, total: 0 });
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [sheetName, setSheetName] = useState('');
  const [savedProfile, setSavedProfile] = useState<ImportProfile | null>(null);
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setProfileLoading(true); setProfileError(''); setSavedProfile(null); setProfileVersion(0); setHeaderRow(1); setSheetName('');
    void getOdaImportProfile(storeId, kind, channel, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      // Only migrate browser settings if the server has never stored or reset this source.
      const profile = result.version === 0 ? readImportProfile(profileKey(storeId, kind, channel)) : result.profile;
      setProfileVersion(result.version); setSavedProfile(profile); setHeaderRow(profile?.headerRow || 1); setSheetName(profile?.sheetName || '');
    }).catch(error => {
      if (!controller.signal.aborted) setProfileError(error instanceof Error ? error.message : '엑셀 설정을 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    return () => controller.abort();
  }, [storeId, kind, channel, profileRefresh]);
  useEffect(() => { onReading(checking); return () => onReading(false); }, [checking, onReading]);
  async function preview(list: File[]) {
    if (disabled || checking || !list.length) return;
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100) { setLocalError('열 제목 행은 1~100 사이의 정수로 입력해 주세요.'); return; }
    setReading(true); setLocalError(''); setReadProgress({ done: 0, total: list.length });
    const profile = savedProfile;
    const settled = await Promise.allSettled(list.map(async (file) => {
      const id = crypto.randomUUID();
      try {
        const prepared = await prepareOdaFile(file, kind, channel);
        let input: OdaImport = { ...prepared, ...(/\.xlsx$/i.test(file.name) ? { headerRow, ...(sheetName.trim() ? { sheetName: sheetName.trim() } : {}) } : {}) };
        try {
          let preview = await previewOdaImport(storeId, month, input);
          // Reuse column mappings only after this workbook's headers match the saved format.
          if (profile && preview.workbook && JSON.stringify(profile.headers) === JSON.stringify(preview.workbook.headers) && Object.keys(profile.columnMap).length) {
            input = { ...input, columnMap: profile.columnMap };
            preview = await previewOdaImport(storeId, month, input);
          }
          return { id, input, preview };
        } catch (e) { return { id, input, preview: null, error: e instanceof Error ? e.message : '파일을 읽지 못했습니다.' }; }
      } finally { setReadProgress((current) => ({ ...current, done: current.done + 1 })); }
    }));
    const pending: PendingFile[] = [];
    const errors: string[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') pending.push(result.value);
      else errors.push(result.reason instanceof Error ? result.reason.message : '파일을 읽지 못했습니다.');
    }
    setFiles((current) => [...current, ...pending]); setLocalError(errors.join(' ')); setReading(false);
    if (errors.length) notify(errors[0], 'warning');
  }
  const readyFiles = files.filter((file) => file.preview && !file.error && !file.preview.errors.length);
  const errorCount = files.length - readyFiles.length;
  async function saveReady() {
    if (disabled || checking || !readyFiles.length) return;
    setSaveProgress({ done: 0, total: readyFiles.length });
    try {
      await onImport(readyFiles, (file) => {
        setFiles((current) => current.filter((item) => item !== file));
        setSaveProgress((current) => current ? { ...current, done: current.done + 1 } : current);
      });
      setProfileRefresh(value => value + 1);
    } finally { setSaveProgress(null); }
  }
  async function resetProfile() {
    if (disabled || checking) return;
    setProfileLoading(true); setProfileError('');
    try {
      const result = await resetOdaImportProfile(storeId, kind, channel, profileVersion);
      try { localStorage.removeItem(profileKey(storeId, kind, channel)); } catch { /* Legacy preference storage is optional. */ }
      setProfileVersion(result.version); setSavedProfile(null); setHeaderRow(1); setSheetName('');
      notify('이 매장·출처의 저장한 양식을 초기화했습니다. 다음 파일부터 적용됩니다.', 'info');
    } catch (error) { setProfileError(error instanceof Error ? error.message : '엑셀 설정을 초기화하지 못했습니다.'); }
    finally { setProfileLoading(false); }
  }
  function template() {
    const lineKind = kind === 'bank' ? 'bank' : kind === 'expense' || kind === 'evidence' ? 'expense' : 'revenue';
    const example = lineKind === 'expense' ? `${month}-01,월 임차료,1100000,100000,rent,manual,EXAMPLE-001,expense` : lineKind === 'bank' ? `${month}-01,매출 입금,110000,0,,bank,EXAMPLE-001,bank` : `${month}-01,매출 예시,110000,10000,,${channel},EXAMPLE-001,revenue`;
    downloadOdaText(`ODA_${month}_${kind}_작성양식.csv`, `귀속일,내용,금액,부가세,분류,채널,거래번호,유형\r\n${example}\r\n`);
    notify('예시 1행이 포함된 양식입니다. 실제 자료로 바꾼 뒤 업로드해 주세요.', 'info');
  }
  return <section className="oda-upload-card" aria-label="정산 자료 업로드">
    <div className="oda-upload-top"><div><h2>자료 넣기</h2><p>POS·배달·비용 자료를 차례로 추가한 뒤 한 번에 반영하세요.</p></div><Button variant="ghost" onClick={template}><ArrowDownToLine size={16} /> 양식</Button></div>
    <div className="oda-upload-controls"><label className="oda-field">어떤 자료인가요?<select value={kind} disabled={disabled || checking} onChange={(e) => { const value = e.target.value as OdaSourceKind; setKind(value); setChannel(value === 'platform' ? 'baemin' : value === 'pos' ? 'pos' : value === 'bank' ? 'bank' : 'manual'); }}><option value="pos">매장 POS 매출</option><option value="platform">배달 플랫폼 매출</option><option value="expense">운영 비용 내역</option><option value="bank">계좌 입출금 내역</option><option value="evidence">영수증·계약서 증빙</option></select></label><label className="oda-field">자료 출처{kind === 'platform' ? <select value={channel} disabled={disabled || checking} onChange={(e) => setChannel(e.target.value)}>{channels.filter((item) => item.value !== 'pos').map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select> : <input value={kind === 'pos' ? '매장 POS' : kind === 'bank' ? '계좌 대사 · 손익 별도' : '운영 비용·증빙'} readOnly />}</label></div>
    <button className={`oda-drop ${dragging ? 'dragging' : ''}`} type="button" disabled={disabled || checking} onClick={() => inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); if (!disabled && !checking) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) void preview(Array.from(e.dataTransfer.files)); }}><ImagePlus size={34} /><span><strong>{reading ? `자료 확인 중 · ${readProgress.done}/${readProgress.total}개` : files.length ? '다음 파일을 추가하세요 · 선택한 자료는 유지됩니다' : '파일을 끌어 놓거나 눌러서 선택하세요'}</strong><small>XLSX·CSV·TSV · PDF·JPG·PNG / 파일당 2MB</small></span></button><input ref={inputRef} className="sr-only" type="file" multiple accept=".xlsx,.csv,.tsv,.pdf,.jpg,.jpeg,.png" aria-label="정산 파일 선택" disabled={disabled || checking} onChange={(e) => { void preview(Array.from(e.target.files || [])); e.target.value = ''; }} />
    {profileLoading && <p className="oda-upload-note" role="status">저장한 엑셀 설정을 확인하고 있습니다…</p>}
    {profileError && <p className="oda-error" role="alert">{profileError} <Button variant="ghost" disabled={disabled || checking} onClick={() => setProfileRefresh(value => value + 1)}>설정 다시 불러오기</Button></p>}
    {savedProfile && <p className="oda-upload-note"><Check size={16} /><span>이 매장의 {channelLabel(channel) === 'manual' ? '비용' : channelLabel(channel)} 엑셀 설정을 불러왔습니다. 열 구성이 같으면 저장한 연결을 자동 적용합니다.</span></p>}
    <details className="oda-upload-settings"><summary className="oda-quiet-link">엑셀 시트·제목 행 설정</summary><div className="oda-form-grid" style={{ marginTop: 12 }}><label className="oda-field">시트 이름<input value={sheetName} onChange={(e) => setSheetName(e.target.value)} placeholder="비워두면 기본 시트" maxLength={100} disabled={disabled || checking} /></label><label className="oda-field">열 제목이 있는 행<input type="number" min="1" max="100" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))} disabled={disabled || checking} /></label></div><p className="oda-mini-note" style={{ marginTop: 10 }}>다음에 추가하는 파일부터 적용합니다. 반영한 엑셀 설정은 매장·자료 출처별로 저장되어 다른 PC에서도 다음 달에 재사용합니다.</p>{savedProfile && <Button variant="ghost" disabled={disabled || checking} onClick={() => void resetProfile()}>저장한 양식 초기화</Button>}</details>
    <p className="oda-upload-note"><Info size={16} /><span>반영 전 미리보기로 확인합니다. PDF·사진은 증빙으로 보관하며 금액을 자동 인식하지 않습니다. 파일의 중복과 거래번호를 확인합니다.</span></p>
    {reading && <div className="oda-upload-progress" role="status" aria-live="polite"><progress value={readProgress.done} max={readProgress.total} aria-label="자료 확인 진행" /><span>{readProgress.total}개 중 {readProgress.done}개 확인</span></div>}
    {saveProgress && <div className="oda-upload-progress" role="status" aria-live="polite"><progress value={saveProgress.done} max={saveProgress.total} aria-label="자료 저장 진행" /><span>{saveProgress.total}개 중 {saveProgress.done}개 저장 완료 · 저장 중에는 창을 유지해 주세요.</span></div>}
    {localError && <div className="oda-error" style={{ margin: '0 24px 20px' }} role="alert">{localError}</div>}
    {files.length > 0 && <div className="oda-preview"><header><strong>반영 전 확인 · {files.length}개 파일</strong><button className="button button-ghost" aria-label="업로드 미리보기 닫기" disabled={busy || checking} onClick={() => setFiles([])}><X size={16} /></button></header>
      {files.map((file) => <div className="oda-preview-file" key={file.id}><div className="oda-preview-file-heading"><div><strong>{file.input.filename}</strong><p>{kinds[file.input.kind]} · {channelLabel(file.input.channel || '')} · <span className={file.error || file.preview?.errors.length ? 'oda-file-error' : 'oda-file-ready'}>{file.error || file.preview?.errors.length ? '수정 필요' : '반영 준비 완료'}</span></p></div><button className="button button-ghost" aria-label={`${file.input.filename} 업로드 목록에서 제거`} disabled={busy || checking} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={16} /></button></div>
        {file.error && <p className="oda-file-error">{file.error}</p>}
        {file.input.kind === 'evidence' ? <p>증빙으로 보관 · 손익 금액은 변동하지 않습니다.</p> : <><p>{file.preview?.lines.length ?? 0}건 반영 예정 · 중복 제외 {file.preview?.duplicateCount ?? 0}건{file.preview?.workbook && ` · 시트 ${file.preview.workbook.sheetName}`}</p>{file.preview?.errors.map((issue, i) => <p key={`e${i}`} className="oda-file-error">{issue.row ? `${issue.row}행 · ` : ''}{issue.message}</p>)}{file.preview?.warnings.slice(0, 3).map((issue, i) => <p key={`w${i}`} style={{ color: '#8b591f' }}>{issue.row ? `${issue.row}행 · ` : ''}{issue.message}</p>)}{file.preview?.workbook && <WorkbookMapping file={file} storeId={storeId} month={month} disabled={disabled || checking} onWorking={setMappingWorking} onUpdate={(next) => setFiles((current) => current.map((item) => item === file ? next : item))} />}<div className="oda-preview-lines">{file.preview?.lines.slice(0, 4).map((line, i) => <div key={i}><span>{line.date.slice(5)} · {line.description}</span><b>{money(line.amount)}</b></div>)}</div>{(file.preview?.lines.length ?? 0) > 4 && <p>외 {file.preview!.lines.length - 4}건은 저장 후 거래 내역에서 확인할 수 있습니다.</p>}</>}
      </div>)}<footer><span>{errorCount ? `수정 필요 ${errorCount}개는 남겨 두고 준비된 자료부터 반영할 수 있습니다.` : '확인 후 이번 달 정산에 저장합니다.'}</span><Button disabled={disabled || checking || !readyFiles.length} onClick={() => void saveReady()}>{busy ? '자료 저장 중…' : errorCount && readyFiles.length ? `준비된 ${readyFiles.length}개 자료 반영` : `${files.length}개 자료 반영`}<ArrowRight size={16} /></Button></footer></div>}
  </section>;
}

function LineRow({ line, sources, issues, disabled, storeId, month, onSave, onBankExpense }: { line: OdaLine; sources: OdaSource[]; issues: string[]; disabled: boolean; storeId: string; month: string; onSave: (changes: Record<string, unknown>) => Promise<boolean>; onBankExpense?: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(line.kind);
  const [category, setCategory] = useState(line.category || 'uncategorized');
  const [vat, setVat] = useState(line.vat === null ? '' : String(line.vat));
  const [note, setNote] = useState(line.note);
  const [sourceId, setSourceId] = useState(line.sourceId);
  const [approvalSourceId, setApprovalSourceId] = useState(line.approvalSourceId || '');
  const [amount, setAmount] = useState(String(line.amount));
  const [date, setDate] = useState(line.date);
  const [description, setDescription] = useState(line.description);
  const source = sources.find((item) => item.id === line.sourceId);
  const options = kind === 'excluded' ? exclusions : categories;
  const restoredKind = line.originalKind || (line.bankLineId ? 'expense' : source?.kind === 'bank' ? 'bank' : source?.kind === 'expense' || line.sourceRow === 0 ? 'expense' : 'revenue');
  const vatValid = vat === '' || /^-?\d+$/.test(vat);
  const expenseNeedsSource = kind === 'expense' && !sources.some(item => item.id === sourceId);
  async function save(reviewed: boolean) {
    if (!vatValid) return;
    const changes: Record<string, unknown> = { kind, category, vat: vat === '' ? null : Number(vat), reviewed, note, ...(sourceId !== line.sourceId ? { sourceId } : {}), ...(approvalSourceId ? { approvalSourceId } : {}) };
    if (line.sourceRow === 0) { if (Number(amount) !== line.amount) changes.amount = Number(amount); if (date !== line.date) changes.date = date; if (description !== line.description) changes.description = description; }
    if (await onSave(changes)) setOpen(false);
  }
  return <article className="oda-line"><div className="oda-line-top"><span className="oda-line-date">{line.date.slice(5).replace('-', '/')}</span><div className="oda-line-copy"><strong>{line.description}</strong><small>{kinds[line.kind]} · {line.kind === 'revenue' ? channelLabel(line.channel) : line.kind === 'bank' ? '손익에 합산하지 않음' : categoryLabel(line.category)}</small></div><b className="oda-line-amount">{money(line.amount)}</b><span className={`oda-badge ${line.reviewed && !issues.length ? 'green' : 'amber'}`}>{line.reviewed && !issues.length ? '확인 완료' : '확인 필요'}</span><button aria-label={`${line.description} 상세 ${open ? '닫기' : '열기'}`} aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={20} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button></div>
    {open && <div className="oda-line-edit">{issues.length > 0 && <div className="oda-notice" style={{ marginBottom: 16 }}>{issues.map((issue, i) => <p key={i}>{issue}</p>)}</div>}<div className="oda-form-grid"><label className="oda-field">손익 반영<select value={kind} disabled={disabled} onChange={(e) => { const next = e.target.value as OdaLine['kind']; setKind(next); if (next === 'excluded') setCategory('owner_transfer'); else setCategory(line.originalCategory || line.category); }}><option value={line.kind}>{kinds[line.kind]}</option>{line.kind !== 'excluded' && <option value="excluded">손익에서 제외</option>}{line.kind === 'excluded' && <option value={restoredKind}>{kinds[restoredKind]}로 복구</option>}</select></label><label className="oda-field">{line.kind === 'bank' ? '비용 반영 시 분류' : '분류'}<select value={category} disabled={disabled || line.kind === 'revenue' && kind !== 'excluded'} onChange={(e) => setCategory(e.target.value)}><option value="uncategorized">분류를 선택하세요</option>{!options.some((item) => item.value === category) && category !== 'uncategorized' && <option value={category}>{categoryLabel(category)}</option>}{options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="oda-field">금액에 포함된 부가세<input type="text" inputMode="numeric" value={vat} disabled={disabled} onChange={(e) => setVat(e.target.value.replaceAll(',', ''))} placeholder="모르면 비워두기 · 면세는 0" aria-invalid={!vatValid} /><small>세금계산서·영수증의 실제 부가세액을 입력합니다.</small></label>{!line.sourceId && <label className="oda-field">이번 달 증빙 연결<select value={sourceId} disabled={disabled} onChange={(e) => setSourceId(e.target.value)}><option value="">증빙을 선택하세요</option>{sources.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select></label>}{line.sourceRow === 0 && <><label className="oda-field">실제 금액<input type="number" value={amount} disabled={disabled} onChange={(e) => setAmount(e.target.value)} /></label><label className="oda-field">귀속일<input type="date" value={date} disabled={disabled} onChange={(e) => setDate(e.target.value)} /></label><label className="oda-field full">거래 내용<input value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} /></label></>}{category === 'capex' && <label className="oda-field full">B 사전 서면 동의 자료<select value={approvalSourceId} disabled={disabled} onChange={(e) => setApprovalSourceId(e.target.value)}><option value="">서면 동의 증빙 선택</option>{sources.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select></label>}<label className="oda-field full">확인 메모<input value={note} disabled={disabled} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="분류·제외 사유 등 확인 내용" /></label></div><div className="oda-line-source">{source ? <><a href={odaUrl(storeId, month, `/evidence/${encodeURIComponent(source.id)}`)}><FileCheck2 size={15} />{source.fileName}</a>{line.sourceRow > 0 && <>원본 {line.sourceRow}행</>}</> : '원본 증빙 연결이 필요합니다.'}{line.externalId && <><br />거래번호 {line.externalId}</>}</div>{expenseNeedsSource && <p className="oda-mini-note">이번 달 증빙을 연결하면 확인 완료할 수 있습니다.</p>}<div className="oda-line-actions">{line.kind === 'bank' && line.amount < 0 && onBankExpense && <Button variant="secondary" disabled={disabled || !vatValid || !categories.some((item) => item.value === category)} onClick={() => void onBankExpense({ bankLineId: line.id, category, vat: vat === '' ? null : Number(vat), note }).then((saved) => { if (saved) setOpen(false); })}>출금 {money(-line.amount)} 비용으로 반영</Button>}<Button variant="secondary" disabled={disabled || !vatValid} onClick={() => void save(false)}>수정만 저장</Button><Button disabled={disabled || !vatValid || expenseNeedsSource} onClick={() => void save(true)}><Check size={16} />확인 완료</Button></div></div>}
  </article>;
}

function ManualExpense({ month, sources, busy, onSave, initialSourceId = '' }: { initialSourceId?: string; month: string; sources: OdaSource[]; busy: boolean; onSave: (line: Record<string, unknown>) => Promise<void> }) {
  const [date, setDate] = useState(today().startsWith(month) ? today() : `${month}-01`);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [vat, setVat] = useState('');
  const [category, setCategory] = useState('ingredients');
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [note, setNote] = useState('');
  const [approvalSourceId, setApprovalSourceId] = useState('');
  const isExcluded = exclusions.some((item) => item.value === category);
  const valid = description.trim().length > 0 && /^-?\d+$/.test(amount) && (vat === '' || /^-?\d+$/.test(vat)) && date.startsWith(month);
  return <form className="oda-card-body" onSubmit={(e) => { e.preventDefault(); if (valid) void onSave({ date, description: description.trim(), amount: Number(amount), vat: vat === '' ? null : Number(vat), category, kind: isExcluded ? 'excluded' : 'expense', sourceId, reviewed: false, note, ...(approvalSourceId ? { approvalSourceId } : {}) }); }}><div className="oda-form-grid"><label className="oda-field">귀속일<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label><label className="oda-field">비용 분류<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}<optgroup label="월 손익에서 제외">{exclusions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup></select></label><label className="oda-field full">거래 내용<input value={description} maxLength={500} placeholder="예: 9월 가스요금" onChange={(e) => setDescription(e.target.value)} required /></label><label className="oda-field">결제 금액<input type="text" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replaceAll(',', ''))} placeholder="부가세 포함 총액" required /></label><label className="oda-field">포함된 부가세<input type="text" inputMode="numeric" value={vat} onChange={(e) => setVat(e.target.value.replaceAll(',', ''))} placeholder="모르면 비워두기 · 면세는 0" /></label><label className="oda-field full">원본 증빙<select value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">나중에 연결 · 확정 전 필수</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label>{category === 'capex' && <label className="oda-field full">B 사전 서면 동의 증빙<select value={approvalSourceId} onChange={(e) => setApprovalSourceId(e.target.value)}><option value="">서면 동의 자료 선택</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label>}<label className="oda-field full">메모<input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="확인에 필요한 내용" /></label></div><div className="oda-line-actions"><Button type="submit" disabled={busy || !valid}><Plus size={16} /> 비용 추가</Button></div></form>;
}

function AuditEvent({ event, actorName }: { event: NonNullable<OdaResponse['audit']>[number]; actorName: string }) {
  const changes = event.metadata.lineChanges ?? [];
  return <article className="oda-history-event"><header><strong>{event.action}</strong><small>{dateTime(event.at)} · {actorName}</small></header>{changes.length > 0 && <details><summary className="oda-quiet-link">변경된 거래 {changes.length}건 보기</summary>{changes.slice(0, 30).map(({ before, after }) => <div key={after.id} style={{ marginTop: 13 }}><strong>{after.description}</strong><p style={{ fontSize: 14 }}>{before ? <>{money(before.amount)} → {money(after.amount)}<br />{categoryLabel(before.category)} → {categoryLabel(after.category)} · {before.reviewed ? '확인 완료' : '확인 대기'} → {after.reviewed ? '확인 완료' : '확인 대기'}{before.note !== after.note && <><br />메모: {after.note || '(삭제)'}</>}</> : <>{kinds[after.kind]} {money(after.amount)} 추가 · {categoryLabel(after.category)}</>}</p></div>)}{changes.length > 30 && <p className="oda-mini-note">외 {changes.length - 30}건의 변경이 함께 기록되었습니다.</p>}</details>}</article>;
}

function WorkbookMapping({ file, storeId, month, disabled, onUpdate, onWorking }: { file: PendingFile; storeId: string; month: string; disabled: boolean; onWorking: (working: boolean) => void; onUpdate: (file: PendingFile) => void }) {
  const [mapping, setMapping] = useState<Record<string, string>>(file.input.columnMap || {});
  const [sheet, setSheet] = useState(file.preview?.workbook?.sheetName || '');
  const [working, setWorking] = useState(false);
  const fields = [{ value: 'date', label: '귀속일' }, { value: 'description', label: '거래 내용' }, { value: 'amount', label: '결제 총액' }, { value: 'creditAmount', label: '은행 입금액' }, { value: 'debitAmount', label: '은행 출금액' }, { value: 'vat', label: '포함된 부가세' }, { value: 'category', label: '비용 분류' }, { value: 'channel', label: '판매 채널' }, { value: 'externalId', label: '거래번호' }, { value: 'feeAmount', label: '플랫폼 수수료' }, { value: 'feeVat', label: '수수료 부가세' }, { value: 'payoutAmount', label: '플랫폼 정산 예정액' }];
  async function apply() {
    setWorking(true); onWorking(true);
    const input = { ...file.input, sheetName: sheet, columnMap: Object.fromEntries(Object.entries(mapping).filter(([, value]) => value)) };
    try { const preview = await previewOdaImport(storeId, month, input); onUpdate({ ...file, input, preview, error: undefined }); }
    catch (e) { onUpdate({ ...file, error: e instanceof Error ? e.message : '열을 연결하지 못했습니다.' }); }
    finally { setWorking(false); onWorking(false); }
  }
  return <details style={{ marginTop: 12 }}><summary className="oda-quiet-link">내 파일의 열 이름 연결</summary><p>열 이름이 달라도 원본 파일을 수정할 필요 없이 연결할 수 있습니다.</p>{(file.preview?.workbook?.sheetNames.length ?? 0) > 1 && <label className="oda-field" style={{ marginTop: 12 }}>가져올 시트<select value={sheet} disabled={disabled || working} onChange={(e) => setSheet(e.target.value)}>{file.preview!.workbook!.sheetNames.map((name) => <option key={name}>{name}</option>)}</select></label>}<div className="oda-form-grid" style={{ marginTop: 13 }}>{fields.map((field) => <label key={field.value} className="oda-field">{field.label}<select value={mapping[field.value] || ''} disabled={disabled || working} onChange={(e) => setMapping({ ...mapping, [field.value]: e.target.value })}><option value="">열 이름 자동 확인</option>{file.preview?.workbook?.headers.filter(Boolean).map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div><Button style={{ marginTop: 14 }} variant="secondary" disabled={disabled || working} onClick={() => void apply()}>{working ? '확인 중…' : '연결하고 미리보기 다시 확인'}</Button></details>;
}
