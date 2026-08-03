import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  PackageCheck,
  Search,
  Store,
  X,
} from '../components/icons';
import { formatMoney } from '../lib/workflows';
import type { BootstrapData, Order } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { ApiError, mutateV2, newIdempotencyKey } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

export function HqOrdersPage({ data, notify, refresh }: { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [filter, setFilter] = useState<'waiting' | 'legacy' | 'all'>('waiting');
  const [selected, setSelected] = useState<Order | null>(null);
  const [query, setQuery] = useState('');
  const [pendingAction, setPendingAction] = useState<'approve' | 'change' | null>(null);
  const canApprove = data.capabilities.includes('hq.orders.approve');
  const canRequestChange = data.capabilities.includes('hq.orders.change_request');
  const waitingCount = data.orders.filter((order) => order.status === 'submitted' && order.source !== 'legacy_unverified').length;
  const legacyCount = data.orders.filter((order) => order.source === 'legacy_unverified').length;
  const changeRequestedCount = data.orders.filter((order) => order.status === 'change_requested').length;
  const approvedCount = data.orders.filter((order) => order.status === 'approved').length;
  const orders = useMemo(() => data.orders.filter((order) => {
    const matchesFilter = filter === 'waiting'
      ? order.status === 'submitted' && order.source !== 'legacy_unverified'
      : filter === 'legacy' ? order.source === 'legacy_unverified' : true;
    if (!matchesFilter) return false;
    const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
    return !normalizedQuery || `${order.storeName} ${order.code}`.toLocaleLowerCase('ko-KR').includes(normalizedQuery);
  }), [data.orders, filter, query]);

  useEffect(() => {
    setSelected((current) => current ? data.orders.find((order) => order.id === current.id) ?? null : null);
  }, [data.orders]);

  function mutationOptions() {
    return { idempotencyKey: newIdempotencyKey() };
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
    if (!canApprove || pendingAction || order.source === 'legacy_unverified') return;
    setPendingAction('approve');
    try {
      await mutateV2(`/orders/${order.id}/approve`, { expectedVersion: order.version }, mutationOptions());
      setSelected(null);
      notify(`${order.storeName} ${order.code} 발주를 승인했습니다.`, 'success');
      refresh();
    } catch (error) { handleMutationError(error, '주문 승인에 실패했습니다.'); }
    finally { setPendingAction(null); }
  }

  async function requestChange(order: Order, reason: string) {
    if (!canRequestChange || pendingAction || order.source === 'legacy_unverified') return;
    setPendingAction('change');
    try {
      await mutateV2(`/orders/${order.id}/change-request`, { expectedVersion: order.version, reason }, mutationOptions());
      setSelected(null);
      notify(`${order.storeName}에 변경 요청을 보냈습니다.`, 'warning');
      refresh();
    } catch (error) { handleMutationError(error, '변경 요청에 실패했습니다.'); }
    finally { setPendingAction(null); }
  }

  return (
    <main id="main-content" data-testid="hq-order-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading">
        <div><p className="eyebrow"><span /> HQ OPERATIONS</p><h1>주문 운영</h1><p>확인이 필요한 주문부터 보여드려요</p></div>
        <div className="heading-tools"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">주문 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="매장명·발주번호 검색" /></label><span className="deadline-badge"><PackageCheck size={18} /> 주문별 수동 검토</span></div>
      </section>

      <section className="attention-banner all-clear">
        <div className="attention-symbol"><Clock3 size={23} aria-hidden="true" /></div>
        <div><strong>통합 승인 대기 주문이 {waitingCount}건 있습니다</strong><p>표시된 발주 내용과 입고 예정일을 담당자가 직접 확인한 뒤 승인해 주세요.{legacyCount ? ` 기존 원장 ${legacyCount}건은 별도 구분됩니다.` : ''}</p></div>
        <button type="button" onClick={() => setFilter('waiting')}>승인 대기 보기 <ChevronRight size={18} /></button>
      </section>

      <section className="metrics-grid hq-metrics" aria-label="주문 운영 요약">
        <MetricCard label="승인 대기" value={`${waitingCount}건`} detail="담당자 수동 확인 필요" icon={<Clock3 size={21} />} tone="orange" />
        <MetricCard label="변경 요청" value={`${changeRequestedCount}건`} detail="점주 수정 대기" icon={<CircleAlert size={21} />} tone="red" />
        <MetricCard label="승인 완료" value={`${approvedCount}건`} detail="승인 상태 기준" icon={<Check size={21} />} tone="green" />
        <MetricCard label="배송 일정 등록" value={`${data.deliveries.length}건`} detail="기사·증빙 상태 확인" icon={<CalendarClock size={21} />} />
      </section>

      <section className="panel queue-panel" aria-labelledby="order-queue-title">
        <div className="queue-toolbar">
          <div><h2 id="order-queue-title">주문 검토 큐</h2><p>주문을 누르면 가격·결제 조건·배송지를 한 화면에서 검토할 수 있어요.</p></div>
          <div className="filter-chips" role="group" aria-label="주문 큐 필터">
            <button type="button" className={filter === 'waiting' ? 'active' : ''} aria-pressed={filter === 'waiting'} onClick={() => setFilter('waiting')}>승인 대기 <span>{waitingCount}</span></button>
            <button type="button" className={filter === 'legacy' ? 'active' : ''} aria-pressed={filter === 'legacy'} onClick={() => setFilter('legacy')}>기존 원장 <span>{legacyCount}</span></button>
            <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체</button>
          </div>
        </div>
        <div className="order-table" role="table" aria-label="주문 검토 목록">
          <div className="order-table-head" role="row">
            <span role="columnheader">매장 / 발주번호</span><span role="columnheader">입고 예정</span><span role="columnheader">결제 조건</span><span role="columnheader">금액</span><span role="columnheader">상태</span><span role="columnheader"><span className="sr-only">상세</span></span>
          </div>
          {orders.map((order) => (
              <button type="button" className={`order-table-row ${order.source === 'legacy_unverified' ? 'legacy-read-only' : ''}`} role="row" key={order.id} onClick={() => setSelected(order)}>
                <span role="cell" className="store-cell"><span className="store-avatar"><Store size={17} /></span><span><strong>{order.storeName}</strong><small>{order.code} · {order.itemCount}개 품목</small></span></span>
                <span role="cell" data-label="입고 예정"><strong>{new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(order.deliveryDate))}</strong><small>입고 예정일</small></span>
                <span role="cell" data-label="결제 조건"><strong>{order.paymentTerm === 'prepaid' ? '선결제' : order.paymentTerm === 'monthly_credit' ? '월 외상' : '확인 필요'}</strong><small>{order.paymentTerm === 'unconfigured' ? '서버 미등록' : '서버 등록값'}</small></span>
                <span role="cell" data-label="금액"><strong>{formatMoney(order.grossAmount)}</strong><small>{order.source === 'legacy_unverified' ? '기존 원장에서 확인' : 'VAT 포함'}</small></span>
                <span role="cell" data-label="상태"><StatusBadge status={order.status} />{order.source === 'legacy_unverified' && <small>기존 원장 · 읽기 전용</small>}</span>
                <span role="cell"><ChevronRight size={20} aria-hidden="true" /></span>
              </button>
          ))}
        </div>
        {orders.length === 0 && <div className="queue-empty"><Check size={22} /><strong>{filter === 'waiting' ? '승인 대기 주문이 없습니다.' : '표시할 주문이 없습니다.'}</strong><button type="button" onClick={() => setFilter('all')}>전체 주문 보기</button></div>}
      </section>

      {selected && <OrderReviewDrawer order={selected} pendingAction={pendingAction} canApprove={canApprove} canRequestChange={canRequestChange} onClose={() => setSelected(null)} onApprove={() => approve(selected)} onChange={(reason) => requestChange(selected, reason)} />}
    </main>
  );
}

function OrderReviewDrawer({ order, pendingAction, canApprove, canRequestChange, onClose, onApprove, onChange }: { order: Order; pendingAction: 'approve' | 'change' | null; canApprove: boolean; canRequestChange: boolean; onClose: () => void; onApprove: () => Promise<void>; onChange: (reason: string) => Promise<void> }) {
  const [changeReason, setChangeReason] = useState('');
  const dialogRef = useAccessibleDialog(onClose);
  const legacyReadOnly = order.source === 'legacy_unverified';
  return (
    <div className="drawer-backdrop" role="presentation">
      <aside ref={dialogRef} tabIndex={-1} className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header><div><span className="drawer-kicker">{legacyReadOnly ? '기존 원장 조회' : '수동 승인 검토'}</span><h2 id="review-title">{order.storeName} · {order.code}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="주문 상세 닫기" onClick={onClose}><X size={22} /></button></header>
        <div className="drawer-body">
          {legacyReadOnly && <div className="risk-box neutral-risk"><CircleAlert size={20} /><div><strong>이전 시스템에서 생성된 읽기 전용 주문입니다</strong><p>과거 단가를 현재 값으로 덮어쓰지 않기 위해 통합 화면의 승인·변경은 차단됩니다. 기존 워크스테이션 발주 메뉴에서 처리해 주세요.</p></div></div>}
          <section className="review-block"><h3>승인 전 체크</h3><ul className="check-list"><li><Check size={16} /> <span>요청 입고일 <strong>{new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(order.deliveryDate))}</strong></span></li>{order.paymentTerm === 'unconfigured' ? <li><CircleAlert size={16} /> <span>결제 조건 <strong>미등록 · 담당자 확인 필요</strong></span></li> : <li><Check size={16} /> <span>결제 조건 <strong>{order.paymentTerm === 'prepaid' ? '선결제' : '월 외상'}</strong></span></li>}{order.storeAddress && <li><Check size={16} /> <span>배송지 <strong>{order.storeAddress}</strong></span></li>}</ul></section>
          <section className="review-block"><div className="block-title"><h3>주문 품목</h3><span>{order.itemCount}개</span></div>{order.lines?.length ? <div className="sample-lines">{order.lines.map((line) => <div key={line.id}><span>{line.name} <small>{line.quantity}{line.unit}</small></span><strong>{formatMoney(line.gross)}</strong></div>)}</div> : <p className="unavailable-copy">이 주문의 품목 세부 정보는 API에서 제공되지 않았습니다.</p>}<div className="review-total"><span>{legacyReadOnly ? '기존 원장 금액' : '총 결제 예정'}</span><strong>{formatMoney(order.grossAmount)}</strong></div></section>
          {!legacyReadOnly && <section className="review-block"><h3>변경 요청 사유</h3><label className="note-field"><span>점주에게 전달할 내용 <small>변경 요청 시 필수</small></span><textarea value={changeReason} onChange={(event) => setChangeReason(event.target.value)} maxLength={500} placeholder="예: 원두 수량과 희망 배송일을 다시 확인해 주세요." /></label><p className="audit-notice">승인·변경 요청은 담당자, 시간, 사유와 함께 감사 원장에 기록됩니다.</p></section>}
        </div>
        <footer>{legacyReadOnly ? <><Button variant="secondary" onClick={onClose}>닫기</Button><a className="button button-primary" href="/?tab=orders">기존 발주 화면 열기</a></> : <><Button variant="secondary" disabled={!canRequestChange || pendingAction !== null || changeReason.trim().length < 3} onClick={() => onChange(changeReason.trim())}>{pendingAction === 'change' ? '요청 중…' : canRequestChange ? '변경 요청' : '변경 권한 없음'}</Button><Button disabled={!canApprove || pendingAction !== null} onClick={onApprove}>{pendingAction === 'approve' ? '승인 중…' : canApprove ? <><Check size={18} /> 발주 승인</> : '승인 권한 없음'}</Button></>}</footer>
      </aside>
    </div>
  );
}
