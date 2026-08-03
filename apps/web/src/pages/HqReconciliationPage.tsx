import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, CircleDollarSign, Clock3, Landmark, Link2, Search, ShieldCheck } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, PaymentRequestItem } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { autoMatchPaymentsV2, manualMatchPaymentV2, newIdempotencyKey, requestBankSyncV2, reversePaymentMatchV2 } from '../api/client';

type Tab = 'review' | 'paid' | 'overdue';

export function HqReconciliationPage({ data, notify, refresh }: { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [requests, setRequests] = useState(data.paymentRequests);
  const [tab, setTab] = useState<Tab>('review');
  const [transactionByRequest, setTransactionByRequest] = useState<Record<string, string>>({});
  const [reverseReasonByRequest, setReverseReasonByRequest] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [syncQueued, setSyncQueued] = useState(false);

  useEffect(() => { setRequests(data.paymentRequests); }, [data.paymentRequests]);
  const review = requests.filter((item) => ['pending', 'matching', 'manual_review', 'reversed'].includes(item.status));
  const paid = requests.filter((item) => item.status === 'paid');
  const overdue = review.filter((item) => item.overdue);
  const visible = tab === 'paid' ? paid : tab === 'overdue' ? overdue : review;
  const incoming = data.bankTransactions.filter((item) => item.direction === 'credit').reduce((sum, item) => sum + item.amount, 0);
  const unmatched = data.bankTransactions.filter((item) => item.direction === 'credit' && !item.matched).length;

  const candidatesByRequest = useMemo(() => new Map(requests.map((request) => [request.id,
    data.manualMatchCandidates.filter((candidate) => candidate.paymentRequestId === request.id && data.bankTransactions.some((transaction) => transaction.id === candidate.bankTransactionId && !transaction.matched)),
  ])), [data.bankTransactions, data.manualMatchCandidates, requests]);

  async function runAutoMatch() {
    if (busy) return;
    setBusy('auto');
    try {
      const result = await autoMatchPaymentsV2(newIdempotencyKey());
      notify(`자동 대사 완료: 입금 완료 ${result.paid.length}건, 검토 필요 ${result.manualReview.length}건, 미일치 ${result.unmatched}건`, 'success');
      refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '자동 대사에 실패했습니다.', 'warning'); }
    finally { setBusy(null); }
  }

  async function requestSync() {
    if (busy) return;
    setBusy('sync');
    try {
      const today = seoulDate(new Date());
      await requestBankSyncV2(today, today, newIdempotencyKey());
      setSyncQueued(true);
      notify('계좌 거래 수집이 대기열에 등록되었습니다. 새로고침해 결과를 확인합니다.', 'success');
      refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '계좌 수집 요청에 실패했습니다.', 'warning'); }
    finally { setBusy(null); }
  }

  async function match(request: PaymentRequestItem) {
    const bankTransactionId = transactionByRequest[request.id];
    if (!bankTransactionId) { notify('연결할 입금 거래를 선택해 주세요.', 'warning'); return; }
    setBusy(`match:${request.id}`);
    try {
      await manualMatchPaymentV2(request.id, bankTransactionId, request.version, newIdempotencyKey());
      notify(`${request.storeName}의 ${formatMoney(request.amount)} 결제 요청을 입금 거래에 연결했습니다.`, 'success');
      refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '수동 대사에 실패했습니다.', 'warning'); }
    finally { setBusy(null); }
  }

  async function reverse(request: PaymentRequestItem) {
    const reason = reverseReasonByRequest[request.id]?.trim() ?? '';
    if (!request.matchedBankTransactionId) { notify('연결된 입금 거래가 없습니다.', 'warning'); return; }
    if (reason.length < 3) { notify('대사 취소 사유를 3자 이상 입력해 주세요.', 'warning'); return; }
    setBusy(`reverse:${request.id}`);
    try {
      await reversePaymentMatchV2(request.id, request.version, reason, newIdempotencyKey());
      notify(`${request.storeName} 입금 연결을 취소하고 검토 큐로 이동했습니다.`, 'warning');
      refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '대사 취소에 실패했습니다.', 'warning'); }
    finally { setBusy(null); }
  }

  return (
    <main id="main-content" data-testid="hq-reconciliation-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading"><div><p className="eyebrow"><span /> HQ FINANCE</p><h1>입금 대사</h1><p>결제 요청을 기준으로 입금 후보를 검토하고, 명시적으로 자동 또는 수동 대사합니다.</p></div><div className="heading-tools"><span className="last-sync" role="status"><span /> {syncQueued ? '은행 수집 대기 중' : `화면 동기화 · ${formatSyncTime(data.generatedAt)}`}</span><Button variant="secondary" disabled={Boolean(busy)} onClick={requestSync}><ArrowRightLeft size={18} /> {busy === 'sync' ? '수집 요청 중…' : '거래 수집 요청'}</Button><Button disabled={Boolean(busy) || review.length === 0} onClick={runAutoMatch}><ShieldCheck size={18} /> {busy === 'auto' ? '자동 대사 중…' : '자동 대사 실행'}</Button></div></section>
      <section className="metrics-grid"><MetricCard label="수집된 입금" value={formatMoney(incoming)} detail={`${data.bankTransactions.length}건 수집`} icon={<Landmark size={21} />} /><MetricCard label="입금 완료" value={`${paid.length}건`} detail="결제 요청 연결 완료" icon={<Check size={21} />} tone="green" /><MetricCard label="검토 필요" value={`${review.length}건`} detail={`미연결 입금 ${unmatched}건`} icon={<AlertTriangle size={21} />} tone="red" /><MetricCard label="연체 요청" value={`${overdue.length}건`} detail="납부기한 경과" icon={<Clock3 size={21} />} tone="orange" /></section>
      <section className="panel reconcile-panel" aria-labelledby="reconcile-title"><div className="queue-toolbar"><div><h2 id="reconcile-title">결제 요청 처리 큐</h2><p>입금 거래가 없는 요청도 누락 없이 표시합니다.</p></div><div className="filter-chips" role="group" aria-label="입금 대사 필터"><button className={tab === 'review' ? 'active danger' : ''} aria-pressed={tab === 'review'} onClick={() => setTab('review')}>검토 필요 <span>{review.length}</span></button><button className={tab === 'paid' ? 'active' : ''} aria-pressed={tab === 'paid'} onClick={() => setTab('paid')}>입금 완료 <span>{paid.length}</span></button><button className={tab === 'overdue' ? 'active' : ''} aria-pressed={tab === 'overdue'} onClick={() => setTab('overdue')}>연체 <span>{overdue.length}</span></button></div></div>
        <div className="match-list">{visible.map((request) => { const candidates = candidatesByRequest.get(request.id) ?? []; const chosen = transactionByRequest[request.id] ?? ''; const reason = reverseReasonByRequest[request.id] ?? ''; return <article className="match-card request-match-card" key={request.id}><div className="bank-entry"><span className="bank-icon"><CircleDollarSign size={20} /></span><div><small>결제 요청 · 납부기한 {request.dueDate}</small><strong>{request.storeName}</strong><span>{formatMoney(request.amount)}</span>{request.depositorHint && <small>입금자 힌트: {request.depositorHint}</small>}</div></div><div className="match-connector"><span /><Link2 size={18} /><span /></div><div className="invoice-candidate"><small>{request.status === 'paid' ? '연결된 입금 거래' : `대사 가능 후보 ${candidates.length}건`}</small>{request.status === 'paid' ? <><strong>{request.matchedBankTransactionId ?? '거래 식별자 확인 필요'}</strong><label className="reverse-reason"><span>연결 취소 사유</span><input value={reason} maxLength={500} onChange={(event) => setReverseReasonByRequest((current) => ({ ...current, [request.id]: event.target.value }))} placeholder="예: 다른 매장 입금" /></label></> : candidates.length > 0 ? <label className="compact-select"><span className="sr-only">{request.storeName} 결제 요청에 연결할 입금 거래</span><select value={chosen} onChange={(event) => setTransactionByRequest((current) => ({ ...current, [request.id]: event.target.value }))}><option value="">입금 거래를 선택하세요</option>{candidates.map((candidate) => { const transaction = data.bankTransactions.find((item) => item.id === candidate.bankTransactionId); return <option key={candidate.bankTransactionId} value={candidate.bankTransactionId}>{transaction?.memo || candidate.label} · {formatMoney(candidate.amount)}</option>; })}</select></label> : <><strong>대사 가능한 입금 없음</strong><span>거래 수집 후 다시 자동 대사를 실행하세요.</span></>}</div><div className="match-action"><StatusBadge status={request.overdue && request.status !== 'paid' ? 'overdue' : request.status} />{request.status === 'paid' ? <Button variant="secondary" disabled={reason.trim().length < 3 || busy === `reverse:${request.id}`} onClick={() => reverse(request)}>{busy === `reverse:${request.id}` ? '취소 중…' : '연결 취소'}</Button> : <Button disabled={!chosen || Boolean(busy)} onClick={() => match(request)}><Search size={17} /> {busy === `match:${request.id}` ? '연결 중…' : '선택 거래에 연결'}</Button>}</div></article>; })}{visible.length === 0 && <p className="panel-empty-copy">이 상태의 결제 요청이 없습니다.</p>}</div>
        <div className="reconcile-rule"><ShieldCheck size={19} /><div><strong>자동 대사 안전 규칙</strong><p>서버가 금액·입금 참조·허용 시간창을 확인해 후보가 정확히 1건인 경우만 확정합니다. 모호한 요청은 수동 검토로 남습니다.</p></div></div>
      </section>
    </main>
  );
}

function seoulDate(date: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function formatSyncTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '시간 확인 필요' : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
