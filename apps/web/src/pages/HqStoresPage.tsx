import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  createNoticeV2, deleteNoticeV2, loadNaverMapKeyV2, loadNoticesV2, newIdempotencyKey,
  saveNaverMapKeyV2, updatePosStoreV2, type NoticeRow,
} from '../api/client';
import { Button, EmptyState } from '../components/ui';
import { Store as StoreIcon } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

/* ── 네이버 지도 최소 타입 (전역 스크립트 주입) ── */
type NaverLatLng = { lat(): number; lng(): number };
type NaverMarkerIcon = { content: string; anchor?: unknown };
type NaverMarker = { setMap(map: unknown): void; setIcon(icon: NaverMarkerIcon): void; setZIndex(value: number): void };
type NaverMaps = {
  Map: new (el: HTMLElement, options: { center: NaverLatLng; zoom: number }) => unknown;
  LatLng: new (lat: number, lng: number) => NaverLatLng;
  Marker: new (options: { position: NaverLatLng; map: unknown; title?: string; icon?: NaverMarkerIcon; zIndex?: number }) => NaverMarker;
  Polyline: new (options: { map: unknown; path: NaverLatLng[]; strokeColor?: string; strokeWeight?: number }) => NaverMarker;
  Event: { addListener(target: unknown, name: string, handler: () => void): void };
  Service: {
    geocode(options: { query: string }, callback: (status: string, response: { v2: { addresses: Array<{ x: string; y: string }> } }) => void): void;
    Status: { OK: string };
  };
};
const getNaverMaps = () => (window as unknown as { naver?: { maps?: NaverMaps } }).naver?.maps;

/** 지도 핀 — 기존 가맹점은 파랑, 예비 출점 후보는 빨강. 선택되면 커지고 흰 테두리·그림자로 강조된다. */
function pinIcon(kind: 'store' | 'candidate', selected: boolean): NaverMarkerIcon {
  const fill = kind === 'candidate' ? '#e34948' : '#2a78d6';
  const size = selected ? 40 : 30;
  const ring = selected ? '<circle cx="12" cy="12" r="11" fill="none" stroke="#ffffff" stroke-width="3"/>' : '';
  return {
    content: `<div style="width:${size}px;height:${size}px;transform:translate(-50%,-100%);
      filter:drop-shadow(0 ${selected ? 4 : 2}px ${selected ? 6 : 3}px rgba(0,0,0,${selected ? 0.45 : 0.3}))">
      <svg viewBox="0 0 24 34" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M12 33C12 33 23 20.5 23 12A11 11 0 1 0 1 12c0 8.5 11 21 11 21z" fill="${fill}" stroke="#ffffff" stroke-width="${selected ? 2.5 : 1.5}"/>
        ${ring}
        <circle cx="12" cy="12" r="4.5" fill="#ffffff"/>
      </svg></div>`,
  };
}

/** V1 fmtPhone 이식 — 자릿수 기준 하이픈 자동 삽입 */
export function formatPhone(digits: string): string {
  const value = digits.replace(/[^0-9]/g, '');
  if (value.length === 11) return `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7)}`;
  if (value.length === 10) return value.startsWith('02')
    ? `${value.slice(0, 2)}-${value.slice(2, 6)}-${value.slice(6)}`
    : `${value.slice(0, 3)}-${value.slice(3, 6)}-${value.slice(6)}`;
  if (value.length === 9 && value.startsWith('02')) return `${value.slice(0, 2)}-${value.slice(2, 5)}-${value.slice(5)}`;
  return value;
}

/** 두 좌표의 직선거리(km) — 하버사인 */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 100) / 100;
}

type LedgerStore = BootstrapData['stores'][number];
type Draft = { name: string; storeKind: string; region: string; roadAddress: string; notificationPhone: string; openDate: string; active: boolean };

const draftFrom = (store: LedgerStore): Draft => ({
  name: store.name, storeKind: store.storeKind ?? '', region: store.region ?? '', roadAddress: store.roadAddress ?? '',
  notificationPhone: formatPhone(store.notificationPhone ?? ''), openDate: store.openDate ?? '', active: store.active !== false,
});

export function HqStoresPage({ data, notify, refresh }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void; refresh: () => void }) {
  const isMaster = data.actor.role === 'hq_master' || data.actor.role === 'master';
  const stores = data.stores;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  /* ── 공지 ── */
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [noticeForm, setNoticeForm] = useState({ title: '', body: '', pinned: false });
  const reloadNotices = useCallback(async () => {
    try { setNotices((await loadNoticesV2()).notices); } catch { /* 공지는 부가 정보 — 실패해도 대장은 동작한다 */ }
  }, []);
  useEffect(() => { void reloadNotices(); }, [reloadNotices]);

  /* ── 지도 키 ── */
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [mapKeyInput, setMapKeyInput] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadNaverMapKeyV2().then((result) => { if (!cancelled) { setMapKey(result.keyId); setMapKeyInput(result.keyId ?? ''); } })
      .catch(() => { if (!cancelled) setMapKey(null); });
    return () => { cancelled = true; };
  }, []);

  /* ── 지도 ── */
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<unknown>(null);
  const markerPositions = useRef(new Map<string, { lat: number; lng: number }>());
  const markerRefs = useRef(new Map<string, NaverMarker>());
  const distanceLine = useRef<NaverMarker | null>(null);
  const [mapStatus, setMapStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'auth-error'>('idle');
  const [geocodeMisses, setGeocodeMisses] = useState<string[]>([]);
  const [selectedForDistance, setSelectedForDistance] = useState<string[]>([]);
  /* 가맹 상담용 예비 출점 후보 — 지도에 빨간 핀으로 얹고 기존 매장과 거리를 잰다(저장하지 않음) */
  const [candidateAddress, setCandidateAddress] = useState('');
  const [candidateLabel, setCandidateLabel] = useState('');
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; address: string }>>([]);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState('');

  const geocodable = useMemo(() => stores.filter((store) => (store.roadAddress ?? '').trim().length > 0), [stores]);

  useEffect(() => {
    if (!mapKey || geocodable.length === 0 || !mapContainer.current || mapInstance.current) return;
    setMapStatus('loading');
    const scriptId = 'naver-maps-sdk';
    let initRetries = 0;
    const init = () => {
      const maps = getNaverMaps();
      const container = mapContainer.current;
      if (!maps || !container) { setMapStatus('error'); return; }
      /* geocoder 서브모듈은 본체 onload 뒤에 비동기로 붙는다 — 준비될 때까지 짧게 재시도 */
      if (!maps.Service && initRetries < 40) { initRetries += 1; setTimeout(init, 125); return; }
      if (!maps.Service) { setMapStatus('error'); return; }
      const map = new maps.Map(container, { center: new maps.LatLng(37.5665, 126.978), zoom: 10 });
      mapInstance.current = map;
      setMapStatus('ready');
      const misses: string[] = [];
      /* 순차 지오코딩 — 매장 수가 적어 속도보다 요청 안정성을 우선한다 */
      const queue = [...geocodable];
      const next = () => {
        const store = queue.shift();
        if (!store) { setGeocodeMisses(misses); return; }
        maps.Service.geocode({ query: store.roadAddress! }, (status, response) => {
          const first = response?.v2?.addresses?.[0];
          if (status === maps.Service.Status.OK && first) {
            const position = { lat: Number(first.y), lng: Number(first.x) };
            markerPositions.current.set(store.id, position);
            const marker = new maps.Marker({ position: new maps.LatLng(position.lat, position.lng), map, title: store.name,
              icon: pinIcon('store', false) });
            markerRefs.current.set(store.id, marker);
            maps.Event.addListener(marker, 'click', () => toggleDistanceTarget(store.id));
          } else {
            misses.push(store.name);
          }
          next();
        });
      };
      next();
    };
    /* 네이버 SDK는 키·도메인 인증 실패 시 이 전역 콜백을 부른다 — 스크립트 차단과 구분해 안내 */
    (window as { navermap_authFailure?: () => void }).navermap_authFailure = () => setMapStatus('auth-error');
    const existing = document.getElementById(scriptId);
    if (existing) { init(); return; }
    const script = document.createElement('script');
    script.id = scriptId;
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(mapKey)}&submodules=geocoder`;
    script.async = true;
    script.onload = init;
    script.onerror = () => setMapStatus('error');
    document.head.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, geocodable.length]);

  function toggleDistanceTarget(pointId: string) {
    setSelectedForDistance((current) => {
      const next = current.includes(pointId) ? current.filter((id) => id !== pointId)
        : current.length >= 2 ? [current[1]!, pointId] : [...current, pointId];
      drawDistance(next);
      paintSelection(next);
      return next;
    });
  }

  /** 선택 상태를 핀 모양에 반영한다 — 선택된 핀은 커지고 흰 테두리가 생긴다. */
  function paintSelection(selectedIds: string[]) {
    for (const [id, marker] of markerRefs.current) {
      const kind = id.startsWith('candidate:') ? 'candidate' : 'store';
      const selected = selectedIds.includes(id);
      marker.setIcon(pinIcon(kind, selected));
      marker.setZIndex(selected ? 200 : kind === 'candidate' ? 100 : 50);
    }
  }

  /** 예비 출점 후보 주소를 지오코딩해 빨간 핀으로 올린다(대장에 저장하지 않는 상담용 임시 표시). */
  function addCandidate(event: FormEvent) {
    event.preventDefault();
    const address = candidateAddress.trim();
    if (!address || candidateBusy) return;
    const maps = getNaverMaps();
    if (!maps?.Service || !mapInstance.current) { setCandidateError('지도가 아직 준비되지 않았습니다.'); return; }
    setCandidateBusy(true);
    setCandidateError('');
    maps.Service.geocode({ query: address }, (status, response) => {
      const first = response?.v2?.addresses?.[0];
      if (status !== maps.Service.Status.OK || !first) {
        setCandidateError('주소를 찾지 못했습니다. 도로명주소로 다시 입력해 주세요.');
        setCandidateBusy(false);
        return;
      }
      const id = `candidate:${Date.now()}`;
      const name = candidateLabel.trim() || `예비 ${candidates.length + 1}`;
      const position = { lat: Number(first.y), lng: Number(first.x) };
      markerPositions.current.set(id, position);
      const marker = new maps.Marker({ position: new maps.LatLng(position.lat, position.lng),
        map: mapInstance.current, title: `${name} (예비)`, icon: pinIcon('candidate', false), zIndex: 100 });
      markerRefs.current.set(id, marker);
      maps.Event.addListener(marker, 'click', () => toggleDistanceTarget(id));
      setCandidates((current) => [...current, { id, name, address }]);
      setCandidateAddress('');
      setCandidateLabel('');
      setCandidateBusy(false);
      /* 후보를 넣자마자 가장 가까운 기존 매장과의 거리를 바로 보여준다 */
      const nearest = nearestStoreTo(position);
      toggleDistanceTarget(id);
      if (nearest) setTimeout(() => toggleDistanceTarget(nearest), 0);
    });
  }

  /** 후보 지점에서 가장 가까운 기존 매장 id */
  function nearestStoreTo(position: { lat: number; lng: number }): string | null {
    let bestId: string | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const store of stores) {
      const target = markerPositions.current.get(store.id);
      if (!target) continue;
      const km = Number(haversineKm(position, target));
      if (km < bestKm) { bestKm = km; bestId = store.id; }
    }
    return bestId;
  }

  function removeCandidate(id: string) {
    markerRefs.current.get(id)?.setMap(null);
    markerRefs.current.delete(id);
    markerPositions.current.delete(id);
    setCandidates((current) => current.filter((item) => item.id !== id));
    setSelectedForDistance((current) => {
      const next = current.filter((item) => item !== id);
      drawDistance(next);
      paintSelection(next);
      return next;
    });
  }

  function drawDistance(ids: string[]) {
    const maps = getNaverMaps();
    if (distanceLine.current) { distanceLine.current.setMap(null); distanceLine.current = null; }
    if (!maps || !mapInstance.current || ids.length !== 2) return;
    const [a, b] = [markerPositions.current.get(ids[0]!), markerPositions.current.get(ids[1]!)];
    if (!a || !b) return;
    distanceLine.current = new maps.Polyline({
      map: mapInstance.current, path: [new maps.LatLng(a.lat, a.lng), new maps.LatLng(b.lat, b.lng)],
      strokeColor: '#e8590c', strokeWeight: 3,
    });
  }

  const pointName = (id: string) => candidates.find((item) => item.id === id)?.name
    ?? stores.find((store) => store.id === id)?.name ?? id;

  const distanceText = useMemo(() => {
    if (selectedForDistance.length !== 2) return '';
    const [aId, bId] = selectedForDistance;
    const a = markerPositions.current.get(aId!);
    const b = markerPositions.current.get(bId!);
    if (!a || !b) return '';
    const mark = (id: string) => `${pointName(id)}${id.startsWith('candidate:') ? ' (예비)' : ''}`;
    return `${mark(aId!)} ↔ ${mark(bId!)} 직선거리 ${haversineKm(a, b)}km`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedForDistance, stores, candidates]);

  /* ── 인라인 수정 ── */
  function startEdit(store: LedgerStore) { setEditingId(store.id); setDraft(draftFrom(store)); }
  async function saveEdit(store: LedgerStore) {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await updatePosStoreV2(store.id, {
        expectedVersion: store.version, name: draft.name, region: draft.region, roadAddress: draft.roadAddress,
        notificationPhone: draft.notificationPhone, openDate: draft.openDate || null, active: draft.active,
        ...(draft.storeKind === '직영' || draft.storeKind === '가맹' ? { storeKind: draft.storeKind } : {}),
      });
      notify(result.changed.length > 0 ? `${draft.name} 저장 — ${result.changed.length}개 항목 변경` : '변경된 내용이 없습니다.',
        result.changed.length > 0 ? 'success' : 'info');
      setEditingId(null); setDraft(null);
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '저장에 실패했습니다.', 'warning');
    } finally { setBusy(false); }
  }

  /* ── CSV 내보내기 (V1 이식: BOM 포함, 엑셀 호환) ── */
  function exportCsv() {
    const header = ['코드', '매장명', '구분', '지역', '도로명주소', '전화', '오픈일', '활성'];
    const cell = (value: string) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const rows = stores.map((store) => [store.code ?? '', store.name, store.storeKind ?? '', store.region ?? '',
      store.roadAddress ?? '', formatPhone(store.notificationPhone ?? ''), store.openDate ?? '', store.active === false ? 'N' : 'Y']
      .map(cell).join(','));
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `매장대장_${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function submitNotice() {
    const title = noticeForm.title.trim();
    if (title.length < 2) { notify('공지 제목(2자 이상)을 입력해 주세요.', 'warning'); return; }
    try {
      await createNoticeV2({ title, ...(noticeForm.body.trim() ? { body: noticeForm.body.trim() } : {}), pinned: noticeForm.pinned }, newIdempotencyKey());
      setNoticeForm({ title: '', body: '', pinned: false });
      notify('공지를 등록했습니다. 매장 발주 화면 상단에 표시됩니다.', 'success');
      await reloadNotices();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '공지 등록에 실패했습니다.', 'warning'); }
  }
  async function removeNotice(notice: NoticeRow) {
    if (!window.confirm(`공지 "${notice.title}"을(를) 내릴까요?`)) return;
    try { await deleteNoticeV2(notice.id); await reloadNotices(); notify('공지를 내렸습니다.', 'info'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : '공지 삭제에 실패했습니다.', 'warning'); }
  }

  return (
    <section className="page" aria-labelledby="stores-heading">
      <header className="page-head">
        <div>
          <h1 id="stores-heading">매장 대장</h1>
          <p>직영·가맹 매장의 기준 정보를 한곳에서 관리합니다 · 수정 내역은 감사 로그에 남습니다</p>
        </div>
        <div className="page-actions">
          <Button type="button" variant="secondary" onClick={exportCsv} disabled={stores.length === 0}>CSV 내보내기</Button>
        </div>
      </header>

      {stores.length === 0
        ? <EmptyState icon={<StoreIcon size={22} aria-hidden="true" />} title="등록된 매장이 없습니다">매출현황 탭에서 매장을 등록하면 대장에 나타납니다.</EmptyState>
        : (
          <div className="table-wrap">
            <table className="data-table" aria-label="매장 대장">
              <thead><tr>
                <th scope="col">코드</th><th scope="col">매장명</th><th scope="col">구분</th><th scope="col">지역</th>
                <th scope="col">도로명주소</th><th scope="col">전화</th><th scope="col">오픈일</th><th scope="col">상태</th><th scope="col" aria-label="동작" />
              </tr></thead>
              <tbody>
                {stores.map((store) => {
                  const editing = editingId === store.id && draft;
                  return (
                    <tr key={store.id} className={store.active === false ? 'muted' : undefined}>
                      <td className="muted">{store.code ?? '—'}</td>
                      <td className="strong">{editing
                        ? <input aria-label="매장명" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                        : store.name}</td>
                      <td>{editing
                        ? <select aria-label="구분" value={draft.storeKind} onChange={(event) => setDraft({ ...draft, storeKind: event.target.value })}>
                            <option value="">미지정</option><option value="직영">직영</option><option value="가맹">가맹</option>
                          </select>
                        : store.storeKind ?? <span className="muted">미지정</span>}</td>
                      <td>{editing
                        ? <input aria-label="지역" value={draft.region} onChange={(event) => setDraft({ ...draft, region: event.target.value })} placeholder="예: 서울 금천" />
                        : store.region ?? <span className="muted">—</span>}</td>
                      <td>{editing
                        ? <input aria-label="도로명주소" value={draft.roadAddress} onChange={(event) => setDraft({ ...draft, roadAddress: event.target.value })} placeholder="예: 서울 금천구 …" />
                        : store.roadAddress ?? <span className="muted">—</span>}</td>
                      <td className="num">{editing
                        ? <input aria-label="전화" inputMode="numeric" value={draft.notificationPhone}
                            onChange={(event) => setDraft({ ...draft, notificationPhone: formatPhone(event.target.value) })} placeholder="010-0000-0000" />
                        : formatPhone(store.notificationPhone ?? '') || <span className="muted">—</span>}</td>
                      <td className="num">{editing
                        ? <input aria-label="오픈일" type="date" value={draft.openDate} onChange={(event) => setDraft({ ...draft, openDate: event.target.value })} />
                        : store.openDate ?? <span className="muted">—</span>}</td>
                      <td>{editing
                        ? <label className="inline-check"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> 활성</label>
                        : store.active === false ? <span className="tone-red">비활성</span> : <span className="tone-green">활성</span>}</td>
                      <td>{editing
                        ? <span className="row-actions">
                            <Button type="button" onClick={() => void saveEdit(store)} disabled={busy}>저장</Button>
                            <Button type="button" variant="ghost" onClick={() => { setEditingId(null); setDraft(null); }} disabled={busy}>취소</Button>
                          </span>
                        : <Button type="button" variant="secondary" onClick={() => startEdit(store)}>수정</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      <section className="panel" aria-labelledby="stores-map-heading">
        <div className="panel-heading"><div><h2 id="stores-map-heading">매장 지도 · 출점 거리 검토</h2><p>기존 매장은 파란 핀, 예비 출점 후보는 빨간 핀입니다 · 핀 두 개를 누르면 직선거리를 계산합니다</p></div></div>
        {!mapKey && <p className="panel-empty-copy">네이버 지도 키가 아직 없습니다. {isMaster ? '아래에서 키를 저장하면 지도가 나타납니다.' : '마스터 계정에서 지도 키를 설정할 수 있습니다.'}</p>}
        {mapKey && geocodable.length === 0 && <p className="panel-empty-copy">도로명주소가 입력된 매장이 없습니다. 대장에서 주소를 채우면 지도에 표시됩니다.</p>}
        {mapKey && geocodable.length > 0 && (
          <>
            {mapStatus === 'error' && <p className="panel-empty-copy">지도 스크립트를 불러오지 못했습니다. 네트워크 상태를 확인하고 새로고침해 주세요.</p>}
            {mapStatus === 'auth-error' && <p className="panel-empty-copy">지도 키 인증에 실패했습니다. 네이버 클라우드 콘솔에서 Maps Application의 Client ID(ncpKeyId)가 맞는지, Web 서비스 URL에 https://ofd-web.onrender.com 이 등록됐는지 확인해 주세요.</p>}
            <form className="candidate-form" onSubmit={addCandidate}>
              <label htmlFor="candidate-address">예비 출점 주소
                <input id="candidate-address" value={candidateAddress} onChange={(event) => setCandidateAddress(event.target.value)}
                  placeholder="예: 서울 강남구 테헤란로 123" disabled={candidateBusy} />
              </label>
              <label htmlFor="candidate-label">표시 이름 (선택)
                <input id="candidate-label" value={candidateLabel} onChange={(event) => setCandidateLabel(event.target.value)}
                  placeholder="예: 역삼 상담건" disabled={candidateBusy} />
              </label>
              <Button type="submit" disabled={candidateBusy || !candidateAddress.trim()}>{candidateBusy ? '찾는 중…' : '후보 추가'}</Button>
            </form>
            {candidateError && <p className="form-alert" role="alert">{candidateError}</p>}
            <div ref={mapContainer} style={{ width: '100%', height: 360, borderRadius: 13, overflow: 'hidden' }} aria-label="매장 위치 지도" role="application" />
            <div className="map-legend">
              <span><i className="pin-swatch store" aria-hidden="true" />기존 매장</span>
              <span><i className="pin-swatch candidate" aria-hidden="true" />예비 출점 후보</span>
              <span className="muted">핀을 누르면 선택 표시(큰 핀)되고, 두 개를 고르면 직선거리가 나옵니다</span>
            </div>
            {distanceText && <p className="distance-readout" role="status">{distanceText}</p>}
            {selectedForDistance.length === 1 && (
              <p className="muted" role="status">{pointName(selectedForDistance[0]!)} 선택됨 — 비교할 다른 핀을 눌러 주세요.</p>
            )}
            {candidates.length > 0 && (
              <ul className="candidate-list">
                {candidates.map((candidate) => {
                  const selected = selectedForDistance.includes(candidate.id);
                  return (
                    <li key={candidate.id} className={selected ? 'selected' : ''}>
                      <button type="button" className="candidate-pick" onClick={() => toggleDistanceTarget(candidate.id)}
                        aria-pressed={selected}>
                        <i className="pin-swatch candidate" aria-hidden="true" />
                        <strong>{candidate.name}</strong><span className="muted">{candidate.address}</span>
                      </button>
                      <Button type="button" variant="ghost" onClick={() => removeCandidate(candidate.id)}>삭제</Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {geocodeMisses.length > 0 && <p className="muted">주소를 찾지 못한 매장: {geocodeMisses.join(', ')}</p>}
          </>
        )}
        {isMaster && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>네이버 지도 키(ncpKeyId)
              <input value={mapKeyInput} onChange={(event) => setMapKeyInput(event.target.value)} placeholder="네이버 클라우드 콘솔의 Client ID" />
            </label>
            <Button type="button" variant="secondary" onClick={async () => {
              try { const saved = await saveNaverMapKeyV2(mapKeyInput.trim()); setMapKey(saved.keyId || null); notify('지도 키를 저장했습니다.', 'success'); }
              catch (cause) { notify(cause instanceof Error ? cause.message : '키 저장에 실패했습니다.', 'warning'); }
            }}>키 저장</Button>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="notices-heading">
        <div className="panel-heading"><div><h2 id="notices-heading">공지 관리</h2><p>매장 발주 화면 상단 배너로 나갑니다 · 고정 공지가 먼저 보입니다</p></div></div>
        <div className="form-grid">
          <label>제목<input value={noticeForm.title} onChange={(event) => setNoticeForm({ ...noticeForm, title: event.target.value })} placeholder="예: 광복절 배송 휴무" /></label>
          <label>내용<input value={noticeForm.body} onChange={(event) => setNoticeForm({ ...noticeForm, body: event.target.value })} placeholder="선택 입력" /></label>
          <label className="inline-check"><input type="checkbox" checked={noticeForm.pinned} onChange={(event) => setNoticeForm({ ...noticeForm, pinned: event.target.checked })} /> 상단 고정</label>
          <Button type="button" onClick={() => void submitNotice()}>공지 등록</Button>
        </div>
        {notices.length === 0 ? <p className="panel-empty-copy">등록된 공지가 없습니다.</p> : (
          <ul className="notice-admin-list">
            {notices.map((notice) => (
              <li key={notice.id}>
                <span>{notice.pinned && <strong className="tone-red">[고정] </strong>}<strong>{notice.title}</strong>
                  {notice.body && <span className="muted"> — {notice.body}</span>} <small className="muted">{notice.date}</small></span>
                <Button type="button" variant="ghost" onClick={() => void removeNotice(notice)}>내리기</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
