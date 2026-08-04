import { useEffect, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ImagePlus,
  MapPin,
  Navigation,
  PackageCheck,
  Phone,
  Route,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from '../components/icons';
import type { BootstrapData, Delivery } from '../types';
import { canCompleteDelivery, validateDeliveryPhoto } from '../lib/workflows';
import { Button, EmptyState, MetricCard, StatusBadge } from '../components/ui';
import { ApiError, mutateV2, newIdempotencyKey } from '../api/client';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

export function DriverTodayPage({ data, notify, refresh }: { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; refresh: () => void }) {
  const [selected, setSelected] = useState<Delivery | null>(null);
  const nextDelivery = data.deliveries.find((delivery) => delivery.status === 'driving');
  const completedCount = data.deliveries.filter((delivery) => delivery.status === 'delivered').length;
  const itemCount = data.deliveries.reduce((sum, delivery) => sum + delivery.itemCount, 0);

  useEffect(() => {
    setSelected((current) => current ? data.deliveries.find((delivery) => delivery.id === current.id) ?? null : null);
  }, [data.deliveries]);

  async function completeDelivery(delivery: Delivery, file: File | null, recipientName: string) {
    if (delivery.status !== 'driving') throw new Error('운행 중인 배송만 완료할 수 있습니다.');
    if (!file) throw new Error('실제 배송 완료에는 사진 파일이 필요합니다.');
    const invalid = validateDeliveryPhoto(file);
    if (invalid) throw new Error(invalid);
    try {
      const contentType = file.type;
      const upload = await mutateV2<{ objectKey: string; uploadUrl: string; requiredHeaders?: Record<string, string> }>(`/shipments/${delivery.id}/proof-upload`, { contentType }, { idempotencyKey: newIdempotencyKey() });
      const uploadHeaders = new Headers(upload.requiredHeaders);
      if (!uploadHeaders.has('content-type')) uploadHeaders.set('content-type', contentType);
      const uploadResponse = await fetch(upload.uploadUrl, { method: 'PUT', headers: uploadHeaders, body: file });
      if (!uploadResponse.ok) throw new Error('배송 사진 저장에 실패했습니다.');
      await mutateV2(`/shipments/${delivery.id}/deliver`, { expectedVersion: delivery.version ?? 1, photoKey: upload.objectKey, recipientName }, { idempotencyKey: newIdempotencyKey() });
      setSelected(null);
      notify(`${delivery.storeName} 배송 완료와 수취 증빙이 저장되었습니다.`, 'success');
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        notify('배송 상태가 이미 변경되었습니다. 최신 상태를 불러옵니다.', 'warning');
        refresh();
      } else notify(error instanceof Error ? error.message : '배송 완료 처리에 실패했습니다.', 'warning');
      throw error;
    }
  }

  return (
    <main id="main-content" data-testid="driver-today-screen" className="page page-driver" tabIndex={-1}>
      <section className="driver-greeting"><div><p className="eyebrow"><span /> DRIVER WORKSPACE</p><h1>안녕하세요, {data.actor.name} 기사님</h1><p>오늘 배정된 배송은 <strong>{data.deliveries.length}곳</strong>입니다. 운행 중인 건만 완료할 수 있어요.</p></div></section>
      {nextDelivery ? <section className="driver-next"><div className="next-sequence"><span>NEXT</span><strong>{nextDelivery.sequence ?? '—'}</strong></div><div className="next-copy"><span className="hero-kicker"><Clock3 size={15} /> {nextDelivery.window}</span><h2>{nextDelivery.storeName}</h2><p><MapPin size={16} /> {nextDelivery.address}</p><small>{nextDelivery.itemCount}개{nextDelivery.notes ? ` · ${nextDelivery.notes}` : ''}</small></div><div className="next-actions">{nextDelivery.phone && <a className="button button-secondary" href={`tel:${nextDelivery.phone}`}><Phone size={19} /> 매장 전화</a>}<Button onClick={() => setSelected(nextDelivery)}><Navigation size={19} /> 배송 상세</Button></div></section> : <section className="panel"><EmptyState icon={<CheckCircle2 size={28} />} title="현재 운행 중인 배송이 없습니다">출발 처리된 배송이 생기면 이 화면에 표시됩니다.</EmptyState></section>}

      <section className="metrics-grid driver-metrics"><MetricCard label="오늘 배송" value={`${data.deliveries.length}곳`} detail={`총 ${itemCount}개`} icon={<Route size={21} />} /><MetricCard label="배송 완료" value={`${completedCount}곳`} detail={`${Math.max(0, data.deliveries.length - completedCount)}곳 남음`} icon={<CheckCircle2 size={21} />} tone="green" /><MetricCard label="운행 중" value={`${data.deliveries.filter((delivery) => delivery.status === 'driving').length}곳`} detail="서버 배송 상태 기준" icon={<Clock3 size={21} />} tone="orange" /></section>

      <section className="panel driver-route-panel" aria-labelledby="today-route-title"><div className="panel-heading"><div><span className="section-number">TODAY</span><div><h2 id="today-route-title">오늘 배송 순서</h2><p>출발 처리된 배송부터 현장에서 완료하세요.</p></div></div></div><ol className="driver-stop-list">{data.deliveries.map((delivery) => { const isDone = delivery.status === 'delivered'; const isDriving = delivery.status === 'driving' && !isDone; return <li key={delivery.id} className={isDone ? 'completed' : isDriving ? 'next-stop' : ''}><span className="stop-sequence">{isDone ? <Check size={18} /> : delivery.sequence ?? '—'}</span><div className="stop-line" aria-hidden="true" /><div className="stop-card"><div className="stop-time"><strong>{delivery.window === '시간 미정' ? '미정' : delivery.window.split('–')[0]}</strong><small>{delivery.window}</small></div><div className="stop-copy"><div><h3>{delivery.storeName}</h3><StatusBadge status={isDone ? 'delivered' : delivery.status} /></div><p><MapPin size={14} /> {delivery.address}</p><small><PackageCheck size={14} /> {delivery.itemCount}개{delivery.notes ? ` · ${delivery.notes}` : ''}</small></div><button type="button" className="stop-detail" onClick={() => setSelected(delivery)}>{isDone ? '상세 보기' : isDriving ? '배송 상세' : '배정 확인'} <ChevronRight size={18} /></button></div></li>; })}</ol>{data.deliveries.length === 0 && <EmptyState icon={<Route size={25} />} title="오늘 배정된 배송이 없습니다">새 배정이 생기면 목록에 표시됩니다.</EmptyState>}</section>

      <section className="driver-safety"><ShieldCheck size={24} /><div><strong>배송 사진은 꼭 현장에서 촬영해 주세요</strong><p>허용 형식과 용량을 확인한 뒤 서버가 배송 완료와 수취를 확정합니다.</p></div></section>
      {selected && <DeliveryDrawer delivery={selected} completed={selected.status === 'delivered'} actionable={selected.status === 'driving' && data.capabilities.includes('driver.deliveries.complete')} onClose={() => setSelected(null)} onComplete={(file, recipientName) => completeDelivery(selected, file, recipientName)} />}
    </main>
  );
}

function DeliveryDrawer({ delivery, completed, actionable, onClose, onComplete }: { delivery: Delivery; completed: boolean; actionable: boolean; onClose: () => void; onComplete: (file: File | null, recipientName: string) => Promise<void> }) {
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState('');
  const [recipientName, setRecipientName] = useState(delivery.recipientName ?? '');
  const [saving, setSaving] = useState(false);
  const dialogRef = useAccessibleDialog(onClose);
  const photoName = photo?.name ?? '';
  const eligible = actionable && canCompleteDelivery({ photoName, recipientName }) && !photoError;

  function choosePhoto(file: File | null) {
    if (!file) { setPhoto(null); setPhotoError(''); return; }
    const error = validateDeliveryPhoto(file);
    if (error) { setPhoto(null); setPhotoError(error); return; }
    setPhoto(file);
    setPhotoError('');
  }

  async function finish() {
    if (!eligible || saving) return;
    setSaving(true);
    try { await onComplete(photo, recipientName); } catch { setSaving(false); }
  }

  return (
    <div className="drawer-backdrop" role="presentation">
      <aside ref={dialogRef} tabIndex={-1} className="delivery-drawer" role="dialog" aria-modal="true" aria-labelledby="delivery-title">
        <header><div><span className="drawer-kicker">{completed ? '완료된 배송' : actionable ? delivery.sequence ? `${delivery.sequence}번째 배송` : '배송 순서 미등록' : '출발 전 배송'}</span><h2 id="delivery-title">{delivery.storeName}</h2></div><button type="button" className="icon-button" data-dialog-initial aria-label="배송 상세 닫기" onClick={onClose}><X size={22} /></button></header>
        <div className="delivery-drawer-body">
          <section className="destination-card"><div className="map-placeholder" aria-hidden="true"><span className="road r1" /><span className="road r2" /><span className="road r3" /><MapPin size={28} /></div><div><strong>{delivery.address}</strong><p>{delivery.window} · {delivery.itemCount}개</p><div>{delivery.phone && <a className="button button-secondary" href={`tel:${delivery.phone}`}><Phone size={18} /> 전화</a>}<a className="button button-primary" href={`https://map.kakao.com/link/search/${encodeURIComponent(delivery.address)}`} target="_blank" rel="noreferrer"><Navigation size={18} /> 길찾기</a></div></div></section>
          <section className="delivery-check"><h3>전달할 상품</h3>{delivery.lines?.length ? delivery.lines.map((line, index) => <div key={`${line.name}-${index}`}><span><PackageCheck size={19} /><span><strong>{line.name}</strong><small>{line.unit}</small></span></span><strong>{line.quantity}</strong></div>) : <p className="unavailable-copy">상품 세부 정보가 제공되지 않았습니다. 총 수량은 {delivery.itemCount}개입니다.</p>}</section>
          {actionable ? <section className="proof-form"><div className="proof-heading"><div><span className="required-label">필수</span><h3>배송 완료 사진</h3></div><small>상품과 매장 입구가 보이게 찍어주세요.</small></div>{photoName ? <div className="photo-preview"><div><Camera size={30} /><span>{photoName}</span><small>형식과 용량 확인 완료</small></div><button type="button" aria-label="배송 사진 삭제" onClick={() => choosePhoto(null)}><Trash2 size={18} /></button></div> : <label className="photo-upload"><input data-testid="delivery-proof-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => choosePhoto(event.target.files?.[0] ?? null)} /><ImagePlus size={28} /><strong>사진 촬영 또는 선택</strong><span>JPG, PNG, WEBP · 최대 10MB</span></label>}{photoError && <p className="photo-required" role="alert">{photoError}</p>}<label className="recipient-field"><span><UserRound size={17} /> 수령인 이름 <em>필수</em></span><input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} placeholder="예: 김점주" /></label>{!photoName && !photoError && <p className="photo-required" role="status"><Camera size={16} /> 사진을 올려야 완료할 수 있어요</p>}</section> : <section className="proof-form"><p className="unavailable-copy">{completed ? '서버에서 완료 처리된 배송입니다.' : '본사에서 출발 처리하기 전에는 완료 증빙을 올릴 수 없습니다.'}</p></section>}
          <div className="completion-effect"><ShieldCheck size={19} /><p><strong>완료 버튼을 누르면</strong> 서버가 배송 완료와 정상 수취를 한 번만 확정합니다.</p></div>
        </div>
        <footer><Button variant="secondary" onClick={onClose}>닫기</Button><Button data-testid="delivery-complete-button" disabled={!eligible || completed || saving} onClick={finish}>{completed ? <><Check size={18} /> 완료된 배송</> : !actionable ? '출발 전 배송' : saving ? '사진 저장 중…' : <><Camera size={18} /> 배송 완료 처리</>}</Button></footer>
      </aside>
    </div>
  );
}
