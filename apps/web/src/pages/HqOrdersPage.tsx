import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  PackageCheck,
  Search,
  ShieldAlert,
  Store,
  UserRoundPlus,
  X,
} from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, Order } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { ApiError, mutateV2, newIdempotencyKey } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

const riskLabels = {
  price_changed: { label: '가격 변경 감지', detail: '이전 발주 대비 단가가 바뀐 상품이 있어요.', icon: ArrowDownUp },
  new_store: { label: '신규 매장 첫 발주', detail: '배송지와 결제 조건을 확인해 주세요.', icon: UserRoundPlus },
  over_credit: { label: '외상 한도 초과', detail: '미결제 잔액을 확인해 주세요.', icon: ShieldAlert },
};

export function HqOrdersPage({ data, source, notify, refresh }: { data: BootstrapData; source: 'live' | 'demo'; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [filter, setFilter] = useState<'attention' | 'waiting' | 'all'>(() => data.orders.some((order) => order.risk) ? 'attention' : 'waiting');
  const [selected, setSelected] = useState<Order | null>(null);
  const [query, setQuery] = useState('');
  const [approvedIds, setApprovedIds] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<'approve' | 'change' | null>(null);
  const canApprove = data.capabilities.includes('hq.orders.approve');
  const canRequestChange = data.capabilities.includes('hq.orders.change_request');
  const attentionCount = data.orders.filter((order) => Boolean(order.risk) && order.status === 'submitted' && !approvedIds.includes(order.id)).length;
  const waitingCount = data.orders.filter((order) => order.status === 'submitted' && !approvedIds.includes(order.id)).length;
  const approvedCount = data.orders.filter((order) => order.status === 'approved').length + approvedIds.length;
  const orders = useMemo(() => data.orders.filter((order) => {
    const matchesFilter = approvedIds.includes(order.id) ? filter === 'all'
      : filter === 'attention' ? Boolean(order.risk) && order.status === 'submitted'
        : filter === 'waiting' ? order.status === 'submitted' : true;
    if (!matchesFilter) return false;
    const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
    return !normalizedQuery || `${order.storeName} ${order.code}`.toLocaleLowerCase('ko-KR').includes(normalizedQuery);
  }), [approvedIds, data.orders, filter, query]);

  useEffect(() => {
    setApprovedIds([]);
    setSelected((current) => current ? data.orders.find((order) => order.id === current.id) ?? null : null);
  }, [data.orders]);

  function mutationOptions() {
    return { idempotencyKey: newIdempotencyKey(), actorId: data.meta.appMode === 'demo' ? data.actor.id : undefined };
  }

  function handleMutationError(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      notify('다른 담당자가 먼저 처리했습니다. 최신 주문으로 새로고침합니다.', 'warning');
      refresh();
      return;
    }
    notify(error instanceof Error ? error.message : fallback, 'warning');
  }

  async function approve(order: Order) {
    if (!canApprove || pendingAction) return;
    setPendingAction('approve');
    try {
      if (source === 'live') await mutateV2(`/orders/${order.id}/approve`, { expectedVersion: order.version }, mutationOptions());
      else setApprovedIds((current) => [...current, order.id]);
      setSelected(null);
      notify(`${order.storeName} ${order.code} 발주를 승인했습니다. 배송 준비 큐에 추가됩니다.`, 'success');
      if (source === 'live') refresh();
    } catch (error) { handleMutationError(error, '주문 승인에 실패했습니다.'); }
    finally { setPendingAction(null); }
  }

  async function requestChange(order: Order, reason: string) {
    if (!canRequestChange || pendingAction) return;
    setPendingAction('change');
    try {
      if (source === 'live') await mutateV2(`/orders/${order.id}/change-request`, { expectedVersion: order.version, reason }, mutationOptions());
      setSelected(null);
      notify(`${order.storeName}에 변경 요청을 보냈습니다.`, 'warning');
      if (source === 'live') refresh();
    } catch (error) { handleMutationError(error, '변경 요청에 실패했습니다.'); }
    finally { setPendingAction(null); }
  }

  return (
    <main id="main-content" data-testid="hq-order-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading">
        <div><p className="eyebrow"><span /> HQ OPERATIONS</p><h1>주문 운영</h1><p>확인이 필요한 주문부터 보여드려요</p></div>
        <div className="heading-tools"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">주문 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="매장명·발주번호 검색" /></label><span className="deadline-badge"><PackageCheck size={18} /> 주문별 수동 검토</span></div>
      </section>

      <section className={`attention-banner ${attentionCount === 0 ? 'all-clear' : ''}`}>
        <div className="attention-symbol">{attentionCount > 0 ? <CircleAlert size={23} aria-hidden="true" /> : <Check size={23} aria-hidden="true" />}</div>
        <div><strong>{attentionCount > 0 ? `지금 확인이 필요한 주문이 ${attentionCount}건 있어요` : '위험 신호가 감지된 주문은 없습니다'}</strong><p>{attentionCount > 0 ? '가격·신규 매장·외상 한도 예외는 자동 승인되지 않으며 담당자 확인 후에만 배송 준비로 넘어갑니다.' : '일반 승인 대기 주문을 순서대로 검토해 주세요. 모든 주문은 여전히 본사 수동 승인이 필요합니다.'}</p></div>
        <button type="button" onClick={() => setFilter(attentionCount > 0 ? 'attention' : 'waiting')}>{attentionCount > 0 ? '예외 주문만 보기' : '승인 대기 보기'} <ChevronRight size={18} /></button>
      </section>

      <section className="metrics-grid hq-metrics" aria-label="주문 운영 요약">
        <MetricCard label="확인 필요" value={`${attentionCount}건`} detail={attentionCount ? '가장 오래된 예외부터 검토' : '현재 예외 없음'} icon={<AlertTriangle size={21} />} tone="red" />
        <MetricCard label="일반 승인 대기" value={`${waitingCount - attentionCount}건`} detail="모든 주문은 수동 승인" icon={<Clock3 size={21} />} tone="orange" />
        <MetricCard label="승인 완료" value={`${approvedCount}건`} detail="배송 준비 가능" icon={<Check size={21} />} tone="green" />
        <MetricCard label="배송 일정 등록" value={`${data.deliveries.length}건`} detail="기사·증빙 상태 확인" icon={<CalendarClock size={21} />} />
      </section>

      <section className="panel queue-panel" aria-labelledby="order-queue-title">
        <div className="queue-toolbar">
          <div><h2 id="order-queue-title">주문 검토 큐</h2><p>주문을 누르면 가격·결제 조건·배송지를 한 화면에서 검토할 수 있어요.</p></div>
          <div className="filter-chips" role="group" aria-label="주문 큐 필터">
            <button type="button" className={filter === 'attention' ? 'active danger' : ''} aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}><AlertTriangle size={15} /> 확인 필요 <span>{attentionCount}</span></button>
            <button type="button" className={filter === 'waiting' ? 'active' : ''} aria-pressed={filter === 'waiting'} onClick={() => setFilter('waiting')}>승인 대기 <span>{waitingCount}</span></button>
            <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체</button>
          </div>
        </div>
        <div className="order-table" role="table" aria-label="주문 검토 목록">
          <div className="order-table-head" role="row">
            <span role="columnheader">매장 / 발주번호</span><span role="columnheader">입고 예정</span><span role="columnheader">결제 조건</span><span role="columnheader">금액</span><span role="columnheader">상태</span><span role="columnheader"><span className="sr-only">상세</span></span>
          </div>
          {orders.map((order) => {
            const risk = order.risk ? riskLabels[order.risk] : null;
            const RiskIcon = risk?.icon;
            return (
              <button type="button" className={`order-table-row ${risk ? 'has-risk' : ''}`} role="row" key={order.id} onClick={() => setSelected(order)}>
                <span role="cell" className="store-cell"><span className="store-avatar"><Store size={17} /></span><span><strong>{order.storeName}</strong><small>{order.code} · {order.itemCount}개 품목</small>{risk && RiskIcon && <em><RiskIcon size={13} /> {risk.label}</em>}</span></span>
                <span role="cell" data-label="입고 예정"><strong>{new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(order.deliveryDate))}</strong><small>오전 배송</small></span>
                <span role="cell" data-label="결제 조건"><strong>{order.paymentTerm === 'prepaid' ? '선결제' : '월 외상'}</strong><small>{order.paymentTerm === 'prepaid' ? '입금 후 출고' : '익월 7일'}</small></span>
                <span role="cell" data-label="금액"><strong>{formatMoney(order.grossAmount)}</strong><small>VAT 포함</small></span>
                <span role="cell" data-label="상태"><StatusBadge status={approvedIds.includes(order.id) ? 'approved' : order.status} /></span>
                <span role="cell"><ChevronRight size={20} aria-hidden="true" /></span>
              </button>
            );
          })}
        </div>
        {orders.length === 0 && <div className="queue-empty"><Check size={22} /><strong>이 큐의 주문을 모두 확인했어요.</strong><button type="button" onClick={() => setFilter('all')}>전체 주문 보기</button></div>}
      </section>

      {selected && <OrderReviewDrawer order={selected} pendingAction={pendingAction} canApprove={canApprove} canRequestChange={canRequestChange} onClose={() => setSelected(null)} onApprove={() => approve(selected)} onChange={(reason) => requestChange(selected, reason)} />}
    </main>
  );
}

function OrderReviewDrawer({ order, pendingAction, canApprove, canRequestChange, onClose, onApprove, onChange }: { order: Order; pendingAction: 'approve' | 'change' | null; canApprove: boolean; canRequestChange: boolean; onClose: () => void; onApprove: () => Promise<void>; onChange: (reason: string) => Promise<void> }) {
  const risk = order.risk ? riskLabels[order.risk] : null;
  const [changeReason, setChangeReason] = useState('');
  const dialogRef = useAccessibleDialog(onClose);
  return (
    <div className="drawer-backdrop" role="presentation">
      <aside ref={dialogRef} tabIndex={-1} className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header><div><span className="drawer-kicker">수동 승인 검토</span><h2 id="review-title">{order.storeName} · {order.code}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="주문 상세 닫기" onClick={onClose}><X size={22} /></button></header>
        <div className="drawer-body">
          {risk && <div className="risk-box"><AlertTriangle size={20} /><div><strong>{risk.label}</strong><p>{risk.detail}</p></div></div>}
          <section className="review-block"><h3>승인 전 체크</h3><ul className="check-list"><li><Check size={16} /> <span>요청 입고일 <strong>{new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(order.deliveryDate))}</strong></span></li><li><Check size={16} /> <span>결제 조건 <strong>{order.paymentTerm === 'prepaid' ? '선결제' : '월 외상'}</strong></span></li>{order.storeAddress && <li><Check size={16} /> <span>배송지 <strong>{order.storeAddress}</strong></span></li>}</ul></section>
          <section className="review-block"><div className="block-title"><h3>주문 품목</h3><span>{order.itemCount}개</span></div>{order.lines?.length ? <div className="sample-lines">{order.lines.map((line) => <div key={line.id}><span>{line.name} <small>{line.quantity}{line.unit}</small></span><strong>{formatMoney(line.gross)}</strong></div>)}</div> : <p className="unavailable-copy">이 주문의 품목 세부 정보는 API에서 제공되지 않았습니다.</p>}<div className="review-total"><span>총 결제 예정</span><strong>{formatMoney(order.grossAmount)}</strong></div></section>
          <section className="review-block"><h3>변경 요청 사유</h3><label className="note-field"><span>점주에게 전달할 내용 <small>변경 요청 시 필수</small></span><textarea value={changeReason} onChange={(event) => setChangeReason(event.target.value)} maxLength={500} placeholder="예: 원두 수량과 희망 배송일을 다시 확인해 주세요." /></label><p className="audit-notice">승인·변경 요청은 담당자, 시간, 사유와 함께 감사 원장에 기록됩니다.</p></section>
        </div>
        <footer><Button variant="secondary" disabled={!canRequestChange || pendingAction !== null || changeReason.trim().length < 3} onClick={() => onChange(changeReason.trim())}>{pendingAction === 'change' ? '요청 중…' : canRequestChange ? '변경 요청' : '변경 권한 없음'}</Button><Button disabled={!canApprove || pendingAction !== null} onClick={onApprove}>{pendingAction === 'approve' ? '승인 중…' : canApprove ? <><Check size={18} /> 승인하고 배송 준비</> : '승인 권한 없음'}</Button></footer>
      </aside>
    </div>
  );
}
