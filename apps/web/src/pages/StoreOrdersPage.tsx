import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Minus,
  PackageCheck,
  Plus,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Truck,
  X,
} from '../components/icons';
import { formatMoney, formatShortDate, grossToVatParts } from '../lib/workflows';
import type { BootstrapData, DataSource, Order, Product } from '../types';
import { Button, MetricCard, StatusBadge } from '../components/ui';
import { mutateV2, newIdempotencyKey } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

function readableDeliveryDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(date);
}

export function StoreOrdersPage({ data, source, notify, refresh }: { data: BootstrapData; source: DataSource; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [wizardOrder, setWizardOrder] = useState<Order | null | undefined>(undefined);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const ownOrders = data.orders.filter((order) => order.storeName === data.store.name);
  const current = ownOrders[0];
  const changeRequested = ownOrders.find((order) => order.status === 'change_requested');
  const arriving = ownOrders.find((order) => order.status === 'out_for_delivery');
  const previous = ownOrders.find((order) => order.id !== current?.id);
  const availableDate = data.allowedDeliveryDates[0];
  const monthOrderTotal = ownOrders.reduce((sum, order) => sum + order.grossAmount, 0);
  const generatedAt = new Date(data.generatedAt);

  async function submitOrder(cart: Record<string, number>, requestedDeliveryDate: string, idempotencyKey: string) {
    if (source === 'demo') {
      setWizardOrder(undefined);
      notify(wizardOrder ? '수정한 발주가 다시 제출되었습니다.' : '새 발주가 제출되었습니다.', 'success');
      return;
    }
    try {
      const items = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity }));
      const actorId = data.meta.appMode === 'demo' ? data.actor.id : undefined;
      const path = wizardOrder ? `/orders/${wizardOrder.id}/resubmit` : '/orders/submit-new';
      const body = wizardOrder
        ? { expectedVersion: wizardOrder.version, requestedDeliveryDate, items }
        : { storeId: data.store.id, requestedDeliveryDate, items };
      await mutateV2<{ order: { id: string; version: number; status: string } }>(path, body, { idempotencyKey, actorId });
      setWizardOrder(undefined);
      notify(wizardOrder ? '수정한 발주가 재제출되었습니다. 본사에서 다시 검토합니다.' : '발주가 제출되었습니다. 본사 승인 대기 상태로 이동합니다.', 'success');
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '발주 제출에 실패했습니다.', 'warning');
      throw error;
    }
  }

  async function cancelOrder(order: Order) {
    if (!data.capabilities.includes('store.orders.cancel') || cancellingId) return;
    if (!window.confirm(`${order.code} 발주를 취소할까요? 취소 후에는 되돌릴 수 없습니다.`)) return;
    setCancellingId(order.id);
    try {
      if (source === 'live') await mutateV2(`/orders/${order.id}/cancel`, { expectedVersion: order.version, reason: '점주 직접 취소' }, {
        idempotencyKey: newIdempotencyKey(), actorId: data.meta.appMode === 'demo' ? data.actor.id : undefined,
      });
      notify(`${order.code} 발주를 취소했습니다.`, 'success');
      if (source === 'live') refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '발주 취소에 실패했습니다.', 'warning'); }
    finally { setCancellingId(null); }
  }

  return (
    <main id="main-content" data-testid="store-order-screen" className="page page-store" tabIndex={-1}>
      <section className="page-heading">
        <div>
          <p className="eyebrow"><span /> STORE WORKSPACE</p>
          <h1>발주·입고</h1>
          <p>무엇을 해야 하는지 순서대로 안내해 드릴게요.</p>
        </div>
        <div className="heading-date"><CalendarDays size={18} aria-hidden="true" /><span><strong>{Number.isNaN(generatedAt.getTime()) ? '최근 동기화' : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(generatedAt)}</strong><small>운영 데이터 기준</small></span></div>
      </section>

      <section className="store-hero" aria-labelledby="store-next-action">
        <div className="hero-copy">
          <span className="hero-kicker"><Sparkles size={15} aria-hidden="true" /> 지금 하면 좋아요</span>
          <h2 id="store-next-action">{changeRequested ? '본사의 변경 요청을 확인해 주세요' : '다음 입고분을 발주해 주세요'}</h2>
          <p>{changeRequested ? <><strong>{changeRequested.changeRequest?.reason ?? '상품 수량과 입고일을 다시 확인해 주세요.'}</strong></> : availableDate ? <><strong>{readableDeliveryDate(availableDate)}</strong>부터 선택할 수 있어요.</> : '현재 선택 가능한 입고일이 없습니다. 본사 운영팀에 문의해 주세요.'}</p>
          <div className="deadline"><Clock3 size={17} aria-hidden="true" /><span>선택 가능한 입고일</span><strong>{data.allowedDeliveryDates.length}개</strong></div>
        </div>
        <Button onClick={() => setWizardOrder(changeRequested ?? null)} aria-haspopup="dialog" disabled={!availableDate || !data.capabilities.includes('store.orders.create')}>
          <ShoppingBag size={19} aria-hidden="true" /> {changeRequested ? '수정 발주 열기' : '새 발주 시작'} <ArrowRight size={18} aria-hidden="true" />
        </Button>
      </section>

      <section className="metrics-grid store-metrics" aria-label="발주 현황 요약">
        <MetricCard label="배송 중" value={arriving ? '1건' : '0건'} detail={arriving ? `오늘 ${formatShortDate(arriving.deliveryDate)} 도착` : '예정 없음'} icon={<Truck size={21} />} tone="orange" />
        <MetricCard label="승인 기다리는 중" value={`${ownOrders.filter((order) => order.status === 'submitted').length}건`} detail="본사에서 확인하고 있어요" icon={<Clock3 size={21} />} />
        <MetricCard label="표시된 발주 합계" value={formatMoney(monthOrderTotal)} detail={`${ownOrders.length}건 · 현재 조회 데이터 기준`} icon={<PackageCheck size={21} />} tone="green" />
      </section>

      <div className="store-layout">
        <section className="panel action-panel" aria-labelledby="today-actions-title">
          <div className="panel-heading">
            <div><span className="section-number">01</span><div><h2 id="today-actions-title">오늘 할 일</h2><p>중요한 순서대로 확인하세요.</p></div></div>
            <span className="count-badge">{(availableDate ? 1 : 0) + (changeRequested ? 1 : 0)}개</span>
          </div>
          <div className="action-list">
            {changeRequested && <button type="button" className="action-card urgent" onClick={() => setWizardOrder(changeRequested)}>
              <span className="action-icon"><AlertCircle size={22} aria-hidden="true" /></span>
              <span className="action-copy"><span className="action-label">변경 요청</span><strong>{changeRequested.code} 수정하기</strong><small>{changeRequested.changeRequest?.reason ?? '수량과 입고일 재확인 필요'}</small></span>
              <ChevronRight size={21} aria-hidden="true" />
            </button>}
            <button type="button" className={`action-card ${changeRequested ? '' : 'urgent'}`} onClick={() => setWizardOrder(null)} disabled={!availableDate}>
              <span className="action-icon"><ShoppingBag size={22} aria-hidden="true" /></span>
              <span className="action-copy"><span className="action-label">발주 가능</span><strong>다음 입고분 발주하기</strong><small>{availableDate ? `${readableDeliveryDate(availableDate)}부터 선택 가능` : '입고일 등록 대기'}</small></span>
              <ChevronRight size={21} aria-hidden="true" />
            </button>
            {arriving && <div className="action-card">
              <span className="action-icon green"><Truck size={22} aria-hidden="true" /></span>
              <span className="action-copy"><span className="action-label green-label">배송 중</span><strong>{arriving.code} 입고 대기</strong><small>{formatShortDate(arriving.deliveryDate)} 예정 · 최신 배송 상태</small></span>
            </div>}
          </div>
        </section>

        <section className="panel timeline-panel" aria-labelledby="current-order-title">
          <div className="panel-heading">
            <div><span className="section-number">02</span><div><h2 id="current-order-title">진행 중인 발주</h2><p>{current?.code ?? '최근 발주'}</p></div></div>
            {current && <StatusBadge status={current.status} />}
          </div>
          {current && (
            <>
              <div className="order-summary-line"><span>{current.itemCount}개 품목</span><strong>{formatMoney(current.grossAmount)}</strong></div>
              <ol className="progress-timeline">
                {current.timeline.map((item, index) => (
                  <li key={item.label} className={item.done ? 'done' : item.active ? 'active' : ''}>
                    <span className="timeline-marker">{item.done ? <Check size={14} aria-hidden="true" /> : item.active ? <Clock3 size={14} aria-hidden="true" /> : <Circle size={9} aria-hidden="true" />}</span>
                    <span><strong>{item.label}</strong>{item.at && <small>{item.at}</small>}</span>
                    {index < current.timeline.length - 1 && <span className="timeline-line" />}
                  </li>
                ))}
              </ol>
              <div className="timeline-note"><Clock3 size={16} aria-hidden="true" /><span>승인과 배송 상태가 바뀌면 이 진행선에 반영됩니다.</span></div>
              {current.changeRequest && <div className="notice-box order-change-notice"><AlertCircle size={17} aria-hidden="true" /><span><strong>본사 변경 요청</strong><br />{current.changeRequest.reason}</span></div>}
              <div className="timeline-order-actions">
                {current.status === 'change_requested' && <Button variant="secondary" onClick={() => setWizardOrder(current)}>수정해서 다시 제출</Button>}
                {['submitted', 'change_requested'].includes(current.status) && data.capabilities.includes('store.orders.cancel') && <Button variant="secondary" disabled={cancellingId === current.id} onClick={() => cancelOrder(current)}>{cancellingId === current.id ? '취소 중…' : '발주 취소'}</Button>}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="panel repeat-panel" aria-labelledby="repeat-title">
        <div className="panel-heading">
          <div><span className="section-number">03</span><div><h2 id="repeat-title">지난 발주 그대로</h2><p>수량만 확인하고 빠르게 다시 주문할 수 있어요.</p></div></div>
        </div>
        {previous ? <div className="repeat-order">
          <div className="repeat-icon"><RotateCcw size={23} aria-hidden="true" /></div>
          <div><strong>{new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(new Date(previous.createdAt))} 발주</strong><p>{previous.lines?.[0]?.name ?? '상품 내역'} 외 {Math.max(0, (previous.lines?.length ?? 1) - 1)}종 · 총 {previous.itemCount}개</p></div>
          <strong className="repeat-amount">{formatMoney(previous.grossAmount)}</strong>
          <Button variant="secondary" onClick={() => setWizardOrder(null)}>불러오기</Button>
        </div> : <p className="panel-empty-copy">다시 불러올 이전 발주가 없습니다.</p>}
      </section>

      {wizardOrder !== undefined && <OrderWizard products={data.products} storeName={data.store.name} source={source} initialOrder={wizardOrder ?? undefined} allowedDeliveryDates={data.allowedDeliveryDates} onClose={() => setWizardOrder(undefined)} onDone={submitOrder} />}
    </main>
  );
}

function OrderWizard({ products, storeName, source, initialOrder, allowedDeliveryDates, onClose, onDone }: { products: Product[]; storeName: string; source: DataSource; initialOrder?: Order; allowedDeliveryDates: string[]; onClose: () => void; onDone: (cart: Record<string, number>, requestedDeliveryDate: string, idempotencyKey: string) => Promise<void> }) {
  const [step, setStep] = useState(1);
  const [cart, setCart] = useState<Record<string, number>>(() => initialOrder?.lines?.length
    ? Object.fromEntries(initialOrder.lines.filter((line) => line.productId).map((line) => [line.productId!, line.quantity]))
    : Object.fromEntries(products.slice(0, 3).map((product, index) => [product.id, index === 0 ? 2 : 1])));
  const [deliveryDate, setDeliveryDate] = useState(allowedDeliveryDates.includes(initialOrder?.deliveryDate.slice(0, 10) ?? '') ? initialOrder!.deliveryDate.slice(0, 10) : allowedDeliveryDates[0] ?? '');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const submissionKey = useRef(newIdempotencyKey()).current;
  const lines = products.filter((product) => (cart[product.id] ?? 0) > 0);
  const total = useMemo(() => lines.reduce((sum, product) => sum + product.grossPrice * (cart[product.id] ?? 0), 0), [cart, lines]);
  const vat = grossToVatParts(total);
  const boxCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const dialogRef = useAccessibleDialog(onClose);

  function quantity(productId: string, delta: number) {
    setCart((current) => ({ ...current, [productId]: Math.max(0, (current[productId] ?? 0) + delta) }));
  }

  async function finish() {
    setSaving(true);
    try { await onDone(cart, deliveryDate, submissionKey); } catch { setSaving(false); }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} tabIndex={-1} className="order-wizard" role="dialog" aria-modal="true" aria-labelledby="order-dialog-title">
        <header className="wizard-header">
          <div><span className="wizard-kicker">{storeName} · {initialOrder ? `${initialOrder.code} 수정` : '새 발주'}</span><h2 id="order-dialog-title">{step === 1 ? initialOrder ? '요청받은 내용을 수정해 주세요' : '필요한 상품을 담아주세요' : step === 2 ? '수량과 금액을 확인하세요' : '제출 전 마지막 확인이에요'}</h2></div>
          <button type="button" className="icon-button" data-dialog-initial aria-label="발주 창 닫기" onClick={onClose}><X size={22} /></button>
        </header>

        <ol className="wizard-steps" aria-label="발주 진행 단계">
          {['1. 상품 담기', '2. 수량 확인', '3. 발주 제출'].map((label, index) => (
            <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''} aria-current={step === index + 1 ? 'step' : undefined}>
              <span>{step > index + 1 ? <Check size={14} aria-hidden="true" /> : index + 1}</span><strong>{label}</strong>
            </li>
          ))}
        </ol>

        <div className="wizard-content">
          {step === 1 && (
            <>
              <div className="wizard-tip"><Sparkles size={17} aria-hidden="true" /><span><strong>추천 수량</strong>은 최근 4주 판매량과 요일을 기준으로 계산했어요.</span></div>
              <div className="product-grid">
                {products.map((product) => {
                  const count = cart[product.id] ?? 0;
                  return (
                    <article className={`product-card ${count > 0 ? 'selected' : ''}`} key={product.id}>
                      <div className={`product-visual product-${product.id}`} aria-hidden="true"><span>{product.name.slice(0, 1)}</span></div>
                      <div className="product-copy">{product.recommended && <span className="recommend-badge">추천</span>}<h3>{product.name}</h3><p>{product.unit}</p>{product.note && <small>{product.note}</small>}<strong>{formatMoney(product.grossPrice)}</strong></div>
                      <div className="quantity-control" aria-label={`${product.name} 수량`}>
                        <button type="button" aria-label={`${product.name} 한 박스 빼기`} onClick={() => quantity(product.id, -1)} disabled={count === 0}><Minus size={17} /></button>
                        <output aria-live="polite">{count}</output>
                        <button type="button" aria-label={`${product.name} 한 박스 추가`} onClick={() => quantity(product.id, 1)}><Plus size={17} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
          {step === 2 && (
            <div className="review-layout">
              <section className="review-lines" aria-labelledby="order-lines-title">
                <h3 id="order-lines-title">상품 {lines.length}종 · 총 {boxCount}박스</h3>
                {lines.map((product) => (
                  <div className="review-line" key={product.id}><div><strong>{product.name}</strong><small>{product.unit}</small></div><div className="inline-quantity"><button type="button" aria-label={`${product.name} 수량 줄이기`} onClick={() => quantity(product.id, -1)}><Minus size={16} /></button><span>{cart[product.id]}박스</span><button type="button" aria-label={`${product.name} 수량 늘리기`} onClick={() => quantity(product.id, 1)}><Plus size={16} /></button></div><strong>{formatMoney(product.grossPrice * cart[product.id])}</strong></div>
                ))}
              </section>
              <aside className="delivery-choice">
                <h3>입고 예정일</h3>
                {allowedDeliveryDates.map((date) => <label className={`radio-card ${deliveryDate === date ? 'selected' : ''}`} key={date}><input type="radio" name="delivery" value={date} checked={deliveryDate === date} onChange={() => setDeliveryDate(date)} /><span><strong>{readableDeliveryDate(date)}</strong><small>배송 시간은 배차 후 확정</small></span>{deliveryDate === date && <CheckCircle2 size={20} />}</label>)}
                <div className="notice-box"><AlertCircle size={17} aria-hidden="true" /><span>발주 제출 후 본사 승인이 필요해요. 변경이 필요하면 앱으로 알려드려요.</span></div>
              </aside>
            </div>
          )}
          {step === 3 && (
            <div className="final-review">
              <div className="final-symbol"><PackageCheck size={30} aria-hidden="true" /></div>
              <h3>{storeName} 발주 내용을 확인해 주세요</h3>
              <p>{initialOrder ? '다시 제출하면 본사 운영팀이 수정 내용을 재검토합니다.' : '제출하면 본사 운영팀이 확인한 뒤 배송 준비를 시작합니다.'}</p>
              <dl className="final-summary">
                <div><dt>입고 예정</dt><dd>{deliveryDate ? readableDeliveryDate(deliveryDate) : '선택 필요'}</dd></div>
                <div><dt>주문 수량</dt><dd>{lines.length}종 · {boxCount}박스</dd></div>
                <div><dt>공급가액</dt><dd>{formatMoney(vat.supply)}</dd></div>
                <div><dt>부가세</dt><dd>{formatMoney(vat.vat)}</dd></div>
                <div className="total"><dt>결제 예정 금액</dt><dd>{formatMoney(vat.gross)}</dd></div>
              </dl>
              <label className="confirm-check"><input type="checkbox" checked={confirming} onChange={(event) => setConfirming(event.target.checked)} /><span>상품, 수량, 입고 예정일을 확인했습니다.</span></label>
              {source === 'demo' && <p className="demo-caution"><AlertCircle size={16} aria-hidden="true" /> 데모 데이터이므로 실제 발주나 결제가 발생하지 않습니다.</p>}
            </div>
          )}
        </div>

        <footer className="wizard-footer">
          <div><span>{boxCount}박스</span><strong>{formatMoney(total)}</strong><small>부가세 포함</small></div>
          <div className="wizard-buttons">
            {step > 1 && <Button variant="secondary" onClick={() => setStep((value) => value - 1)}>이전</Button>}
            {step < 3 ? <Button disabled={boxCount === 0 || !deliveryDate} onClick={() => setStep((value) => value + 1)}>다음 단계 <ArrowRight size={18} /></Button> : <Button disabled={!confirming || saving || !deliveryDate} onClick={finish}>{saving ? '제출 중…' : initialOrder ? '수정 발주 다시 제출' : '발주 제출하기'} <Check size={18} /></Button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
