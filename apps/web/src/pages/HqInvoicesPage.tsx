import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarCheck, Check, ChevronRight, CircleCheckBig, FileCheck2, LockKeyhole, Send, ShieldCheck, UserCheck, X } from '../components/icons';
import { canApproveInvoice, formatMoney } from '../lib/workflows';
import type { BootstrapData, Invoice } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { mutateV2, newIdempotencyKey } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

export function HqInvoicesPage({ data, source, notify, refresh }: { data: BootstrapData; source: 'live' | 'demo'; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [invoices, setInvoices] = useState(data.invoices);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [filter, setFilter] = useState<'all' | 'reviewed' | 'nts_success'>('all');
  useEffect(() => {
    setInvoices(data.invoices);
    setSelected((current) => current ? data.invoices.find((invoice) => invoice.id === current.id) ?? null : null);
  }, [data.invoices]);
  const reviewed = invoices.filter((invoice) => invoice.status === 'reviewed');
  const visibleInvoices = filter === 'all' ? invoices : invoices.filter((invoice) => invoice.status === filter);
  const totalGross = invoices.reduce((sum, invoice) => sum + invoice.grossAmount, 0);
  const queued = invoices.filter((invoice) => ['approved', 'queued', 'issued', 'nts_pending'].includes(invoice.status)).length;
  const sent = invoices.filter((invoice) => invoice.status === 'nts_success').length;
  const progressed = invoices.filter((invoice) => invoice.status !== 'draft').length;
  const periodLabel = invoices[0]?.period ?? '현재 기간';
  const deadline = useMemo(() => invoiceDeadline(invoices), [invoices]);
  async function approve(invoice: Invoice) {
    try {
      if (source === 'live') await mutateV2(`/invoices/${invoice.id}/approve`, { expectedVersion: invoice.version ?? 1 }, {
        idempotencyKey: newIdempotencyKey(), actorId: data.meta.appMode === 'demo' ? data.actor.id : undefined,
      });
      else setInvoices((current) => current.map((entry) => entry.id === invoice.id ? { ...entry, status: 'queued' } : entry));
      setSelected(null);
      notify(`${invoice.storeName} 계산서를 승인했습니다. 안전한 발행 큐에 등록됩니다.`, 'success');
      if (source === 'live') refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '계산서 승인에 실패했습니다.', 'warning'); }
  }
  return (
    <main id="main-content" data-testid="hq-invoice-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading"><div><p className="eyebrow"><span /> HQ FINANCE</p><h1>정산·세금계산서</h1><p>재무 검토와 마스터 승인을 분리해 안전하게 월마감합니다.</p></div><div className="heading-tools"><span className="deadline-badge"><CalendarCheck size={17} /> {deadline.label}</span><Button variant="secondary" disabled title="보고서 원본 생성 기능은 운영 전환 게이트에서 활성화됩니다."><FileCheck2 size={18} /> 월마감 보고서 준비 중</Button></div></section>
      <section className="closing-progress" aria-labelledby="closing-title"><div className="closing-copy"><span className="hero-kicker"><LockKeyhole size={15} /> {periodLabel} 월마감</span><h2 id="closing-title">발행 전 승인 상태를 확인하세요</h2><p>문서 {invoices.length}건 중 {progressed}건이 검토 단계에 들어갔고, 마스터 승인이 필요한 문서는 {reviewed.length}건입니다.</p></div><ol><li className="done"><span><Check size={16} /></span><div><strong>정산 초안</strong><small>{invoices.length}건 생성</small></div></li><li className={progressed === invoices.length && invoices.length > 0 ? 'done' : 'active'}><span>{progressed === invoices.length && invoices.length > 0 ? <Check size={16} /> : 2}</span><div><strong>재무 검토</strong><small>{progressed} / {invoices.length}건</small></div></li><li className={reviewed.length ? 'active' : ''}><span>3</span><div><strong>마스터 승인</strong><small>{reviewed.length}건 대기</small></div></li><li className={sent === invoices.length && invoices.length > 0 ? 'done' : ''}><span>{sent === invoices.length && invoices.length > 0 ? <Check size={16} /> : 4}</span><div><strong>발행·전송</strong><small>{sent}건 국세청 완료</small></div></li></ol></section>
      <section className="metrics-grid"><MetricCard label="총 청구액" value={formatMoney(totalGross)} detail={`${invoices.length}개 매장 · VAT 포함`} icon={<FileCheck2 size={21} />} /><MetricCard label="승인 필요" value={`${reviewed.length}건`} detail="작성자와 다른 마스터가 승인" icon={<UserCheck size={21} />} tone="red" /><MetricCard label="발행 대기" value={`${queued}건`} detail="영속 큐에서 순차 처리" icon={<Send size={21} />} tone="orange" /><MetricCard label="국세청 전송 완료" value={`${sent}건`} detail={`실패 ${invoices.filter((invoice) => invoice.status === 'failed').length}건`} icon={<CircleCheckBig size={21} />} tone="green" /></section>
      <section className="panel invoice-panel"><div className="queue-toolbar"><div><h2>{periodLabel} 계산서 검토</h2><p>동일 사업자번호 직영점은 계산서 대신 내부거래 명세서가 생성됩니다.</p></div><label className="compact-select">상태 <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">전체 상태</option><option value="reviewed">승인 필요</option><option value="nts_success">전송 완료</option></select></label></div><div className="invoice-list"><div className="invoice-list-head"><span>매장 / 귀속월</span><span>공급가액</span><span>세액</span><span>합계</span><span>상태</span><span /></div>{visibleInvoices.map((invoice) => <button className="invoice-row" type="button" key={invoice.id} onClick={() => setSelected(invoice)}><span><strong>{invoice.storeName}</strong><small>{invoice.period} · {invoice.preparedBy} 작성</small>{invoice.sameBusinessNumber && <em>동일 사업자번호</em>}</span><span data-label="공급가액">{formatMoney(invoice.supplyAmount)}</span><span data-label="세액">{formatMoney(invoice.vatAmount)}</span><span data-label="합계"><strong>{formatMoney(invoice.grossAmount)}</strong></span><span data-label="상태"><StatusBadge status={invoice.status} /></span><span><ChevronRight size={20} /></span></button>)}</div></section>
      <section className="safety-strip"><ShieldCheck size={25} /><div><strong>운영 발행 안전장치가 켜져 있습니다</strong><p>Popbill 자격증명·공급자 인증서·계좌 승인·운영 허용 스위치가 모두 확인되기 전에는 실제 외부 발행이 차단됩니다.</p></div><span className="safe-mode">{data.meta.providerMode === 'production' && data.meta.externalIssueEnabled ? 'PRODUCTION ENABLED' : 'EXTERNAL ISSUE BLOCKED'}</span></section>
      {selected && <InvoiceApprovalDrawer invoice={selected} actor={data.actor} onClose={() => setSelected(null)} onApprove={() => approve(selected)} />}
    </main>
  );
}

function InvoiceApprovalDrawer({ invoice, actor, onClose, onApprove }: { invoice: Invoice; actor: BootstrapData['actor']; onClose: () => void; onApprove: () => Promise<void> }) {
  const eligible = invoice.status === 'reviewed' && canApproveInvoice({ preparedBy: invoice.preparedById, actorId: actor.id, actorRole: actor.role });
  const dialogRef = useAccessibleDialog(onClose);
  return <div className="drawer-backdrop" role="presentation"><aside ref={dialogRef} tabIndex={-1} className="review-drawer invoice-drawer" role="dialog" aria-modal="true" aria-labelledby="invoice-review-title"><header><div><span className="drawer-kicker">마스터 승인</span><h2 id="invoice-review-title">{invoice.storeName} · {invoice.period}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="계산서 상세 닫기" onClick={onClose}><X size={22} /></button></header><div className="drawer-body">{invoice.sameBusinessNumber && <div className="risk-box neutral-risk"><AlertCircle size={20} /><div><strong>세금계산서 발행 차단</strong><p>본사와 사업자번호가 같아 승인 후 내부거래 명세서를 생성합니다.</p></div></div>}<section className="invoice-paper"><div className="paper-title"><span>{invoice.sameBusinessNumber ? '내부거래 명세서' : '전자세금계산서'}</span><small>확정 스냅샷 미리보기</small></div><div className="business-grid"><div><small>공급자</small><strong>{invoice.supplierName || '공급자 정보 확인 필요'}</strong><span>사업자 {formatBusinessNumber(invoice.supplierBusinessNumber)}</span></div><div><small>공급받는 자</small><strong>{invoice.recipientName || invoice.storeName}</strong><span>사업자 {formatBusinessNumber(invoice.recipientBusinessNumber)}</span></div></div><dl><div><dt>작성일자</dt><dd>{formatIssueDate(invoice.issueDate)}</dd></div><div><dt>공급가액</dt><dd>{formatMoney(invoice.supplyAmount)}</dd></div><div><dt>부가세</dt><dd>{formatMoney(invoice.vatAmount)}</dd></div><div className="total"><dt>합계</dt><dd>{formatMoney(invoice.grossAmount)}</dd></div></dl></section><section className="maker-checker"><h3>작성·승인 분리</h3><div><span><small>작성·검토</small><strong><span className="person-dot">{invoice.preparedBy.slice(0, 1)}</span>{invoice.preparedBy} · 재무</strong><em><Check size={13} /> 검토 완료</em></span><span className="separation-line" /><span><small>최종 승인</small><strong><span className="person-dot master-dot">{actor.name.slice(0, 1)}</span>{actor.name} · 마스터</strong><em className="waiting"><LockKeyhole size={13} /> 승인 대기</em></span></div><p>작성자와 승인자는 서로 달라야 하며 모든 행위는 변경 불가 감사 원장에 기록됩니다.</p></section></div><footer><Button variant="secondary" onClick={onClose}>닫기</Button><Button disabled={!eligible} onClick={onApprove}>{invoice.status !== 'reviewed' ? '승인할 수 없는 상태' : invoice.sameBusinessNumber ? <><ShieldCheck size={18} /> 승인하고 내부 명세서 생성</> : <><ShieldCheck size={18} /> 승인하고 발행 큐 등록</>}</Button></footer></aside></div>;
}

function formatBusinessNumber(value?: string) {
  const digits = (value ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : '정보 없음';
}

function formatIssueDate(value?: string) {
  if (!value) return '작성일 미정';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function invoiceDeadline(invoices: Invoice[]) {
  const issueDate = invoices.map((invoice) => invoice.issueDate).filter(Boolean).sort().at(-1);
  if (!issueDate) return { label: '발급기한은 문서 생성 후 표시됩니다' };
  const [year, month] = issueDate.split('-').map(Number);
  const deadline = new Date(year!, month!, 10, 23, 59, 59);
  const days = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
  const dateLabel = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(deadline);
  return { label: `법정 발급기한 ${dateLabel} · ${days >= 0 ? `D-${days}` : `${Math.abs(days)}일 경과`}` };
}
