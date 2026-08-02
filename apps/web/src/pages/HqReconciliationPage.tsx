import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, CircleDollarSign, Clock3, Landmark, Link2, Search, ShieldCheck } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BankMatch, BootstrapData } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { mutateV2, newIdempotencyKey } from '../api/client';

export function HqReconciliationPage({ data, source, notify, refresh }: { data: BootstrapData; source: 'live' | 'demo'; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [matches, setMatches] = useState(data.bankMatches);
  const [tab, setTab] = useState<'manual_review' | 'auto_matched' | 'overdue'>('manual_review');
  const [candidateByTransaction, setCandidateByTransaction] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  useEffect(() => { setMatches(data.bankMatches); }, [data.bankMatches]);
  const selected = matches.filter((item) => item.status === tab);
  const reviewCount = matches.filter((item) => item.status === 'manual_review').length;
  const matchedCount = matches.filter((item) => item.status === 'auto_matched').length;
  const overdueCount = matches.filter((item) => item.status === 'overdue').length;
  const incoming = matches.reduce((sum, item) => sum + item.amount, 0);
  async function match(item: BankMatch) {
    const selectedCandidate = item.candidateOptions?.find((candidate) => candidate.paymentRequestId === candidateByTransaction[item.bankTransactionId ?? item.id]);
    const paymentRequestId = item.paymentRequestId ?? selectedCandidate?.paymentRequestId;
    const bankTransactionId = item.bankTransactionId ?? selectedCandidate?.bankTransactionId;
    const version = selectedCandidate?.version ?? item.version ?? 1;
    if (!paymentRequestId || !bankTransactionId) { notify('연결할 청구서를 먼저 선택해 주세요.', 'warning'); return; }
    try {
      if (source === 'live') await mutateV2(`/payments/${paymentRequestId}/manual-match`, { expectedVersion: version, bankTransactionId }, {
        idempotencyKey: newIdempotencyKey(), actorId: data.meta.appMode === 'demo' ? data.actor.id : undefined,
      });
      else setMatches((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'auto_matched', storeName: entry.storeName ?? '한남점' } : entry));
      notify(`${formatMoney(item.amount)} 입금을 ${selectedCandidate?.storeName ?? item.storeName ?? '선택한 매장'} 청구에 수동 대사했습니다.`, 'success');
      if (source === 'live') refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '수동 대사에 실패했습니다.', 'warning'); }
  }
  async function requestSync() {
    if (syncing) return;
    if (source === 'demo') { notify('데모에서는 외부 계좌를 호출하지 않습니다.', 'info'); return; }
    setSyncing(true);
    try {
      const date = seoulDate(new Date());
      await mutateV2('/bank-sync', { from: date, to: date }, {
        idempotencyKey: newIdempotencyKey(), actorId: data.meta.appMode === 'demo' ? data.actor.id : undefined,
      });
      notify('계좌 거래 수집을 안전한 작업 큐에 등록했습니다.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '계좌 수집 요청에 실패했습니다.', 'warning'); }
    finally { setSyncing(false); }
  }
  return (
    <main id="main-content" data-testid="hq-reconciliation-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading"><div><p className="eyebrow"><span /> HQ FINANCE</p><h1>입금 대사</h1><p>유일하게 일치한 입금만 자동 처리하고, 모호한 건은 사람이 확인합니다.</p></div><div className="heading-tools"><span className="last-sync"><span /> 화면 동기화 · {formatSyncTime(data.generatedAt)}</span><Button variant="secondary" disabled={syncing} onClick={requestSync}><ArrowRightLeft size={18} /> {syncing ? '수집 요청 중…' : '거래 수집 요청'}</Button></div></section>
      <section className="metrics-grid"><MetricCard label="수집된 입금" value={formatMoney(incoming)} detail={`${matches.length}건 수집`} icon={<Landmark size={21} />} /><MetricCard label="자동 일치" value={`${matchedCount}건`} detail="후보가 단 하나인 거래" icon={<ShieldCheck size={21} />} tone="green" /><MetricCard label="검토 필요" value={`${reviewCount}건`} detail="후보 0건 또는 여러 건" icon={<AlertTriangle size={21} />} tone="red" /><MetricCard label="연체" value={`${overdueCount}건`} detail="납부 알림 대상" icon={<Clock3 size={21} />} tone="orange" /></section>
      <section className="panel reconcile-panel"><div className="queue-toolbar"><div><h2>입금 처리 큐</h2><p>입금자명과 금액을 청구 내역에 연결합니다.</p></div><div className="filter-chips" role="group" aria-label="입금 대사 필터"><button className={tab === 'manual_review' ? 'active danger' : ''} aria-pressed={tab === 'manual_review'} onClick={() => setTab('manual_review')}>검토 필요 <span>{reviewCount}</span></button><button className={tab === 'auto_matched' ? 'active' : ''} aria-pressed={tab === 'auto_matched'} onClick={() => setTab('auto_matched')}>자동 일치 <span>{matchedCount}</span></button><button className={tab === 'overdue' ? 'active' : ''} aria-pressed={tab === 'overdue'} onClick={() => setTab('overdue')}>연체 <span>{overdueCount}</span></button></div></div>
        <div className="match-list">{selected.map((item) => { const transactionId = item.bankTransactionId ?? item.id; const chosen = candidateByTransaction[transactionId]; const canMatch = Boolean(item.paymentRequestId || chosen); return <article className="match-card" key={item.id}><div className="bank-entry"><span className="bank-icon"><Landmark size={20} /></span><div><small>입금 거래 · {item.transferredAt}</small><strong>{item.depositor}</strong><span>{formatMoney(item.amount)}</span></div></div><div className="match-connector"><span /><Link2 size={18} /><span /></div><div className="invoice-candidate"><small>{item.status === 'manual_review' ? `일치 후보 ${item.candidates ?? 0}건` : item.status === 'overdue' ? '연체 청구' : '연결된 청구'}</small>{item.status === 'manual_review' && item.candidateOptions?.length ? <label className="compact-select"><span className="sr-only">{item.depositor} 입금에 연결할 청구</span><select value={chosen ?? ''} onChange={(event) => setCandidateByTransaction((current) => ({ ...current, [transactionId]: event.target.value }))}><option value="">청구를 선택하세요</option>{item.candidateOptions.map((candidate) => <option key={candidate.paymentRequestId} value={candidate.paymentRequestId}>{candidate.label}</option>)}</select></label> : <strong>{item.storeName ?? '일치 후보가 없습니다'}</strong>}<span>{item.status === 'manual_review' ? '금액과 매장을 직접 확인한 뒤 연결하세요' : '결제 요청 연결 완료'}</span></div><div className="match-action"><StatusBadge status={item.status} />{item.status === 'manual_review' && <Button disabled={!canMatch} onClick={() => match(item)}><Search size={17} /> {canMatch ? '선택 청구에 연결' : '청구 선택 필요'}</Button>}{item.status === 'overdue' && <Button variant="secondary" disabled title="알림 재발송 API 연결 후 활성화됩니다.">알림 준비 중</Button>}{item.status === 'auto_matched' && <span className="matched-check"><Check size={18} /> 처리 완료</span>}</div></article>; })}</div>
        <div className="reconcile-rule"><CircleDollarSign size={19} /><div><strong>자동 대사 안전 규칙</strong><p>금액·입금 참조·허용 시간창이 맞고 후보가 정확히 1건일 때만 자동 확정합니다. 그 외에는 금액을 임의 배분하지 않습니다.</p></div></div>
      </section>
    </main>
  );
}

function seoulDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function formatSyncTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '시간 확인 필요' : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
