import { useMemo, useState } from 'react';
import { ArrowDownToLine, CalendarDays, ChevronRight, CircleDollarSign, FileCheck2, Landmark, ReceiptText, ShieldCheck } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';

const documentNames = { monthly_statement: '월 정산서', tax_invoice: '전자세금계산서', delivery_statement: '거래명세서', payment_request: '결제 요청서' };

export function StoreDocumentsPage({ data, notify }: { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void }) {
  const monthOptions = useMemo(() => [...new Set(data.documents.map((document) => documentMonth(document.period, document.title, data.generatedAt)))].filter(Boolean), [data.documents, data.generatedAt]);
  const [month, setMonth] = useState(monthOptions[0] ?? '');
  const visibleDocuments = month ? data.documents.filter((document) => documentMonth(document.period, document.title, data.generatedAt) === month) : data.documents;
  const pendingRequests = data.documents.filter((document) => document.type === 'payment_request' && document.status === 'pending');
  const pending = pendingRequests.reduce((sum, document) => sum + document.amount, 0);
  const currentRequest = pendingRequests[0];
  const issuedStatement = data.documents.find((document) => document.type === 'monthly_statement' && document.status === 'issued');
  const nextInvoice = data.documents.find((document) => document.type === 'tax_invoice' && document.status === 'scheduled');

  function openDocument(url: string | undefined, title: string) {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
    notify(`${title} 원본을 새 창에서 열었습니다.`, 'info');
  }

  function contactFinance() {
    if (!data.supportEmail) return;
    window.location.href = `mailto:${encodeURIComponent(data.supportEmail)}?subject=${encodeURIComponent(`[${data.store.name}] 정산 문의`)}`;
  }
  return (
    <main id="main-content" data-testid="store-document-screen" className="page page-store" tabIndex={-1}>
      <section className="page-heading">
        <div><p className="eyebrow"><span /> STORE WORKSPACE</p><h1>정산·증빙</h1><p>내야 할 금액과 발급된 문서를 한곳에서 확인하세요.</p></div>
        <div className="heading-date"><ShieldCheck size={18} aria-hidden="true" /><span><strong>세무 문서 안전 보관</strong><small>원본 변경 방지</small></span></div>
      </section>

      <section className="billing-hero">
        <div><span className="hero-kicker"><CalendarDays size={15} /> {currentRequest?.title ?? '미결제 정산 없음'}</span><p>{currentRequest?.period ?? '현재 납부할 결제 요청이 없습니다'}</p><h2>{formatMoney(pending)}</h2><small>{currentRequest ? '부가세 포함 · 확정 문서 기준' : '새 결제 요청이 생성되면 이곳에 표시됩니다'}</small></div>
        <div className="billing-actions"><Button disabled title="승인된 수취 계좌가 점주 API에 연결되면 활성화됩니다."><Landmark size={18} /> 입금계좌 등록 대기</Button><Button variant="secondary" disabled={!issuedStatement?.downloadUrl} onClick={() => openDocument(issuedStatement?.downloadUrl, issuedStatement?.title ?? '정산서')} title={issuedStatement?.downloadUrl ? undefined : '원본 파일이 생성된 뒤 활성화됩니다.'}><ArrowDownToLine size={18} /> {issuedStatement?.downloadUrl ? '정산서 원본 열기' : '원본 생성 대기'}</Button></div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="결제 조건" value={data.store.paymentTerm} detail="매장별로 본사에서 설정" icon={<CircleDollarSign size={21} />} />
        <MetricCard label="청구 방식" value={data.store.billingPolicy} detail="한 달 배송분을 한 번에" icon={<ReceiptText size={21} />} tone="orange" />
        <MetricCard label="다음 계산서" value={nextInvoice?.period ?? '예정 없음'} detail={nextInvoice ? '마스터 승인 후 발행 큐 처리' : '발행 예정 문서 없음'} icon={<FileCheck2 size={21} />} tone="green" />
      </section>

      <section className="panel documents-panel" aria-labelledby="documents-title">
        <div className="panel-heading"><div><span className="section-number">01</span><div><h2 id="documents-title">문서 보관함</h2><p>실제 발급 상태와 금액을 확인하고, 원본 생성이 완료된 문서만 열 수 있어요.</p></div></div>{monthOptions.length > 0 && <label className="compact-select">기간 <select value={month} onChange={(event) => setMonth(event.target.value)}>{monthOptions.map((option) => <option value={option} key={option}>{formatMonth(option)}</option>)}</select></label>}</div>
        <div className="document-list">
          {visibleDocuments.map((document) => (
            <div className="document-row" key={document.id}>
              <span className={`document-icon doc-${document.type}`}><ReceiptText size={21} aria-hidden="true" /></span>
              <span className="document-copy"><small>{documentNames[document.type]}</small><strong>{document.title}</strong><span>{document.period}</span></span>
              <span className="document-amount"><StatusBadge status={document.status} /><strong>{formatMoney(document.amount)}</strong></span>
              <button type="button" className="icon-button" disabled={!document.downloadUrl} onClick={() => openDocument(document.downloadUrl, document.title)} aria-label={document.downloadUrl ? `${document.title} 원본 열기` : `${document.title} 원본 생성 대기`} title={document.downloadUrl ? '원본 열기' : '원본 생성 대기'}><ChevronRight size={20} aria-hidden="true" /></button>
            </div>
          ))}
          {visibleDocuments.length === 0 && <p className="panel-empty-copy">선택한 기간에 생성된 문서가 없습니다.</p>}
        </div>
      </section>

      <section className="panel ledger-help">
        <div><ShieldCheck size={26} aria-hidden="true" /><div><strong>금액이 다른가요?</strong><p>확정된 입고 내역을 기준으로 정산됩니다. 이미 확정된 문서는 직접 수정하지 않고 반품·차감 내역으로 안전하게 조정해요.</p></div></div>
        <Button variant="secondary" disabled={!data.supportEmail} onClick={contactFinance} title={data.supportEmail ? undefined : '본사 재무 이메일 등록이 필요합니다.'}>정산 문의 메일 작성</Button>
      </section>
    </main>
  );
}

function documentMonth(period: string, title: string, generatedAt: string) {
  const full = `${period} ${title}`.match(/(20\d{2})[.년-]\s*(\d{1,2})/);
  if (full) return `${full[1]}-${full[2]!.padStart(2, '0')}`;
  const monthOnly = title.match(/(\d{1,2})월/);
  const generatedYear = new Date(generatedAt).getFullYear();
  return monthOnly && Number.isFinite(generatedYear) ? `${generatedYear}-${monthOnly[1]!.padStart(2, '0')}` : '';
}

function formatMonth(value: string) {
  const [year, month] = value.split('-');
  return year && month ? `${year}년 ${Number(month)}월` : value;
}
