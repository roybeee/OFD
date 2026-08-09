import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, ChevronRight, Clock3, RefreshCcw, Send, ShieldCheck, UserCheck, X } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, Invoice, ModificationReasonCode, MonthlySettlementSummary, SettlementItem } from '../types';
import { Button, StatusBadge } from '../components/ui';
import { approveInvoiceV2, approveSettlementV2, draftInvoiceV2, draftSettlementV2, loadMonthlySettlementV2, modifyInvoiceV2, newIdempotencyKey, retryInvoiceV2, reviewInvoiceV2, reviewSettlementV2 } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;
type QueueKey = 'failed' | 'reviewed' | 'draft' | 'nts_success';
/** 정산·계산서를 한 축으로 합친 원장 항목. 정산만 있는 건, 계산서만 있는 건도 같은 줄에서 다룬다. */
type LedgerEntry = { key: string; settlement?: SettlementItem; invoices: Invoice[] };

const modificationReasons: Array<{ code: ModificationReasonCode; label: string }> = [
  { code: '03', label: '환입' }, { code: '04', label: '계약 해제' }, { code: '06', label: '착오에 의한 이중발급' },
];

/** 초안 → 검토 → 승인 → 전송. 정산 상태와 계산서 상태를 하나의 4단계 축으로 정규화한다. */
const lifecycleSteps = ['초안', '검토', '승인', '전송'] as const;
type StageTone = 'done' | 'now' | 'fail' | 'idle';

function entryStage(entry: LedgerEntry): { step: number; tone: StageTone; label: string } {
  const invoice = primaryInvoice(entry);
  if (invoice) {
    if (invoice.status === 'failed') return { step: 4, tone: 'fail', label: '발행 실패 · 재시도 필요' };
    if (invoice.status === 'nts_success') return { step: 4, tone: 'done', label: '국세청 전송 완료' };
    if (invoice.status === 'internal_statement') return { step: 4, tone: 'done', label: '내부거래 명세 확정' };
    if (invoice.status === 'draft') return { step: 2, tone: 'now', label: '계산서 재무 검토 대기' };
    if (invoice.status === 'reviewed') return { step: 3, tone: 'now', label: '계산서 마스터 승인 대기' };
    return { step: 4, tone: 'now', label: '국세청 전송 처리 중' };
  }
  const settlement = entry.settlement;
  if (!settlement) return { step: 1, tone: 'idle', label: '상태 확인 필요' };
  if (settlement.status === 'draft' || settlement.status === 'open') return { step: 2, tone: 'now', label: '정산 재무 검토 대기' };
  if (settlement.status === 'reviewed') return { step: 3, tone: 'now', label: '정산 마스터 승인 대기' };
  return { step: 4, tone: 'idle', label: '계산서 초안 생성 대기' };
}

function documentLabel(invoice: Invoice) {
  if (invoice.issueType === 'modified') return '수정 전자세금계산서';
  if (invoice.sameBusinessNumber || invoice.issueType === 'internal_statement') return '내부거래 명세서';
  return '전자세금계산서';
}

function primaryInvoice(entry: LedgerEntry) {
  return entry.invoices.find((invoice) => invoice.status === 'failed')
    ?? entry.invoices.find((invoice) => invoice.status === 'reviewed' || invoice.status === 'draft')
    ?? entry.invoices[0];
}

function matchesQueue(entry: LedgerEntry, key: QueueKey) {
  const settlement = entry.settlement;
  if (key === 'failed') return entry.invoices.some((invoice) => invoice.status === 'failed');
  if (key === 'nts_success') return entry.invoices.some((invoice) => invoice.status === 'nts_success');
  if (key === 'reviewed') return settlement?.status === 'reviewed' || entry.invoices.some((invoice) => invoice.status === 'reviewed');
  return settlement?.status === 'draft' || settlement?.status === 'open' || entry.invoices.some((invoice) => invoice.status === 'draft');
}

export function HqInvoicesPage({ data, notify, refresh }: { data: BootstrapData; notify: Notify; refresh: () => void }) {
  const [invoices, setInvoices] = useState(data.invoices);
  const [settlements, setSettlements] = useState(data.settlements);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [queue, setQueue] = useState<QueueKey | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dense, setDense] = useState(false);
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
  const totalGross = invoices.reduce((sum, invoice) => sum + invoice.grossAmount, 0);
  const queued = invoices.filter((invoice) => ['approved', 'queued', 'issued', 'nts_pending'].includes(invoice.status)).length;
  const sent = invoices.filter((invoice) => invoice.status === 'nts_success').length;
  const failed = invoices.filter((invoice) => invoice.status === 'failed');
  const drafting = invoices.filter((invoice) => invoice.status === 'draft').length + settlements.filter((item) => item.status === 'draft' || item.status === 'open').length;
  const reviewedSettlements = settlements.filter((item) => item.status === 'reviewed');
  const awaitingApproval = reviewed.length + reviewedSettlements.length;
  const awaitingAmount = reviewed.reduce((sum, invoice) => sum + invoice.grossAmount, 0) + reviewedSettlements.reduce((sum, item) => sum + item.grossAmount, 0);
  const deadline = useMemo(() => invoiceDeadline(invoices), [invoices]);

  const entries = useMemo<LedgerEntry[]>(() => {
    const linked = new Set<string>();
    const rows: LedgerEntry[] = settlements.map((settlement) => {
      const own = invoices.filter((invoice) => invoice.settlementId === settlement.id);
      own.forEach((invoice) => linked.add(invoice.id));
      return { key: `settlement:${settlement.id}`, settlement, invoices: own };
    });
    invoices.filter((invoice) => !linked.has(invoice.id)).forEach((invoice) => rows.push({ key: `invoice:${invoice.id}`, invoices: [invoice] }));
    return rows;
  }, [settlements, invoices]);
  const visibleEntries = queue ? entries.filter((entry) => matchesQueue(entry, queue)) : entries;

  /** 일괄 승인 대상: 마스터가 다른 계정의 검토를 승인하는 건만. */
  const bulkTargets = settlements.filter((settlement) => master && settlement.status === 'reviewed' && settlement.reviewedBy !== data.actor.id);
  const pickedTargets = bulkTargets.filter((settlement) => picked.includes(settlement.id));
  useEffect(() => { setPicked((current) => current.filter((id) => bulkTargets.some((settlement) => settlement.id === id))); }, [settlements, data.actor.id]);

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

  /** 선택한 정산을 순차 승인한다. 실패한 건은 선택 상태로 남겨 재시도할 수 있게 한다. */
  async function approvePicked() {
    if (busy || pickedTargets.length === 0) return;
    setBusy('settlement:bulk');
    const remaining: string[] = [];
    let done = 0;
    for (const settlement of pickedTargets) {
      try { await approveSettlementV2(settlement.id, settlement.version, newIdempotencyKey()); done += 1; }
      catch { remaining.push(settlement.id); }
    }
    setPicked(remaining);
    setBusy(null);
    if (done > 0) notify(`정산 ${done}건을 최종 승인했습니다.${remaining.length ? ` ${remaining.length}건은 실패해 선택에 남겨 두었습니다.` : ''}`, remaining.length ? 'warning' : 'success');
    else notify('선택한 정산을 승인하지 못했습니다.', 'warning');
    refresh();
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
      <section className="page-heading hq-heading">
        <div>
          <p className="eyebrow"><span /> HQ FINANCE</p>
          <h1>정산·세금계산서</h1>
          <p>매장 한 곳이 한 줄입니다. 정산 초안 → 재무 검토 → 마스터 승인 → 국세청 전송까지 한 항목에서 확인하고 처리합니다.</p>
        </div>
        <div className="heading-tools"><DeadlineMeter deadline={deadline} pending={failed.length + awaitingApproval} /></div>
      </section>

      <section className="work-queue" aria-label="지금 처리할 작업">
        <QueueCard tone="red" icon={<AlertTriangle size={17} />} label="발행 실패 · 재처리" count={failed.length}
          note={failed[0]?.failureReason ? `${failed[0].storeName} · ${failed[0].failureReason}` : '재처리할 계산서가 없습니다'}
          active={queue === 'failed'} onSelect={() => setQueue(queue === 'failed' ? null : 'failed')} />
        <QueueCard tone="orange" icon={<UserCheck size={17} />} label="최종 승인 대기" count={awaitingApproval}
          note={awaitingApproval ? `${formatMoney(awaitingAmount)} 규모 · 다른 계정 검토분` : '승인 대기 없음'}
          active={queue === 'reviewed'} onSelect={() => setQueue(queue === 'reviewed' ? null : 'reviewed')} />
        <QueueCard tone="blue" icon={<Clock3 size={17} />} label="검토 대기" count={drafting} note="재무 계정에서 처리합니다"
          active={queue === 'draft'} onSelect={() => setQueue(queue === 'draft' ? null : 'draft')} />
        <QueueCard tone="green" icon={<Send size={17} />} label="국세청 전송 완료" count={sent} suffix={` / ${invoices.length}건`}
          note={`총 청구액 ${formatMoney(totalGross)} · 발행 처리 중 ${queued}건`}
          active={queue === 'nts_success'} onSelect={() => setQueue(queue === 'nts_success' ? null : 'nts_success')} />
      </section>

      <section className="panel monthly-panel" aria-labelledby="monthly-title" data-testid="monthly-settlement-panel">
        <div className="panel-heading"><div><span className="section-number">01</span><div><h2 id="monthly-title">월별 정산 집계</h2><p>공급 매출(검수 확정 입고) · 매장 매출(POS 실측) · 로스율을 매장별로 합산합니다.</p></div></div>
          <label className="compact-select">귀속월 <input type="month" value={summaryMonth} max={currentMonth} onChange={(event) => setSummaryMonth(event.target.value || currentMonth)} aria-label="정산 귀속월" /></label></div>
        {summaryState === 'loading' && <p className="panel-empty-copy">집계 중…</p>}
        {summaryState === 'error' && <p className="panel-empty-copy">월별 집계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
        {summaryState === 'ready' && summary && <div className="table-wrap stacking-table"><table className="data-table"><thead><tr>
          <th scope="col">매장</th><th scope="col">구분</th><th scope="col" className="num">공급 매출(확정 입고)</th><th scope="col" className="num">매장 매출(POS)</th><th scope="col" className="num">공급/매출</th><th scope="col" className="num">로스율</th><th scope="col">정산·계산서</th></tr></thead>
          <tbody>
            {summary.rows.map((row) => {
              const supplyShare = summary.totals.supplyConfirmed > 0 ? Math.round((row.supplyConfirmed / summary.totals.supplyConfirmed) * 100) : 0;
              const posShare = summary.totals.posRevenue > 0 ? Math.round((row.posRevenue / summary.totals.posRevenue) * 100) : 0;
              return <tr key={row.storeId}>
                <td className="strong">{row.name}</td>
                <td data-label="구분">{row.storeKind ?? <span className="muted">미지정</span>}</td>
                <td className="num" data-label="공급 매출(확정 입고)">{formatMoney(row.supplyConfirmed)}{row.receiptCount > 0 && <small className="muted"> · 입고 {row.receiptCount}건</small>}<span className="share-bar" aria-hidden="true"><i style={{ width: `${supplyShare}%` }} /></span></td>
                <td className="num" data-label="매장 매출(POS)">{formatMoney(row.posRevenue)}{row.posQty > 0 && <small className="muted"> · {row.posQty.toLocaleString('ko-KR')}개</small>}<span className="share-bar pos" aria-hidden="true"><i style={{ width: `${posShare}%` }} /></span></td>
                <td className="num muted" data-label="공급/매출">{row.supplyToPosPct === null ? '—' : `${row.supplyToPosPct.toFixed(1)}%`}</td>
                <td className={`num ${row.lossRate === null ? 'muted' : row.lossRate >= 8 ? 'tone-red' : 'tone-green'}`} data-label="로스율">
                  {row.lossRate !== null && <span className={`loss-gauge ${row.lossRate >= 8 ? 'bad' : 'ok'}`} aria-hidden="true"><i style={{ width: `${Math.min(Math.max(row.lossRate, 0) / 12 * 100, 100)}%` }} /></span>}
                  {row.lossRate === null ? '—' : `${row.lossRate.toFixed(1)}%`}</td>
                <td data-label="정산·계산서">{row.settlementCount === 0 ? <span className="muted">정산 없음</span>
                  : <span>정산 {row.settlementCount}건 · {formatMoney(row.settledGross)}{row.invoiceSummary.total > 0 && <small className="muted"> · 계산서 {row.invoiceSummary.ntsSuccess}/{row.invoiceSummary.total} 전송</small>}{row.invoiceSummary.failed > 0 && <small className="tone-red"> · 실패 {row.invoiceSummary.failed}</small>}</span>}</td>
              </tr>;
            })}
            {summary.rows.length === 0 && <tr><td colSpan={7} className="muted">등록된 매장이 없습니다. 매출현황 탭에서 매장을 먼저 등록해 주세요.</td></tr>}
            {summary.rows.length > 0 && <tr className="summary-total">
              <th scope="row" className="strong">합계</th><td />
              <td className="num strong" data-label="공급 매출 합계">{formatMoney(summary.totals.supplyConfirmed)}</td>
              <td className="num strong" data-label="매장 매출 합계">{formatMoney(summary.totals.posRevenue)}</td><td />
              <td className={`num ${summary.totals.lossRate === null ? 'muted' : 'strong'}`} data-label="평균 로스율">{summary.totals.lossRate === null ? '—' : `${summary.totals.lossRate.toFixed(1)}%`}</td>
              <td className="muted" data-label="정산 합계">정산 {summary.totals.settlementCount}건 · {formatMoney(summary.totals.settledGross)}</td>
            </tr>}
          </tbody></table></div>}
        <p className="muted">공급 매출은 검수 확정된 입고 원장 합계(V1 정산의 출고·완료 발주 합계에 해당)이고, 매장 매출은 토스플레이스 POS 실측입니다. 로스율(입고−판매)은 입고 기록이 있는 달에만 계산되며 없으면 —로 표시합니다.</p>
      </section>

      <section className={`panel ledger-panel${dense ? ' is-dense' : ''}`} aria-labelledby="ledger-title">
        <div className="panel-heading">
          <div><span className="section-number">02</span><div><h2 id="ledger-title">정산·증빙 원장</h2><p>확정 입고 원장을 정산 초안으로 묶고, 재무 검토·마스터 승인·국세청 전송까지 같은 항목에서 이어갑니다.</p></div></div>
          <div className="ledger-tools">
            {queue && <button type="button" className="filter-reset" onClick={() => setQueue(null)}><X size={13} /> 필터 해제</button>}
            <div className="density-toggle" role="group" aria-label="표시 밀도">
              <button type="button" aria-pressed={!dense} onClick={() => setDense(false)}>편안</button>
              <button type="button" aria-pressed={dense} onClick={() => setDense(true)}>조밀</button>
            </div>
          </div>
        </div>
        {canDraftSettlement && data.actor.role === 'hq_master' && <p className="muted" style={{ padding: '0 17px' }}>작성-검토-승인 분리: 마스터가 초안을 만들면 <strong>재무 검토는 재무 계정</strong>에서 진행합니다. 재무 담당 계정은 계정 관리 탭에서 추가할 수 있습니다.</p>}
        {canDraftSettlement && <form className="settlement-draft-form" onSubmit={createSettlement} aria-label="정산 초안 생성"><label>매장<select value={draft.storeId} onChange={(event) => setDraft((current) => ({ ...current, storeId: event.target.value }))} required><option value="">매장 선택</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label>시작일<input type="date" value={draft.periodStart} onChange={(event) => setDraft((current) => ({ ...current, periodStart: event.target.value }))} required /></label><label>종료일<input type="date" value={draft.periodEnd} min={draft.periodStart} onChange={(event) => setDraft((current) => ({ ...current, periodEnd: event.target.value }))} required /></label><Button type="submit" disabled={Boolean(busy)}>{busy === 'settlement:new' ? '생성 중…' : '정산 초안 생성'}</Button></form>}

        <div className="ledger-list">
          {visibleEntries.map((entry) => {
            const stage = entryStage(entry);
            const settlement = entry.settlement;
            const selectable = Boolean(settlement && bulkTargets.some((target) => target.id === settlement.id));
            const amount = settlement?.grossAmount ?? entry.invoices.reduce((sum, invoice) => sum + invoice.grossAmount, 0);
            return (
              <article className={`ledger-entry${stage.tone === 'fail' ? ' has-failure' : ''}`} key={entry.key}>
                <div className="ledger-head">
                  <div className="ledger-pick">{selectable && settlement && <label><input type="checkbox" checked={picked.includes(settlement.id)} aria-label={`${settlement.storeName} 정산 선택`}
                    onChange={(event) => setPicked((current) => event.target.checked ? [...current, settlement.id] : current.filter((id) => id !== settlement.id))} /></label>}</div>
                  <div className="ledger-identity">
                    <strong>{settlement?.storeName ?? entry.invoices[0]?.storeName ?? '매장 미지정'}</strong>
                    <small>{settlement ? `${settlement.periodStart} – ${settlement.periodEnd} · 입고 ${settlement.receiptIds.length}건` : `${entry.invoices[0]?.period ?? ''} · ${entry.invoices[0]?.preparedBy ?? ''} 작성`}</small>
                  </div>
                  <LifecycleTrack step={stage.step} tone={stage.tone} label={stage.label} />
                  <div className="ledger-amount"><strong>{formatMoney(amount)}</strong><small>{settlement ? `공급가 ${formatMoney(settlement.supplyAmount)}` : 'VAT 포함'}</small></div>
                  <div className="ledger-people">
                    {settlement
                      ? <><span>검토 {settlement.reviewedByName ?? '대기'}</span><span>승인 {settlement.approvedByName ?? '대기'}</span></>
                      : <><span>작성 {entry.invoices[0]?.preparedBy ?? '—'}</span>{entry.invoices[0]?.reviewedByName && <span>검토 {entry.invoices[0].reviewedByName}</span>}</>}
                  </div>
                  <div className="ledger-action">{settlement ? settlementAction(settlement) : null}</div>
                </div>
                {entry.invoices.map((invoice) => (
                  <button className="invoice-row" type="button" key={invoice.id} onClick={() => setSelected(invoice)}>
                    <span>
                      <strong>{settlement ? documentLabel(invoice) : invoice.storeName}</strong>
                      <small>{settlement ? `${invoice.period} · ${invoice.preparedBy} 작성` : `${invoice.period} · ${documentLabel(invoice)}`}</small>
                      {invoice.issueType === 'modified' && <em>수정 사유 {invoice.modificationReasonCode}</em>}
                      {invoice.sameBusinessNumber && <em>동일 사업자번호 · 세금계산서 발행 대상 아님</em>}
                      {invoice.failureReason && <em className="invoice-error">실패: {invoice.failureReason}</em>}
                    </span>
                    <span data-label="공급가액">{formatMoney(invoice.supplyAmount)}</span>
                    <span data-label="세액">{formatMoney(invoice.vatAmount)}</span>
                    <span data-label="합계"><strong>{formatMoney(invoice.grossAmount)}</strong></span>
                    <span data-label="상태"><StatusBadge status={invoice.status} /></span>
                    <span><ChevronRight size={20} /></span>
                  </button>
                ))}
                {entry.invoices.length === 0 && <p className="ledger-empty-line">아직 발행된 증빙이 없습니다. 마스터 승인 후 계산서 초안을 만들 수 있습니다.</p>}
              </article>
            );
          })}
          {visibleEntries.length === 0 && <p className="panel-empty-copy">{queue
            ? '이 조건에 해당하는 항목이 없습니다. 위 작업 카드를 다시 눌러 필터를 해제할 수 있습니다.'
            : '생성된 정산이 없습니다. 정산 초안은 확정 입고(발주 → 출고 → 검수 확정) 원장에서 만들어집니다 — 아직 V2 발주 흐름의 입고가 없다면 위 월별 집계의 POS 실측부터 확인하실 수 있습니다.'}</p>}
        </div>
      </section>

      <section className="safety-strip"><ShieldCheck size={25} /><div><strong>{data.meta.providerMode === 'production' && data.meta.externalIssueEnabled ? '외부 계산서 발행 연결됨' : '외부 계산서 발행 비활성화'}</strong><p>발행 요청·실패·재시도는 모두 서버 감사 기록에 남습니다.</p></div><span className="safe-mode">{data.meta.providerMode === 'production' && data.meta.externalIssueEnabled ? 'PRODUCTION ENABLED' : 'EXTERNAL ISSUE DISABLED'}</span></section>

      {pickedTargets.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="선택한 정산 일괄 처리">
          <span className="bulk-count"><strong>{pickedTargets.length}</strong>건 선택</span>
          <span className="bulk-sum">합계 <strong>{formatMoney(pickedTargets.reduce((sum, settlement) => sum + settlement.grossAmount, 0))}</strong></span>
          <Button disabled={Boolean(busy)} onClick={approvePicked}>{busy === 'settlement:bulk' ? '승인 중…' : '선택 정산 일괄 승인'}</Button>
          <button type="button" className="bulk-clear" aria-label="선택 해제" onClick={() => setPicked([])}><X size={17} /></button>
        </div>
      )}

      {selected && <InvoiceLifecycleDrawer invoice={selected} actor={data.actor} finance={finance} master={master} canRetryInvoice={data.capabilities.includes('hq.invoices.retry')} busy={busy} onClose={() => setSelected(null)} onRun={run} />}
    </main>
  );
}

function QueueCard({ tone, icon, label, count, suffix, note, active, onSelect }: { tone: 'red' | 'orange' | 'blue' | 'green'; icon: React.ReactNode; label: string; count: number; suffix?: string; note: string; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`queue-card tone-${tone}`} aria-pressed={active} onClick={onSelect}>
      <span className="queue-top"><span className="queue-icon" aria-hidden="true">{icon}</span><span className="queue-label">{label}</span></span>
      <span className="queue-value"><strong>{count}</strong><span>{suffix ?? '건'}</span></span>
      <small>{note}</small>
    </button>
  );
}

/** 4단계 진행 트랙. 색만으로 상태를 전달하지 않도록 라벨을 항상 함께 노출한다. */
function LifecycleTrack({ step, tone, label }: { step: number; tone: StageTone; label: string }) {
  return (
    <div className="lifecycle-track">
      <ol aria-hidden="true">
        {lifecycleSteps.map((name, index) => {
          const position = index + 1;
          const state = position < step ? 'done' : position === step ? tone : 'idle';
          return <li key={name} className={state}><span>{state === 'done' ? <Check size={11} /> : state === 'fail' ? <X size={11} /> : position}</span></li>;
        })}
      </ol>
      <small className={tone === 'fail' ? 'is-fail' : tone === 'now' ? 'is-now' : undefined}>{label}</small>
    </div>
  );
}

function DeadlineMeter({ deadline, pending }: { deadline: { label: string; days: number | null }; pending: number }) {
  const days = deadline.days;
  const urgent = days !== null && days <= 3;
  const ratio = days === null ? 0 : Math.max(0, Math.min(1, 1 - days / 14));
  return (
    <div className={`deadline-meter${urgent ? ' is-urgent' : ''}`}>
      <span className="deadline-ring" aria-hidden="true">
        <svg width="42" height="42" viewBox="0 0 42 42"><circle cx="21" cy="21" r="18" /><circle cx="21" cy="21" r="18" className="track" strokeDasharray={`${(113 * ratio).toFixed(1)} 113`} /></svg>
        <b>{days === null ? '—' : days >= 0 ? `D-${days}` : `+${Math.abs(days)}`}</b>
      </span>
      <span className="deadline-copy"><strong>{deadline.label}</strong><small>남은 처리 {pending}건</small></span>
    </div>
  );
}

function InvoiceLifecycleDrawer({ invoice, actor, finance, master, canRetryInvoice, busy, onClose, onRun }: { invoice: Invoice; actor: BootstrapData['actor']; finance: boolean; master: boolean; canRetryInvoice: boolean; busy: string | null; onClose: () => void; onRun: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [reasonCode, setReasonCode] = useState<ModificationReasonCode>('03');
  const dialogRef = useAccessibleDialog(onClose);
  const canReview = finance && invoice.status === 'draft';
  const canApprove = master && invoice.status === 'reviewed' && invoice.reviewedBy !== actor.id;
  const canModify = finance && invoice.status === 'nts_success' && invoice.issueType !== 'internal_statement';
  const canRetry = canRetryInvoice && invoice.status === 'failed';
  return <div className="drawer-backdrop" role="presentation"><aside ref={dialogRef} tabIndex={-1} className="review-drawer invoice-drawer" role="dialog" aria-modal="true" aria-labelledby="invoice-review-title"><header><div><span className="drawer-kicker">계산서 수명주기</span><h2 id="invoice-review-title">{invoice.storeName} · {invoice.period}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="계산서 상세 닫기" onClick={onClose}><X size={22} /></button></header><div className="drawer-body">{invoice.failureReason && <div className="risk-box"><AlertCircle size={20} /><div><strong>발행 실패</strong><p>{invoice.failureReason}</p><small>재시도 {invoice.retryCount ?? 0}회{invoice.lastRetriedAt ? ` · 최근 ${invoice.lastRetriedAt}` : ''}</small></div></div>}<section className="invoice-paper"><div className="paper-title"><span>{invoice.issueType === 'modified' ? '수정 전자세금계산서' : invoice.sameBusinessNumber ? '내부거래 명세서' : '전자세금계산서'}</span><StatusBadge status={invoice.status} /></div><div className="business-grid"><div><small>공급자</small><strong>{invoice.supplierName || '공급자 정보 확인 필요'}</strong><span>사업자 {formatBusinessNumber(invoice.supplierBusinessNumber)}</span></div><div><small>공급받는 자</small><strong>{invoice.recipientName || invoice.storeName}</strong><span>사업자 {formatBusinessNumber(invoice.recipientBusinessNumber)}</span></div></div><dl><div><dt>작성일자</dt><dd>{formatIssueDate(invoice.issueDate)}</dd></div><div><dt>공급가액</dt><dd>{formatMoney(invoice.supplyAmount)}</dd></div><div><dt>부가세</dt><dd>{formatMoney(invoice.vatAmount)}</dd></div><div className="total"><dt>합계</dt><dd>{formatMoney(invoice.grossAmount)}</dd></div></dl></section><section className="maker-checker"><h3>작성·검토·승인 분리</h3><div><span><small>작성</small><strong>{invoice.preparedBy}</strong><em><Check size={13} /> {invoice.preparedAt ?? '작성 완료'}</em></span><span className="separation-line" /><span><small>재무 검토</small><strong>{invoice.reviewedByName ?? '대기'}</strong><em>{invoice.reviewedAt ?? '검토 전'}</em></span><span className="separation-line" /><span><small>마스터 승인</small><strong>{invoice.approvedByName ?? '대기'}</strong><em>{invoice.approvedAt ?? '승인 전'}</em></span></div><p>현재 로그인: {actor.name} · {actor.role}</p></section>{canModify && <label className="lifecycle-reason">수정 사유<select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as ModificationReasonCode)}>{modificationReasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.code} · {reason.label}</option>)}</select><small>원본과 반대 부호의 수정계산서 초안을 생성합니다.</small></label>}</div><footer><Button variant="secondary" onClick={onClose}>닫기</Button>{canReview && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:review:${invoice.id}`, () => reviewInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '계산서 검토를 완료했습니다.')}>재무 검토 완료</Button>}{canApprove && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:approve:${invoice.id}`, () => approveInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '계산서를 최종 승인했습니다.')}><ShieldCheck size={18} /> 마스터 승인</Button>}{canModify && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:modify:${invoice.id}`, () => modifyInvoiceV2(invoice.id, reasonCode, newIdempotencyKey()), '수정 세금계산서 초안을 생성했습니다.')}>수정계산서 생성</Button>}{canRetry && <Button disabled={Boolean(busy)} onClick={() => onRun(`invoice:retry:${invoice.id}`, () => retryInvoiceV2(invoice.id, invoice.version ?? 1, newIdempotencyKey()), '발행 재시도를 대기열에 등록했습니다.')}><RefreshCcw size={17} /> 발행 재시도</Button>}{!canReview && !canApprove && !canModify && !canRetry && <span className="drawer-action-note">현재 역할 또는 상태에서 가능한 작업이 없습니다.</span>}</footer></aside></div>;
}

function formatBusinessNumber(value?: string) { const digits = (value ?? '').replace(/\D/g, ''); return /^\d{10}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : '정보 없음'; }
function formatIssueDate(value?: string) { if (!value) return '작성일 미정'; const date = new Date(`${value.slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date); }
function invoiceDeadline(invoices: Invoice[]): { label: string; days: number | null } {
  const dueDate = invoices.map((invoice) => invoice.dueDate).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().at(0);
  if (!dueDate) return { label: '발급기한은 문서 생성 후 표시됩니다', days: null };
  const deadline = new Date(`${dueDate}T23:59:59`);
  const days = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
  return { label: `법정 발급기한 ${new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(deadline)}`, days };
}
