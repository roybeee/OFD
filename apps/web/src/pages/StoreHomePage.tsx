import { useEffect, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, Check, ChevronRight, CircleDollarSign, Clock3, Phone, ReceiptText, ShoppingBag, Truck } from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, DocumentItem } from '../types';
import { Button, MetricCard } from '../components/ui';
import { getDocumentDownloadV2, loadNoticesV2, type NoticeRow } from '../api/client';

/*
 * 점주 홈 — 점주에게 반드시 필요한 것만 남긴 화면.
 *
 * 넣은 것 : 지금 해야 할 일 · 다음 배송 · 내야 할 금액 · 증빙 원본 · 본사 공지 · 문의
 * 뺀 것   : 공급가액/세액 분리, 귀속월, 수정계산서 사유코드, maker-checker, 로스율,
 *           POS 대비 공급비율 — 전부 본사 재무의 언어라 점주 화면에서는 소음이다.
 *
 * 자세한 조작(발주 마법사, 전체 증빙 목록)은 기존 화면으로 넘긴다. 이 화면은
 * "지금 뭘 해야 하나 · 언제 오나 · 얼마 내야 하나"에만 답한다.
 */

type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;
type ActionTone = 'urgent' | 'due' | 'ready' | 'calm';
type OwnerAction = { key: string; tone: ActionTone; label: string; title: string; detail: string; cta: string; onSelect?: () => void };

const documentNames: Record<DocumentItem['type'], string> = {
  monthly_statement: '월 정산서', tax_invoice: '전자세금계산서', internal_statement: '내부거래 명세서',
  delivery_statement: '거래명세서', payment_request: '결제 요청서',
};
/** 점주가 읽는 말로만 상태를 표현한다. 국세청 전송 단계 같은 본사 사정은 '발급 완료'로 묶는다. */
const documentState: Record<string, { label: string; tone: 'done' | 'wait' | 'due' }> = {
  nts_success: { label: '발급 완료', tone: 'done' }, issued: { label: '발급 완료', tone: 'done' },
  internal_statement: { label: '발급 완료', tone: 'done' }, paid: { label: '결제 완료', tone: 'done' },
  scheduled: { label: '발급 예정', tone: 'wait' }, pending: { label: '결제 필요', tone: 'due' },
};

export function StoreHomePage({ data, notify, onNavigate }: { data: BootstrapData; notify: Notify; onNavigate: (path: string) => void }) {
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadNoticesV2().then((result) => { if (!cancelled) setNotices(result.notices.slice(0, 2)); })
      .catch(() => { /* 공지는 부가 정보 — 실패해도 홈 화면은 그대로 동작한다 */ });
    return () => { cancelled = true; };
  }, [data.generatedAt]);

  const ownOrders = data.orders.filter((order) => order.storeId === data.store.id);
  const changeRequested = ownOrders.find((order) => order.status === 'change_requested');
  const arriving = ownOrders.find((order) => order.status === 'out_for_delivery');
  const preparing = ownOrders.find((order) => order.status === 'preparing' || order.status === 'approved');
  const waiting = ownOrders.filter((order) => order.status === 'submitted').length;
  const nextDelivery = arriving ?? preparing;
  const availableDate = data.allowedDeliveryDates[0];
  const canOrder = data.capabilities.includes('store.orders.read');
  const canSeeDocuments = data.capabilities.includes('store.documents.read');

  const unpaid = data.documents.filter((document) => document.type === 'payment_request' && document.status === 'pending');
  const unpaidTotal = unpaid.reduce((sum, document) => sum + document.amount, 0);
  const nextPayment = unpaid[0];
  const receipts = data.documents.filter((document) => document.type !== 'payment_request').slice(0, 3);

  const actions: OwnerAction[] = [];
  if (changeRequested && canOrder) actions.push({
    key: 'change', tone: 'urgent', label: '본사 변경 요청', title: `${changeRequested.code} 발주를 수정해 주세요`,
    detail: changeRequested.changeRequest?.reason ?? '수량과 입고일을 다시 확인해 주세요.',
    cta: '발주 수정하기', onSelect: () => onNavigate('/store/orders'),
  });
  if (unpaidTotal > 0 && canSeeDocuments) actions.push({
    key: 'pay', tone: 'due', label: '결제 필요', title: `${formatMoney(unpaidTotal)}을 결제해 주세요`,
    detail: nextPayment ? `${nextPayment.title} · ${nextPayment.period}` : '미결제 요청이 있습니다.',
    cta: '결제 내역 보기', onSelect: () => onNavigate('/store/documents'),
  });
  if (!changeRequested && availableDate && canOrder) actions.push({
    key: 'order', tone: 'ready', label: '발주 가능', title: '다음 입고분을 발주해 주세요',
    detail: `${readableDate(availableDate)}부터 입고일을 선택할 수 있어요.`,
    cta: '발주하러 가기', onSelect: () => onNavigate('/store/orders'),
  });
  if (actions.length === 0) actions.push({
    key: 'calm', tone: 'calm', label: '확인 완료', title: '지금 처리할 일이 없어요',
    detail: waiting > 0 ? `발주 ${waiting}건을 본사에서 확인하고 있어요.` : '새 요청이 생기면 여기에 표시됩니다.', cta: '',
  });

  async function openDocument(documentId: string | undefined, title: string) {
    if (!documentId || openingId) return;
    const target = window.open('', '_blank');
    if (!target) { notify('팝업이 차단되었습니다. 브라우저에서 새 창 열기를 허용해 주세요.', 'warning'); return; }
    target.opener = null;
    setOpeningId(documentId);
    try {
      const result = await getDocumentDownloadV2(documentId);
      target.location.href = result.downloadUrl;
      notify(`${title} 원본을 새 창에서 열었습니다. 링크는 ${Math.round(result.expiresInSeconds / 60)}분 동안 유효합니다.`, 'info');
    } catch (error) {
      target.close();
      notify(error instanceof Error ? error.message : '문서 원본을 열지 못했습니다.', 'warning');
    } finally { setOpeningId(null); }
  }

  function contactHq() {
    if (!data.supportEmail) return;
    window.location.href = `mailto:${encodeURIComponent(data.supportEmail)}?subject=${encodeURIComponent(`[${data.store.name}] 문의`)}`;
  }

  return (
    <main id="main-content" data-testid="store-home-screen" className="page page-store page-owner" tabIndex={-1}>
      <section className="page-heading owner-greeting">
        <div>
          <p className="eyebrow"><span /> {data.store.name}</p>
          <h1>{greeting()}, {data.actor.name}님</h1>
          <p>{todayLabel(data.meta.operationalDate ?? data.generatedAt)} · 오늘 확인할 내용을 모았어요.</p>
        </div>
        {nextDelivery && <div className="owner-next-delivery">
          <span className="owner-next-icon" aria-hidden="true"><Truck size={21} /></span>
          <span><small>{arriving ? '배송 중' : '준비 중'}</small><strong>{readableDate(nextDelivery.deliveryDate)} 도착 예정</strong><span>{nextDelivery.itemCount}개 품목 · {nextDelivery.code}</span></span>
        </div>}
      </section>

      {notices.length > 0 && <section className="owner-notices" aria-label="본사 공지">
        {notices.map((notice) => (
          <article key={notice.id}>
            <strong>{notice.pinned ? '📌 ' : ''}{notice.title}</strong>
            {notice.body && <p>{notice.body}</p>}
            <small>{notice.date}</small>
          </article>
        ))}
      </section>}

      <section className="owner-actions" aria-labelledby="owner-actions-title">
        <h2 id="owner-actions-title" className="owner-section-title">지금 해야 할 일</h2>
        {actions.map((action) => (
          <article className={`owner-action tone-${action.tone}`} key={action.key}>
            <span className="owner-action-icon" aria-hidden="true">
              {action.tone === 'urgent' ? <AlertCircle size={23} /> : action.tone === 'due' ? <CircleDollarSign size={23} /> : action.tone === 'ready' ? <ShoppingBag size={23} /> : <Check size={23} />}
            </span>
            <span className="owner-action-copy">
              <small>{action.label}</small>
              <strong>{action.title}</strong>
              <p>{action.detail}</p>
            </span>
            {action.cta && action.onSelect && <Button onClick={action.onSelect}>{action.cta} <ArrowRight size={17} aria-hidden="true" /></Button>}
          </article>
        ))}
      </section>

      <section className="metrics-grid store-metrics" aria-label="매장 현황 요약">
        <MetricCard label="내야 할 금액" value={formatMoney(unpaidTotal)}
          detail={nextPayment ? `${nextPayment.title} · ${nextPayment.period}` : `${data.store.paymentTerm} · ${data.store.billingPolicy}`}
          icon={<CircleDollarSign size={21} />} tone={unpaidTotal > 0 ? 'orange' : 'default'} />
        <MetricCard label="본사 확인 중" value={`${waiting}건`} detail={preparing ? '상품 준비 중 1건' : '준비 중인 발주 없음'} icon={<Clock3 size={21} />} />
        <MetricCard label="배송 중" value={arriving ? '1건' : '0건'}
          detail={nextDelivery ? `${readableDate(nextDelivery.deliveryDate)} 도착 예정` : '예정된 배송 없음'} icon={<Truck size={21} />} tone="green" />
      </section>

      {canSeeDocuments && <section className="panel owner-panel" aria-labelledby="owner-docs-title">
        <div className="panel-heading owner-panel-head"><div><h2 id="owner-docs-title">받은 증빙</h2><p>세금계산서와 정산서 원본을 여기서 받으실 수 있어요.</p></div><button type="button" className="owner-more" onClick={() => onNavigate('/store/documents')}>전체 보기 <ChevronRight size={15} aria-hidden="true" /></button></div>
        <ul className="owner-docs">
          {receipts.map((document) => {
            const state = documentState[document.status] ?? { label: '처리 중', tone: 'wait' as const };
            return (
              <li key={document.id}>
                <span className="owner-doc-icon" aria-hidden="true"><ReceiptText size={19} /></span>
                <span className="owner-doc-copy"><strong>{document.title}</strong><small>{documentNames[document.type]} · {document.period}</small></span>
                <span className="owner-doc-amount"><strong>{formatMoney(document.amount)}</strong><small className={`owner-doc-state tone-${state.tone}`}>{state.label}</small></span>
                <button type="button" className="owner-doc-open" disabled={!document.downloadDocumentId || Boolean(openingId)}
                  aria-label={`${document.title} 원본 열기`} onClick={() => openDocument(document.downloadDocumentId, document.title)}>
                  <ArrowDownToLine size={19} aria-hidden="true" />
                </button>
              </li>
            );
          })}
          {receipts.length === 0 && <li className="owner-docs-empty">아직 발급된 증빙이 없어요. 정산이 확정되면 여기에 표시됩니다.</li>}
        </ul>
      </section>}

      <section className="panel owner-help">
        <div><Phone size={23} aria-hidden="true" /><div><strong>금액이나 입고 내용이 다른가요?</strong><p>본사 담당자에게 바로 문의하실 수 있어요.</p></div></div>
        <Button variant="secondary" disabled={!data.supportEmail} onClick={contactHq} title={data.supportEmail ? undefined : '본사 담당자 이메일 등록이 필요합니다.'}>본사에 문의하기</Button>
      </section>
    </main>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 11 ? '좋은 아침이에요' : hour < 17 ? '안녕하세요' : '수고 많으셨어요';
}

function todayLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? '오늘' : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(date);
}

function readableDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}
