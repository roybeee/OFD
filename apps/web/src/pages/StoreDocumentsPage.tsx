import { useMemo, useState } from 'react';
import { ArrowDownToLine, CalendarDays, ChevronRight, CircleDollarSign, FileCheck2, ReceiptText, ShieldCheck } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';

const documentNames = { monthly_statement: '월 정산서', tax_invoice: '전자세금계산서', internal_statement: '내부거래 명세서', delivery_statement: '거래명세서', payment_request: '결제 요청서' };

export function StoreDocumentsPage({ data, notify }: { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void }) {
  const monthOptions = useMemo(() => [...new Set(data.documents.map((document) => documentMonth(document.period, document.title, data.generatedAt)))].filter(Boolean), [data.documents, data.generatedAt]);
  const [month, setMonth] = useState(monthOptions[0] ?? '');
  const visibleDocuments = month ? data.documents.filter((document) => documentMonth(document.period, document.title, data.generatedAt) === month) : data.documents;
  const pendingRequests = data.documents.filter((document) => document.type === 'payment_request' && document.status === 'pending');
  const pending = pendingRequests.reduce((sum, document) => sum + document.amount, 0);
  const currentRequest = pendingRequests[0];
  const issuedStatement = data.documents.find((document) => document.type === 'monthly_statement' && document.status === 'issued');
  const nextInvoice = data.documents.find((document) => document.type === 'tax_invoice' && !['nts_success', 'issued', 'failed', 'cancelled'].includes(document.status));

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
        <div className="heading-date"><ShieldCheck size={18} aria-hidden="true" /><span><strong>정산 상태 조회</strong><small>운영 원장 기준</small></span></div>
      </section>

      <section className="billing-hero">
        <div><span className="hero-kicker"><CalendarDays size={15} /> {currentRequest?.title ?? '미결제 정산 없음'}</span><p>{currentRequest?.period ?? '현재 납부할 결제 요청이 없습니다'}</p><h2>{formatMoney(pending)}</h2><small>{currentRequest ? '부가세 포함 · 확정 문서 기준' : '새 결제 요청이 생성되면 이곳에 표시됩니다'}</small></div>
        {issuedStatement?.downloadUrl && <div className="billing-actions"><Button variant="secondary" onClick={() => openDocument(issuedStatement.downloadUrl, issuedStatement.title)}><ArrowDownToLine size={18} /> 정산서 원본 열기</Button></div>}
      </section>

      <section className="metrics-grid">
        <MetricCard label="결제 조건" value={data.store.paymentTerm} detail="매장별로 본사에서 설정" icon={<CircleDollarSign size={21} />} />
        <MetricCard label="청구 방식" value={data.store.billingPolicy} detail="운영 서버 설정 기준" icon={<ReceiptText size={21} />} tone="orange" />
        <MetricCard label="다음 계산서" value={nextInvoice?.period ?? '예정 없음'} detail={nextInvoice ? '현재 발급 상태 기준' : '발행 예정 문서 없음'} icon={<FileCheck2 size={21} />} tone="green" />
      </section>

      <section className="panel documents-panel" aria-labelledby="documents-title">
        <div className="panel-heading"><div><span className="section-number">01</span><div><h2 id="documents-title">정산 내역</h2><p>운영 서버에서 확정된 발급 상태와 금액을 확인할 수 있어요.</p></div></div>{monthOptions.length > 0 && <label className="compact-select">기간 <select value={month} onChange={(event) => setMonth(event.target.value)}>{monthOptions.map((option) => <option value={option} key={option}>{formatMonth(option)}</option>)}</select></label>}</div>
        <div className="document-list">
          {visibleDocuments.map((document) => (
            <div className="document-row" key={document.id}>
              <span className={`document-icon doc-${document.type}`}><ReceiptText size={21} aria-hidden="true" /></span>
              <span className="document-copy"><small>{documentNames[document.type]}</small><strong>{document.title}</strong><span>{document.period}</span></span>
              <span className="document-amount"><StatusBadge status={document.status} /><strong>{formatMoney(document.amount)}</strong></span>
              {document.downloadUrl && <button type="button" className="icon-button" onClick={() => openDocument(document.downloadUrl, document.title)} aria-label={`${document.title} 원본 열기`} title="원본 열기"><ChevronRight size={20} aria-hidden="true" /></button>}
            </div>
          ))}
          {visibleDocuments.length === 0 && <p className="panel-empty-copy">선택한 기간에 생성된 문서가 없습니다.</p>}
        </div>
      </section>

      <section className="panel ledger-help">
        <div><ShieldCheck size={26} aria-hidden="true" /><div><strong>금액이 다른가요?</strong><p>운영 원장에 표시된 내역을 확인한 뒤 본사 재무 담당자에게 문의해 주세요.</p></div></div>
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
