import { useEffect, useMemo, useState } from 'react';
import { Bike, CalendarDays, Check, ChevronDown, CircleAlert, Image, MapPin, Truck, UserRound } from '../components/icons';
import type { BootstrapData, Delivery, Order } from '../types';
import { Button, EmptyState, MetricCard, StatusBadge } from '../components/ui';
import { ApiError, mutateV2, newIdempotencyKey } from '../api/client';

type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;

export function HqDeliveryPage({ data, notify, refresh }: { data: BootstrapData; notify: Notify; refresh: () => void }) {
  const [plannedDate, setPlannedDate] = useState(data.allowedDeliveryDates[0] ?? '');
  const [driverByOrder, setDriverByOrder] = useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = useState('');
  const canManage = data.capabilities.includes('hq.shipments.manage');
  const canDispatch = data.capabilities.includes('hq.shipments.dispatch');
  const drivers = (data.availableActors ?? []).filter((actor) => actor.role === 'driver');
  const shipmentOrderIds = new Set(data.deliveries.map((delivery) => delivery.orderId).filter(Boolean));
  const unassigned = data.orders.filter((order) => order.status === 'approved' && order.source !== 'legacy_unverified' && !shipmentOrderIds.has(order.id));
  const visibleDeliveries = data.deliveries.filter((delivery) => !plannedDate || delivery.plannedDate === plannedDate);
  const delivered = visibleDeliveries.filter((delivery) => delivery.status === 'delivered');
  const boxCount = visibleDeliveries.reduce((sum, delivery) => sum + delivery.itemCount, 0);
  const activeDriverIds = new Set(visibleDeliveries.map((delivery) => delivery.driverId).filter(Boolean));
  const routes = useMemo(() => drivers.map((driver) => ({ driver, deliveries: visibleDeliveries.filter((delivery) => delivery.driverId === driver.id) })).filter((entry) => entry.deliveries.length > 0), [drivers, visibleDeliveries]);

  useEffect(() => {
    if (!data.allowedDeliveryDates.includes(plannedDate)) setPlannedDate(data.allowedDeliveryDates[0] ?? '');
  }, [data.allowedDeliveryDates, plannedDate]);

  function mutationOptions() {
    return { idempotencyKey: newIdempotencyKey() };
  }

  function mutationError(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      notify('다른 담당자가 먼저 배송을 변경했습니다. 최신 상태로 새로고침합니다.', 'warning');
      refresh();
      return;
    }
    notify(error instanceof Error ? error.message : fallback, 'warning');
  }

  async function createShipment(order: Order) {
    const driverId = driverByOrder[order.id];
    if (!driverId || !plannedDate || !canManage || pendingKey) return;
    setPendingKey(`create:${order.id}`);
    try {
      await mutateV2('/shipments', { orderId: order.id, driverId, plannedDate }, mutationOptions());
      notify(`${order.storeName} 배송을 ${drivers.find((driver) => driver.id === driverId)?.name ?? '선택한 기사'}에게 배정했습니다.`, 'success');
      refresh();
    } catch (error) {
      mutationError(error, '배송 배정에 실패했습니다.');
    } finally {
      setPendingKey('');
    }
  }

  async function dispatch(delivery: Delivery) {
    if (delivery.status !== 'ready' || !canDispatch || pendingKey) return;
    setPendingKey(`dispatch:${delivery.id}`);
    try {
      await mutateV2(`/shipments/${delivery.id}/dispatch`, { expectedVersion: delivery.version ?? 1 }, mutationOptions());
      notify(`${delivery.storeName} 배송을 출발 처리했습니다.`, 'success');
      refresh();
    } catch (error) {
      mutationError(error, '배송 출발 처리에 실패했습니다.');
    } finally {
      setPendingKey('');
    }
  }

  return (
    <main id="main-content" data-testid="hq-delivery-screen" className="page page-hq" tabIndex={-1}>
      <section className="page-heading hq-heading">
        <div><p className="eyebrow"><span /> HQ LOGISTICS</p><h1>배송</h1><p>승인된 발주에 배송일과 기사를 배정하고 출발 상태를 관리합니다.</p></div>
        <div className="heading-tools">
          <label className="date-picker"><CalendarDays size={18} /><span className="sr-only">배송일</span><select value={plannedDate} onChange={(event) => setPlannedDate(event.target.value)} disabled={data.allowedDeliveryDates.length === 0}>{data.allowedDeliveryDates.map((date) => <option value={date} key={date}>{date}</option>)}</select></label>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="선택일 배송" value={`${visibleDeliveries.length}곳`} detail={`총 ${boxCount}개`} icon={<Truck size={21} />} tone="orange" />
        <MetricCard label="배정 대기" value={`${unassigned.length}곳`} detail={unassigned.length ? '기사와 배송일 선택 필요' : '승인 주문 모두 배정됨'} icon={<UserRound size={21} />} tone={unassigned.length ? 'red' : 'green'} />
        <MetricCard label="배정 기사" value={`${activeDriverIds.size}명`} detail={`${visibleDeliveries.filter((delivery) => delivery.status === 'driving').length}건 운행 중`} icon={<Bike size={21} />} />
        <MetricCard label="배송 완료" value={`${delivered.length} / ${visibleDeliveries.length}`} detail="완료 상태 기준" icon={<Image size={21} />} tone="green" />
      </section>

      <div className="delivery-board">
        <section className="panel unassigned-panel">
          <div className="panel-heading"><div><span className="section-number">01</span><div><h2>배정이 필요한 승인 주문</h2><p>실제 기사와 배송일을 선택해야 배송 건이 생성됩니다.</p></div></div><span className={`count-badge ${unassigned.length ? 'danger-count' : ''}`}>{unassigned.length}곳</span></div>
          <div className="dispatch-list">
            {unassigned.map((order) => (
              <article key={order.id} className="dispatch-card">
                <div className="dispatch-sequence"><Truck size={15} /></div>
                <div><strong>{order.storeName}</strong><p><MapPin size={14} /> {order.storeAddress || '배송지 정보 없음'}</p><small>{order.code} · {order.itemCount}개 · {plannedDate || '배송일 미선택'}</small></div>
                <label className="driver-select"><span className="sr-only">{order.storeName} 배송 기사 선택</span><select value={driverByOrder[order.id] ?? ''} onChange={(event) => setDriverByOrder((current) => ({ ...current, [order.id]: event.target.value }))}><option value="" disabled>기사 선택</option>{drivers.map((driver) => <option value={driver.id} key={driver.id}>{driver.name}</option>)}</select><ChevronDown size={15} /></label>
                <Button data-testid={`shipment-create-${order.id}`} disabled={!canManage || !plannedDate || !driverByOrder[order.id] || Boolean(pendingKey)} onClick={() => createShipment(order)}>{pendingKey === `create:${order.id}` ? '배정 중…' : canManage ? '배정' : '권한 없음'}</Button>
              </article>
            ))}
            {unassigned.length === 0 && <EmptyState icon={<Check size={24} />} title="배정할 승인 주문이 없습니다">새 승인 주문이 생기면 여기에 표시됩니다.</EmptyState>}
          </div>
        </section>

        <section className="panel route-panel">
          <div className="panel-heading"><div><span className="section-number">02</span><div><h2>기사별 배정 현황</h2><p>준비 완료된 배송만 출발 처리할 수 있습니다.</p></div></div></div>
          <div className="driver-routes">
            {routes.map(({ driver, deliveries }) => <article key={driver.id}><header><span className="driver-avatar">{driver.name.slice(0, 1)}</span><div><strong>{driver.name}</strong><small>{deliveries.length}곳 · {deliveries.reduce((sum, item) => sum + item.itemCount, 0)}개</small></div></header><div className="assigned-deliveries">{deliveries.map((delivery) => <div key={delivery.id}><span><strong>{delivery.storeName}</strong><small>{delivery.plannedDate || '날짜 미상'} · {delivery.itemCount}개</small></span><StatusBadge status={delivery.status} />{delivery.status === 'ready' && <Button data-testid={`shipment-dispatch-${delivery.id}`} disabled={!canDispatch || Boolean(pendingKey)} onClick={() => dispatch(delivery)}>{pendingKey === `dispatch:${delivery.id}` ? '처리 중…' : canDispatch ? '출발 처리' : '권한 없음'}</Button>}</div>)}</div></article>)}
            {routes.length === 0 && <EmptyState icon={<Bike size={24} />} title="선택한 날짜의 기사 배정이 없습니다">다른 배송일을 선택하거나 승인 주문을 배정해 주세요.</EmptyState>}
          </div>
          <div className="capacity-note"><CircleAlert size={17} /><span>표시 수량은 발주와 배송 DTO를 기준으로 하며 차량 적재 한도 정보는 제공되지 않습니다.</span></div>
        </section>
      </div>

      <section className="panel proof-strip"><div><Image size={25} /><div><strong>선택일 배송 완료 {delivered.length}건</strong><p>완료 상태와 수취 증빙은 기사 완료 처리 후 서버에서 확정됩니다.</p></div></div></section>
    </main>
  );
}
