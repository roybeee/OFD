import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarCheck, Check, ChevronRight, CircleCheckBig, FileCheck2, LockKeyhole, Send, ShieldCheck, UserCheck, X } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, Invoice, ModificationReasonCode, MonthlySettlementSummary, SettlementItem } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { approveInvoiceV2, approveSettlementV2, draftInvoiceV2, draftSettlementV2, loadMonthlySettlementV2, modifyInvoiceV2, newIdempotencyKey, retryInvoiceV2, reviewInvoiceV2, reviewSettlementV2 } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;
const modificationReasons: Array<{ code: ModificationReasonCode; label: string }> = [
  { code: '03', label: '환입' }, { code: '04', label: '계약 해제' }, { code: '06', label: '착오에 의한 이중발급' },
];

export function HqInvoicesPage({ data, notify, refresh }: { data: BootstrapData; notify: Notify; refresh: () => void }) {
  const [invoices, setInvoices] = useState(data.invoices);
  const [settlements, setSettlements] = useState(data.settlements);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [filter, setFilter] = useState<'all' | 'draft' | 'reviewed' | 'failed' | 'nts_success'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ storeId: data.stores[0]?.id ?? '', periodStart: '', periodEnd: '' });
  const currentMonth = (data.meta.operationalDate ?? data.generatedAt).slice(0, 7);
  const [summaryMonth, setSummaryMonth] = useState(currentMonth);
  const [summary, setSummary] = useState<MonthlySettlementSummary | null>(null);
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    setSummaryState('loading');
    loadMonthlySettlementV2(summaryMonth)
      .then((result) => { if (!cancelled) { setSummary(result); setSummaryState('ready'); } })
      .catch(() => { if (!cancelled) setSummaryState('error'); });
    return () => { cancelled = true; };
  }, [summaryMonth, data.generatedAt]);
  useEffect(() => {
    setInvoices(data.invoices); setSettlements(data.settlements);
    setSelected((current) => current ? data.invoices.find((invoice) => invoice.id === current.id) ?? null : null);
  }, [data.invoices, data.settlements]);

  const finance = data.actor.role === 'hq_finance' && data.capabilities.includes('hq.settlements.manage');
  const master = data.actor.role === 'hq_master' && data.capabilities.includes('hq.settlements.approve');
  const canDraftSettlement = data.capabilities.includes('hq.settlements.draft');
  const reviewed = invoices.filter((invoice) => invoice.status === 'reviewed');
  const visibleInvoices = filter === 'all' ? invoices : invoices.filter((invoice) => invoice.status === filter);
  const totalGross = invoices.reduce((sum, invoice) => sum + invoice.grossAmount, 0);
  const queued = invoices.filter((invoice) => ['approved', 'queued', 'issued', 'nts_pending'].includes(invoice.status)).length;
  const sent = invoices.filter((invoice) => invoice.status === 'nts_success').length;
  const deadline = useMemo(() => invoiceDeadline(invoices), [invoices]);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(key);
    try { await action(); notify(success, 'success'); setSelected(null); refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : '업무 처리에 실패했습니다.', 'warning'); }
    finally { setBusy(null); }
  }

  async function createSettlement(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.storeId || !draft.periodStart || !draft.periodEnd || draft.periodStart > draft.periodEnd) { notify('매장과 올바른 정산 기간을 입력해 주세요.', 'warning'); return; }
    await run('settlement:new', () => draftSettlementV2(draft, newIdempotencyKey()), '정산 초안과 결제 요청을 생성했습니다.');
  }

  function settlementAction(settlement: SettlementItem) {
    if (settlement.status === 'draft' && finance) return <Button disabled={Boolean(busy)} onClick={() => run(`settlement:${settlement.id}`, () => reviewSettlementV2(settlement.id, settlement.version, newIdempotencyKey()), `${settlement.storeName} 정산을 검토 완료했습니다.`)}>재무 검토 완료</Button>;
    if (settlement.status === 'draft' && master) return <span className="drawer-action-note">재무 검토 대기 — 재무 계정에서 검토를 완료해야 승인 단계로 넘어갑니다.</span>;
    if (settlement.status === 'reviewed' && master) return <Button disabled={Boolean(busy) || settlement.reviewedBy === data.actor.id} onClick={() => run(`settlement:${settlement.id}`, () => approveSettlementV2(settlement.id, settlement.version, newIdempotencyKey()), `${settlement.storeName} 정산을 최종 승인했습니다.`)}>마스터 승인</Button>;
    if (settlement.status === 'approved' && finance && !invoices.some((invoice) => invoice.settlementId === settlement.id)) return <Button disabled={Boolean(busy)} onClick={() => run(`invoice:new:${settlement.id}`, () => draftInvoiceV2(settlement.id, newIdempotencyKey()), `${settlement.storeName} 증빙 초안을 생성했습니다.`)}>계산서 초안 생성</Button>;
    return null;
  }

  return (
    <main id="main-content" data-testid="hq-invoice-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading"><div><p className="eyebrow"><span /> HQ FINANCE</p><h1>정산·세금계산서</h1><p>정산 초안부터 검토·승인·발행 실패 재처리까지 한 흐름으로 관리합니다.</p></div><div className="heading-tools"><span className="deadline-badge"><CalendarCheck size={17} /> {deadline.label}</span></div></section>
      <section className="closing-progress" aria-labelledby="closing-title"><div className="closing-copy"><span className="hero-kicker"><LockKeyhole size={15} /> MAKER–CHECKER</span><h2 id="closing-title">재무 검토와 마스터 승인을 분리합니다</h2><p>재무 담당자가 초안과 검토를 맡고, 마스터가 다른 계정으로 최종 승인합니다.</p></div><ol><li className={settlements.length ? 'done' : 'active'}><span>{settlements.length ? <Check size={16} /> : 1}</span><div><strong>정산 초안</strong><small>{settlements.length}건</small></div></li><li className={settlements.some((item) => item.status === 'reviewed') ? 'active' : ''}><span>2</span><div><strong>재무 검토</strong><small>{settlements.filter((item) => item.status === 'reviewed').length}건 승인 대기</small></div></li><li className={reviewed.length ? 'active' : ''}><span>3</span><div><strong>마스터 승인</strong><small>계산서 {reviewed.length}건</small></div></li><li className={sent > 0 ? 'done' : ''}><span>{sent > 0 ? <Check size={16} /> : 4}</span><div><strong>발행·전송</strong><small>{sent}건 국세청 완료</small></div></li></ol></section>
      <section className="metrics-grid"><MetricCard label="총 청구액" value={formatMoney(totalGross)} detail={`${invoices.length}개 증빙 · VAT 포함`} icon={<FileCheck2 size={21} />} /><MetricCard label="승인 필요" value={`${reviewed.length}건`} detail="마스터 승인 대기" icon={<UserCheck size={21} />} tone="red" /><MetricCard label="발행 대기" value={`${queued}건`} detail="외부 발행 처리 중" icon={<Send size={21} />} tone="orange" /><MetricCard label="국세청 전송 완료" value={`${sent}건`} detail={`실패 ${invoices.filter((invoice) => invoice.status === 'failed').length}건`} icon={<CircleCheckBig size={21} />} tone="green" /></section>

      <section className="panel monthly-panel" aria-labelledby="monthly-title" data-testid="monthly-settlement-panel">
        <div className="panel-heading"><div><span className="section-number">01</span><div><h2 id="monthly-title">월별 정산 집계</h2><p>공급 매출(검수 확정 입고) · 매장 매출(POS 실측) · 로스율을 매장별로 합산합니다.</p></div></div>
          <label className="compact-select">귀속월 <input type="month" value={summaryMonth} max={currentMonth} onChange={(event) => setSummaryMonth(event.target.value || currentMonth)} aria-label="정산 귀속월" /></label></div>
        {summaryState === 'loading' && <p className="panel-empty-copy">집계 중…</p>}
        {summaryState === 'error' && <p className="panel-empty-copy">월별 집계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
        {summaryState === 'ready' && summary && <div className="table-wrap"><table className="data-table"><thead><tr>
          <th scope="col">매장</th><th scope="col">구분</th><th scope="col" className="num">공급 매출(확정 입고)</th><th scope="col" className="num">매장 매출(POS)</th><th scope="col" className="num">공급/매출</th><th scope="col" className="num">로스율</th><th scope="col">정산·계산서</th></tr></thead>
          <tbody>
            {summary.rows.map((row) => <tr key={row.storeId}>
              <td className="strong">{row.name}</td>
              <td>{row.storeKind ?? <span className="muted">미지정</span>}</td>
              <td className="num">{formatMoney(row.supplyConfirmed)}{row.receiptCount > 0 && <small className="muted"> · 입고 {row.receiptCount}건</small>}</td>
              <td className="num">{formatMoney(row.posRevenue)}{row.posQty > 0 && <small className="muted"> · {row.posQty.toLocaleString('ko-KR')}개</small>}</td>
              <td className="num muted">{row.supplyToPosPct === null ? '—' : `${row.supplyToPosPct.toFixed(1)}%`}</td>
              <td className={`num ${row.lossRate === null ? 'muted' : row.lossRate >= 8 ? 'tone-red' : 'tone-green'}`}>{row.lossRate === null ? '—' : `${row.lossRate.toFixed(1)}%`}</td>
              <td>{row.settlementCount === 0 ? <span className="muted">정산 없음</span>
                : <span>정산 {row.settlementCount}건 · {formatMoney(row.settledGross)}{row.invoiceSummary.total > 0 && <small className="muted"> · 계산서 {row.invoiceSummary.ntsSuccess}/{row.invoiceSummary.total} 전송</small>}{row.invoiceSummary.failed > 0 && <small className="tone-red"> · 실패 {row.invoiceSummary.failed}</small>}</span>}</td>
            </tr>)}
            {summary.rows.length === 0 && <tr><td colSpan={7} className="muted">등록된 매장이 없습니다. 매출현황 탭에서 매장을 먼저 등록해 주세요.</td></tr>}
            {summary.rows.length > 0 && <tr>
              <th scope="row" className="strong">합계</th><td />
              <td className="num strong">{formatMoney(summary.totals.supplyConfirmed)}</td>
              <td className="num strong">{formatMoney(summary.totals.posRevenue)}</td><td />
              <td className={`num ${summary.totals.lossRate === null ? 'muted' : 'strong'}`}>{summary.totals.lossRate === null ? '—' : `${summary.totals.lossRate.toFixed(1)}%`}</td>
              <td className="muted">정산 {summary.totals.settlementCount}건 · {formatMoney(summary.totals.settledGross)}</td>
            </tr>}
          </tbody></table></div>}
        <p className="muted">공급 매출은 검수 확정된 입고 원장 합계(V1 정산의 출고·완료 발주 합계에 해당)이고, 매장 매출은 토스플레이스 POS 실측입니다. 로스율(입고−판매)은 입고 기록이 있는 달에만 계산되며 없으면 —로 표시합니다.</p>
      </section>

      <section className="panel settlement-panel" aria-labelledby="settlement-title"><div className="panel-heading"><div><span className="section-number">02</span><div><h2 id="settlement-title">정산 수명주기</h2><p>확정 입고 원장을 정산 초안으로 묶고 재무 검토·마스터 승인을 거칩니다.</p></div></div></div>
        {canDraftSettlement && data.actor.role === 'hq_master' && <p className="muted" style={{ padding: '0 17px' }}>작성-검토-승인 분리: 마스터가 초안을 만들면 <strong>재무 검토는 재무 계정</strong>에서 진행합니다. 재무 담당 계정은 계정 관리 탭에서 추가할 수 있습니다.</p>}
        {canDraftSettlement && <form className="settlement-draft-form" onSubmit={createSettlement} aria-label="정산 초안 생성"><label>매장<select value={draft.storeId} onChange={(event) => setDraft((current) => ({ ...current, storeId: event.target.value }))} required><option value="">매장 선택</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label>시작일<input type="date" value={draft.periodStart} onChange={(event) => setDraft((current) => ({ ...current, periodStart: event.target.value }))} required /></label><label>종료일<input type="date" value={draft.periodEnd} min={draft.periodStart} onChange={(event) => setDraft((current) => ({ ...current, periodEnd: event.target.value }))} required /></label><Button type="submit" disabled={Boolean(busy)}>{busy === 'settlement:new' ? '생성 중…' : '정산 초안 생성'}</Button></form>}
        <div className="settlement-list">{settlements.map((settlement) => <article className="settlement-card" key={settlement.id}><div><small>{settlement.periodStart} – {settlement.periodEnd}</small><strong>{settlement.storeName}</strong><span>{settlement.receiptIds.length}건 입고 · {formatMoney(settlement.grossAmount)}</span></div><div className="maker-summary"><span>검토 {settlement.reviewedByName ?? '대기'}</span><span>승인 {settlement.approvedByName ?? '대기'}</span></div><StatusBadge status={settlement.status} />{settlementAction(settlement)}</article>)}{settlements.length === 0 && <p className="panel-empty-copy">생성된 정산이 없습니다. 정산 초안은 확정 입고(발주 → 출고 → 검수 확정) 원장에서 만들어집니다 — 아직 V2 발주 흐름의 입고가 없다면 위 월별 집계의 POS 실측부터 확인하실 수 있습니다.</p>}</div>
      </section>

      <section className="panel invoice-panel" aria-labelledby="invoice-title"><div className="queue-toolbar"><div><h2 id="invoice-title">세금계산서 수명주기</h2><p>수정 발행과 실패 재시도 이력도 원본 상태 그대로 표시합니다.</p></div><label className="compact-select">상태 <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">전체 상태</option><option value="draft">검토 전</option><option value="reviewed">승인 필요</option><option value="failed">발행 실패</option><option value="nts_success">전송 완료</option></select></label></div><div className="invoice-list"><div className="invoice-list-head"><span>매장 / 귀속월</span><span>공급가액</span><span>세액</span><span>합계</span><span>상태</span><span /></div>{visibleInvoices.map((invoice) => <button className="invoice-row" type="button" key={invoice.id} onClick={() => setSelected(invoice)}><span><strong>{invoice.storeName}</strong><small>{invoice.period} · {invoice.preparedBy} 작성</small>{invoice.issueType === 'modified' && <em>수정계산서 · 사유 {invoice.modificationReasonCode}</em>}{invoice.sameBusinessNumber && <em>동일 사업자번호 · 내부 명세서</em>}{invoice.failureReason && <em className="invoice-error">실패: {invoice.failureReason}</em>}</span><span data-label="공급가액">{formatMoney(invoice.supplyAmount)}</span><span data-label="세액">{formatMoney(invoice.vatAmount)}</span><span data-label="합계"><strong>{formatMoney(invoice.grossAmount)}</strong></span><span data-label="상태"><StatusBadge status={invoice.status} /></span><span><ChevronRight size={20} /></span></button>)}{visibleInvoices.length === 0 && <p className="panel-empty-copy">이 상태의 계산서가 없습니다.</p>}</div></section>
      <section className="safety-strip"><ShieldCheck size={25} /><div><strong>{data.meta.providerMode === 'production' && data.meta.externalIssueEnabled ? '외부 계산서 발행 연결됨' : '외부 계산서 발행 비활성화'}</strong><p>발행 요청·실패·재시도는 모두 서버 감사 기록에 남습니다.</p></div><span className="safe-mode">{data.meta.providerMode === 'production' && data.meta.externalIssueEnabled ? 'PRODUCTION ENABLED' : 'EXTERNAL ISSUE DISABLED'}</span></section>
      {selected && <InvoiceLifecycleDrawer invoice={selected} actor={data.actor} finance={finance} master={master} canRetryInvoice={data.capabilities.includes('hq.invoices.retry')} busy={busy} onClose={() => setSelected(null)} onRun={run} />}
    </main>
  );
}

function InvoiceLifecycleDrawer({ invoice, actor, finance, master, canRetryInvoice, busy, onClose, onRun }: { invoice: Invoice; actor: BootstrapData['actor']; finance: boolean; master: boolean; canRetryInvoice: boolean; busy: string | null; onClose: () => void; onRun: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [reasonCode, setReasonCode] = useState<ModificationReasonCode>('03');
  const dialogRef = useAccessibleDialog(onClose);
  const canReview = finance && invoice.status === 'draft';
  const canApprove = master && invoice.status === 'reviewed' && invoice.reviewedBy !== actor.id;
  const canModify = finance && invoice.status === 'nts_success' && invoice.issueType !== 'internal_statement';
  const canRetry = canRetryInvoice && invoice.status === 'failed';
  return <div className="drawer-backdrop" role="presentation"><aside ref={dialogRef} tabIndex={-1} className="review-drawer invoice-drawer" role="dialog" aria-modal="true" aria-labelledby="invoice-review-title"><header><div><span className="drawer-kicker">계산서 수명주기</span><h2 id="invoice-review-title">{invoice.storeName} · {invoice.period}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="계산서 상세 닫기" onClick={onClose}><X size={22} /></button></header><div className="drawer-body">{invoice.failureReason && <div className="risk-box"><AlertCircle size={20} /><div><strong>발행 실패</strong><p>{invoice.failureReason}</p><small>재시도 {invoice.retryCount ?? 0}회{invoice.lastRetriedAt ? ` · 최근 ${invoice.lastRetriedAt}` : ''}</small></div></div>}<section className="invoice-paper"><div className="paper-title"><span>{invoice.issueType === 'modified' ? '수정 전자세금계산서' : invoice.sameBusinessNumber ? '내부거래 명세서' : '전자세금계산서'}</span><StatusBadge status={invoice.status} /></div><div className="business-grid"><div><small>공급자</small><strong>{invoice.supplierName || '공급자 정보 확인 필요'}</strong><span>사업자 {formatBusinessNumber(invoice.supplierBusinessNumber)}</span></div><div><small>공급받는 자</small><strong>{invoice.recipientName || invoice.storeName}</strong><span>사업자 {formatBusinessNumber(invoice.recipientBusinessNumber)}</span></div></div><dl><div><dt>작성일자</dt><dd>{formatIssueDate(invoice.issueDate)}</dd></div><div><dt>공급가액</dt><dd>{formatMoney(invoice.supplyAmount)}</dd></div><div><dt>부가세</dt><dd>{formatMoney(invoice.vatAmount)}</dd></div><div className="total"><dt>합계</dt><dd>{formatMoney(invoice.grossAmount)}</dd></div></dl></section><section className="maker-checker"><h3>작성·검토·승인 분리</h3><div><span><small>작성</small><strong>{invoice.preparedBy}</strong><em><Check size={13} /> {invoice.preparedAt ?? '작성 완료'}</em></span><span className="separation-line" /><span><small>재무 검토</small><strong>{invoice.reviewedByName ?? '대기'}</strong><em>{invoice.reviewedAt ?? '검토 전'}</em></span><span className="separation-line" /><span><small>마스터 승인</small><strong>{invoice.approvedByName ?? '대기'}</strong><em>{invoice.approvedAt ?? '승인 전'}</em></span></div><p>현재 로그인: {actor.name} · {actor.role}</p></section>{canModify && <label className="lifecycle-reason">수정 사유<select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as ModificationReasonCode)}>{modificationReasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.code} · {reason.label}</option>)}</select><small>원본과 반대 부호의 수정계산서 초안을 생성합니다.</small></label>}</div><footer><Button variant="secondary" onClick={onClose}>닫기</Button>{canReview && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:review:${invoice.id}`, () => reviewInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '계산서 검토를 완료했습니다.')}>재무 검토 완료</Button>}{canApprove && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:approve:${invoice.id}`, () => approveInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '계산서를 최종 승인했습니다.')}><ShieldCheck size={18} /> 마스터 승인</Button>}{canModify && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:modify:${invoice.id}`, () => modifyInvoiceV2(invoice.id, reasonCode, newIdempotencyKey()), '수정 세금계산서 초안을 생성했습니다.')}>수정계산서 생성</Button>}{canRetry && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:retry:${invoice.id}`, () => retryInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '발행 재시도를 대기열에 등록했습니다.')}>발행 재시도</Button>}{!canReview && !canApprove && !canModify && !canRetry && <span className="drawer-action-note">현재 역할 또는 상태에서 가능한 작업이 없습니다.</span>}</footer></aside></div>;
}

function formatBusinessNumber(value?: string) { const digits = (value ?? '').replace(/\D/g, ''); return /^\d{10}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : '정보 없음'; }
function formatIssueDate(value?: string) { if (!value) return '작성일 미정'; const date = new Date(`${value.slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date); }
function invoiceDeadline(invoices: Invoice[]) { const dueDate = invoices.map((invoice) => invoice.dueDate).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().at(0); if (!dueDate) return { label: '발급기한은 문서 생성 후 표시됩니다' }; const deadline = new Date(`${dueDate}T23:59:59`); const days = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000); return { label: `법정 발급기한 ${new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(deadline)} · ${days >= 0 ? `D-${days}` : `${Math.abs(days)}일 경과`}` }; }
