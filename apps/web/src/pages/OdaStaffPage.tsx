import { useEffect, useRef, useState } from 'react';
import type { HrStoreScheduleEntry } from '../../../../packages/domain/src/oda-hr';
import { ApiError } from '../api/client';
import { commandOdaHr, getOdaHr, type HrResponse } from '../api/oda-hr-client';
import { Bell, CalendarDays, Check, ChevronRight, Clock3, FileCheck2, MapPin, Plus, RefreshCcw, Search, Umbrella, UserRound } from '../components/icons';
import { Button } from '../components/ui';
import { getCurrentHrPosition, hrDistanceMeters, type HrPosition } from '../lib/hr-location';
import type { BootstrapData } from '../types';
import { HrDialog } from '../hr/shared';
import { EsignPendingCard } from '../hr/HrEsign';
import { StaffBottomNav, staffHomeTabs, type StaffHomeTab } from '../hr/StaffNavigation';
import { HrStaffTasks, deriveStaffTasks } from '../hr/HrStaffTasks';
import { HrStaffNotices, countStaffUnreadNotices } from '../hr/HrStaffNotices';
import type { StaffDestination } from '../hr/StaffDestination';
import { HrStaffMore, useStaffTextPreference } from '../hr/HrStaffMore';
import { addStaffDays, shiftMinutes, staffDuration, staffScheduleIcs, staffWeekSummary } from '../lib/hr-staff-summary';
import './OdaStaffPage.css';

export const staffPersonalTabs = [
  ['operations', '매장 업무·인수인계'], ['attendance', '근무 기록·정정 신청'], ['leave', '내 휴가'], ['approvals', '내 결재'], ['expenses', '내 비용 요청'],
  ['payroll', '내 급여'], ['goals', '내 목표'], ['reviews', '내 평가'], ['meetings', '내 미팅'],
  ['contracts', '내 계약'], ['documents', '내 문서'], ['help', '인사 도움말'],
] as const;
export type StaffPersonalTab = typeof staffPersonalTabs[number][0];
type Props = { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; onOpenPersonal?: (tab: StaffPersonalTab, destination?: StaffDestination) => void; initialTab?: StaffHomeTab; onHomeTabChange?: (tab: StaffHomeTab) => void; onBusyChange?: (busy: boolean) => void };
type GeoState = { phase: 'idle' | 'checking' | 'ready' | 'error'; position?: HrPosition; message?: string };
type ClockLocation = NonNullable<HrResponse['workspace']['settings']['clockLocation']>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
export const staffDate = (now: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const clockTime = (value?: string) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
const clockDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const lastClock = (response: HrResponse) => response.workspace.attendance.clockEvents.filter(row => row.employeeId === response.employeeId).at(-1);

export function clockLocationCheck(position: HrPosition, location: ClockLocation, now: number): { valid: boolean; message: string; distance: number } {
  const distance = hrDistanceMeters(position, location);
  if (now - position.timestamp > 60_000 || position.timestamp - now > 10_000) return { valid: false, distance, message: '위치 정보가 오래되었거나 기기 시간이 맞지 않습니다. 위치를 다시 확인해 주세요.' };
  if (position.accuracy > 50 || position.accuracy <= 0) return { valid: false, distance, message: '위치 정확도가 부족합니다. 오차 50m 이내로 확인될 수 있도록 창가나 실외에서 다시 시도해 주세요.' };
  if (distance + position.accuracy > 200) return { valid: false, distance, message: '매장 근처에서 확인해 주세요. 위치 오차를 포함해 매장 반경 200m 안에 있어야 출퇴근할 수 있습니다.' };
  return { valid: true, distance, message: '매장 반경 안에서 위치를 확인했습니다.' };
}

export function OdaStaffPage({ data, notify, onOpenPersonal, initialTab, onHomeTabChange, onBusyChange }: Props) {
  const stores = data.stores.filter(store => store.active !== false);
  const initialStore = stores.find(store => store.id === new URLSearchParams(window.location.search).get('store'))?.id || stores.find(store => store.id === data.store.id)?.id || stores[0]?.id || '';
  const [storeId, setStoreId] = useState(initialStore);
  const [homeTab, setHomeTab] = useState<StaffHomeTab>(() => { const value = new URLSearchParams(window.location.search).get('view'); return initialTab || (staffHomeTabs.includes(value as StaffHomeTab) ? value as StaffHomeTab : 'today'); });
  const [search, setSearch] = useState('');
  const [clockSheet, setClockSheet] = useState(false);
  const [noticeSheet, setNoticeSheet] = useState(false);
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [coworker, setCoworker] = useState('all');
  const staffText = useStaffTextPreference(data.actor.id, storeId);
  const [response, setResponse] = useState<HrResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [clockError, setClockError] = useState('');
  const [success, setSuccess] = useState('');
  const [phase, setPhase] = useState<'locating' | 'saving' | null>(null);
  const [geo, setGeo] = useState<GeoState>({ phase: 'idle' });
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [month, setMonth] = useState(staffDate(Date.now()).slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(staffDate(Date.now()));
  const [scheduleMode, setScheduleMode] = useState<'mine' | 'store'>('mine');
  const [openNotice, setOpenNotice] = useState('');
  const mounted = useRef(true);
  const activeStore = useRef(storeId);
  activeStore.current = storeId;
  const operation = useRef(0);
  const geoRequest = useRef(0);
  const locked = useRef(false);
  const saving = useRef(false);
  const previousDate = useRef(staffDate(now));
  const view = response?.workspace.storeId === storeId ? response : null;
  const location = view?.workspace.settings.clockLocation;
  const today = staffDate(now);
  const employee = view?.workspace.employees.find(row => row.id === view.employeeId);
  const events = view?.workspace.attendance.clockEvents.filter(row => row.employeeId === view.employeeId) || [];
  const latest = events.at(-1);
  const clockedIn = latest?.kind === 'in';
  const recentIn = events.filter(row => row.kind === 'in').at(-1);
  const recentOut = !clockedIn && latest?.kind === 'out' ? latest : undefined;
  const sameDayOut = recentOut && staffDate(Date.parse(recentOut.at)) === today;
  const configuredAddress = location?.address || view?.storeAddress;
  const locationResult = geo.position && location ? clockLocationCheck(geo.position, location, now) : null;

  useEffect(() => { if (initialTab) setHomeTab(initialTab); }, [initialTab]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; geoRequest.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(''); setLoading(Boolean(storeId));
    if (!storeId) { setResponse(null); return; }
    void getOdaHr(storeId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.workspace.storeId !== storeId) throw new Error('선택한 매장의 정보를 다시 불러와 주세요.');
      setResponse(result);
    }).catch(error => { if (!controller.signal.aborted) setLoadError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [storeId, retry]);

  useEffect(() => {
    function updateTime() {
      const timestamp = Date.now(); const date = staffDate(timestamp);
      setNow(timestamp);
      if (date !== previousDate.current) {
        const previous = previousDate.current;
        setSelectedDate(value => value === previous ? date : value);
        setMonth(value => value === previous.slice(0, 7) ? date.slice(0, 7) : value);
        previousDate.current = date;
        if (!locked.current) setRetry(value => value + 1);
      }
    }
    function focus() { updateTime(); if (!locked.current) { geoRequest.current++; setGeo({ phase: 'idle' }); setRetry(value => value + 1); } }
    const interval = window.setInterval(updateTime, 30_000);
    window.addEventListener('focus', focus);
    const visible = () => { if (document.visibilityState === 'visible') focus(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); };
  }, []);

  function selectStore(next: string) {
    if (saving.current || next === activeStore.current || !stores.some(store => store.id === next)) return;
    operation.current++; geoRequest.current++; locked.current = false; onBusyChange?.(false);
    activeStore.current = next; setStoreId(next); setPhase(null); setGeo({ phase: 'idle' }); setResponse(null);
    setClockError(''); setSuccess(''); setScheduleMode('mine'); setOpenNotice(''); setCoworker('all'); setClockSheet(false); setNoticeSheet(false);
    const params = new URLSearchParams(window.location.search); params.set('store', next); params.delete('tab');
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
  }
  useEffect(() => {
    function popstate() {
      const requested = new URLSearchParams(window.location.search).get('store');
      const next = stores.find(store => store.id === requested)?.id || stores[0]?.id;
      if (next && next !== activeStore.current) selectStore(next);
      const requestedTab = new URLSearchParams(window.location.search).get('view');
      if (!locked.current) setHomeTab(staffHomeTabs.includes(requestedTab as StaffHomeTab) ? requestedTab as StaffHomeTab : 'today');
    }
    window.addEventListener('popstate', popstate); return () => window.removeEventListener('popstate', popstate);
  }, [data]);

  async function checkPosition() {
    if (!location || locked.current) return;
    const target = storeId; const request = ++geoRequest.current;
    setGeo({ phase: 'checking' });
    try {
      const position = await getCurrentHrPosition();
      if (mounted.current && request === geoRequest.current && target === activeStore.current) { setNow(Date.now()); setGeo({ phase: 'ready', position }); }
    } catch (error) {
      if (mounted.current && request === geoRequest.current && target === activeStore.current) setGeo({ phase: 'error', message: errorMessage(error) });
    }
  }

  async function recordClock() {
    if (locked.current || !view?.employeeId || !location || loading || loadError) return;
    const target = storeId; const employeeId = view.employeeId;
    const expectedKind = lastClock(view)?.kind === 'in' ? 'out' : 'in';
    const token = ++operation.current; geoRequest.current++;
    locked.current = true; onBusyChange?.(true); setPhase('locating'); setGeo({ phase: 'checking' }); setClockError(''); setSuccess('');
    try {
      // Refresh the work state and take a new measurement for this exact click.
      const [fresh, position] = await Promise.all([getOdaHr(target), getCurrentHrPosition()]);
      if (!mounted.current || token !== operation.current || activeStore.current !== target) return;
      if (fresh.workspace.storeId !== target || fresh.employeeId !== employeeId) throw new Error('직원 연결 정보가 변경되었습니다. 새로고침 후 확인해 주세요.');
      setResponse(fresh); setNow(Date.now()); setGeo({ phase: 'ready', position });
      if ((lastClock(fresh)?.kind === 'in' ? 'out' : 'in') !== expectedKind) throw new Error('출퇴근 상태가 변경되었습니다. 최신 기록을 확인한 뒤 다시 눌러 주세요.');
      const configured = fresh.workspace.settings.clockLocation;
      if (!configured) throw new Error('매장 출퇴근 위치가 설정되지 않았습니다. 관리자에게 등록을 요청해 주세요.');
      const result = clockLocationCheck(position, configured, Date.now());
      if (!result.valid) throw new Error(result.message);
      saving.current = true; setPhase('saving');
      const saved = await commandOdaHr(target, fresh.workspace.version, `clock.${expectedKind}`, { employeeId, location: position });
      if (!mounted.current || token !== operation.current || activeStore.current !== target) return;
      setResponse(saved); setNow(Date.now()); setClockSheet(false);
      const message = expectedKind === 'in' ? '출근을 기록했습니다. 오늘도 좋은 하루 보내세요.' : '퇴근을 기록했습니다. 수고하셨습니다.';
      setSuccess(message); notify(message, 'success');
    } catch (error) {
      if (!mounted.current || token !== operation.current || activeStore.current !== target) return;
      setClockError(errorMessage(error));
      if (!(error instanceof ApiError) && !saving.current) setGeo(value => value.position ? value : { phase: 'error', message: errorMessage(error) });
      if (error instanceof ApiError || saving.current) {
        // A timeout or conflict may follow a committed record. Re-read; never retry the write automatically.
        try { const fresh = await getOdaHr(target); if (mounted.current && token === operation.current && activeStore.current === target) setResponse(fresh); }
        catch (refreshError) { if (mounted.current && token === operation.current) setLoadError(errorMessage(refreshError)); }
      }
    } finally {
      if (token === operation.current) { locked.current = false; saving.current = false; onBusyChange?.(false); if (mounted.current) setPhase(null); }
    }
  }

  const team: HrStoreScheduleEntry[] = view?.employeeId ? view.storeSchedule || [] : [];
  const mine: HrStoreScheduleEntry[] = view?.employeeId ? view.workspace.attendance.shifts.filter(row => row.status === 'published' && row.employeeId === view.employeeId).map(row => ({ ...row, employeeName: employee?.name || data.actor.name })) : [];
  const schedules = scheduleMode === 'mine' ? mine : team.filter(row => coworker === 'all' || row.employeeId === view?.employeeId || row.employeeId === coworker);
  const notices = view?.workspace.notices.filter(row => row.status === 'published').slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)) || [];
  const clockDisabled = !view?.employeeId || !location || Boolean(phase) || loading || Boolean(loadError);
  const geoMessage = !location ? '매장 출퇴근 위치가 아직 등록되지 않았습니다. 관리자에게 설정을 요청해 주세요.' : geo.phase === 'checking' ? '현재 위치를 확인하고 있습니다…' : geo.phase === 'error' ? geo.message : locationResult?.message || '출퇴근 버튼을 누르면 현재 위치를 새로 확인합니다.';

  const week = staffWeekSummary(view, today);
  const taskCount = deriveStaffTasks(view, data.actor.id, today).todo.length;
  const todayShifts = mine.filter(row => row.date === today);
  const dayLeaves = view?.workspace.attendance.leaveRequests.filter(row => row.employeeId === view.employeeId && ['approved', 'pending'].includes(row.status) && row.slots.some(slot => slot.date === selectedDate)) || [];
  const dayMeetings = view?.workspace.talent.meetings.filter(row => row.scheduledDate === selectedDate) || [];
  const todayMeetings = view?.workspace.talent.meetings.filter(row => row.scheduledDate === today) || [];
  const todayLeave = view?.workspace.attendance.leaveRequests.filter(row => row.employeeId === view.employeeId && ['approved', 'pending'].includes(row.status) && row.slots.some(slot => slot.date === today)) || [];
  const todayCount = todayShifts.length + todayMeetings.length + todayLeave.length;
  const dayTeam = team.filter(row => row.date === selectedDate && row.employeeId !== view?.employeeId && (coworker === 'all' || row.employeeId === coworker));
  const coworkers = [...new Map(team.filter(row => row.employeeId !== view?.employeeId).map(row => [row.employeeId, row.employeeName])).entries()];
  const openPersonal = (tab: StaffPersonalTab, destination?: StaffDestination) => { if (!locked.current) { if (destination) onOpenPersonal?.(tab, destination); else onOpenPersonal?.(tab); } };
  function navigate(tab: StaffHomeTab) {
    if (locked.current) return;
    setHomeTab(tab); setSearch(''); onHomeTabChange?.(tab);
    const params = new URLSearchParams(window.location.search); params.set('view', tab); params.set('store', storeId); params.delete('tab');
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
    document.scrollingElement?.scrollTo?.({ top: 0 });
  }
  function openSchedule() { setMonth(today.slice(0, 7)); setSelectedDate(today); navigate('schedule'); }
  function exportCalendar() {
    const url = URL.createObjectURL(new Blob([staffScheduleIcs(mine, month)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `ODA-근무일정-${month}.ics`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('내 공개 근무표를 내보냈습니다. 일정 변경 시 다시 내려받아 주세요.', 'info');
  }
  async function acknowledgeNotice(id: string, updatedAt: string) {
    if (locked.current || !view || loading || loadError) throw new Error('매장 정보를 불러온 뒤 다시 확인해 주세요.');
    const target = storeId, token = ++operation.current;
    locked.current = true; onBusyChange?.(true); saving.current = true; setPhase('saving');
    try {
      const saved = await commandOdaHr(target, view.workspace.version, 'notice.acknowledge', { id, updatedAt });
      if (mounted.current && token === operation.current && activeStore.current === target) setResponse(saved);
    } catch (error) {
      // A timeout may follow a committed receipt; read the authoritative result, never repeat the write.
      try { const fresh = await getOdaHr(target); if (mounted.current && token === operation.current && activeStore.current === target) setResponse(fresh); }
      catch (refreshError) { if (mounted.current && token === operation.current) setLoadError(errorMessage(refreshError)); }
      throw error;
    } finally {
      if (token === operation.current) { locked.current = false; saving.current = false; onBusyChange?.(false); if (mounted.current) setPhase(null); }
    }
  }
  const noticeList = <HrStaffNotices response={view} actorId={data.actor.id} busy={Boolean(phase) || loading || Boolean(loadError)} onAcknowledge={acknowledgeNotice} initialNoticeId={openNotice} />;
  const unreadNotices = countStaffUnreadNotices(view, data.actor.id);
  const clockAction = <button className="staff-clock-button" type="button" aria-label={clockedIn ? '퇴근하기' : '출근하기'} disabled={clockDisabled} onClick={() => void recordClock()}>{phase === 'locating' ? '위치 확인 중…' : phase === 'saving' ? '기록 중…' : clockedIn ? '지금 퇴근' : '지금 출근'}</button>;
  const locationPanel = <section className="staff-location-card" aria-label="출퇴근 위치 확인">
    <div className="staff-section-heading"><h2><MapPin size={19} /> 출퇴근 위치</h2><span className={`staff-location-badge ${locationResult?.valid ? 'verified' : ''}`}>{!location ? '미설정' : geo.phase === 'checking' ? '확인 중' : locationResult?.valid ? '위치 확인' : '확인 필요'}</span></div>
    <strong>{stores.find(store => store.id === storeId)?.name}</strong><p className="staff-address">{configuredAddress || '등록된 주소가 없습니다.'}</p>
    <div className="staff-location-measures"><div><span>매장과의 거리</span><strong>{locationResult ? `${Math.round(locationResult.distance).toLocaleString('ko-KR')}m` : '—'}</strong></div><div><span>현재 위치 오차</span><strong>{geo.position ? `±${Math.ceil(geo.position.accuracy)}m` : '—'}</strong></div></div>
    <p className="staff-location-message" role="status">{geoMessage}</p>
    <button type="button" className="staff-location-retry" disabled={!location || geo.phase === 'checking' || Boolean(phase)} onClick={() => void checkPosition()}><RefreshCcw size={16} />위치 다시 확인</button>
    <p className="staff-location-rule">매장 반경 200m · 위치 오차 50m 이하<br />위치 오차까지 반경 안에 포함되어야 합니다.</p>
    {clockError && <p className="staff-clock-error" role="alert">{clockError}</p>}
    <div className="staff-clock-times"><div><span>최근 출근</span><strong>{clockTime(recentIn?.at)}</strong></div><div><span>최근 퇴근</span><strong>{clockTime(recentOut?.at)}</strong></div></div>
    {clockedIn && staffDate(Date.parse(latest!.at)) !== today && <p className="staff-overnight">이전 날짜의 출근 기록이 이어지고 있습니다. 퇴근으로 근무를 마무리하세요.</p>}
    {clockAction}
    {onOpenPersonal && <button type="button" className="staff-text-button" disabled={Boolean(phase)} onClick={() => openPersonal('attendance')}>근무 기록·정정 신청<ChevronRight size={16} /></button>}
  </section>;

  return <main id="main-content" className={`oda-staff-page staff-view-${homeTab}`} data-staff-text={staffText} tabIndex={-1}>
    {homeTab === 'today' && <header className="staff-heading"><h1><span className="staff-date-icon"><FileCheck2 size={21} /></span>{Number(today.slice(5, 7))}월 {Number(today.slice(8))}일</h1><button type="button" className="staff-icon-button" aria-label={`알림 · 해야할 일 ${taskCount}건`} onClick={() => navigate('tasks')}><Bell size={22} />{taskCount > 0 && <span className="staff-alert-dot" />}</button></header>}
    <div className="staff-store"><label><span>근무 매장</span><select aria-label="직원 홈 매장" value={storeId} disabled={phase === 'saving' || !stores.length} onChange={event => selectStore(event.target.value)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><button className="staff-icon-button" type="button" aria-label="직원 홈 새로고침" disabled={Boolean(phase) || loading || !storeId} onClick={() => { geoRequest.current++; setGeo({ phase: 'idle' }); setClockError(''); setSuccess(''); setRetry(value => value + 1); }}><RefreshCcw size={18} /></button></div>
    {!stores.length ? <section className="staff-empty">배정된 매장이 없습니다. 계정 관리자에게 매장 배정을 요청해 주세요.</section> : <>
      {loading && <p className="staff-loading" role="status">근무 정보를 불러오고 있습니다.</p>}
      {loadError && <div className="staff-error" role="alert"><p>{loadError}</p><Button variant="secondary" disabled={loading || Boolean(phase)} onClick={() => setRetry(value => value + 1)}>다시 불러오기</Button></div>}
      {!view?.employeeId && !loading && !loadError && <p className="staff-unlinked">계정에 연결된 직원 정보가 없습니다. 관리자에게 직원 계정 연결을 요청해 주세요.</p>}
      {success && <p className="staff-clock-success" role="status"><Check size={16} />{success}</p>}
      {clockError && !clockSheet && <p className="staff-clock-error" role="alert">{clockError}</p>}
      {homeTab === 'today' && <>
        <label className="staff-search"><Search size={20} /><input type="search" aria-label="메뉴·공지 검색" placeholder="찾는 게 있으신가요?" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {search.trim() ? <section className="staff-search-results" aria-label="검색 결과">{staffPersonalTabs.filter(([, label]) => label.includes(search.trim())).map(([id, label]) => <button type="button" key={id} onClick={() => openPersonal(id)}>{label}<ChevronRight size={18} /></button>)}{notices.filter(row => `${row.title} ${row.body}`.includes(search.trim())).map(row => <button type="button" key={row.id} onClick={() => { setNoticeSheet(true); setOpenNotice(row.id); }}>공지 · {row.title}<ChevronRight size={18} /></button>)}{!staffPersonalTabs.some(([, label]) => label.includes(search.trim())) && !notices.some(row => `${row.title} ${row.body}`.includes(search.trim())) && <p className="staff-empty">검색 결과가 없습니다.</p>}</section> : <>
          <div className="staff-quick-actions"><button type="button" disabled={Boolean(phase)} onClick={() => setClockSheet(true)}><Clock3 size={19} /><span>근무 등록</span></button><button type="button" disabled={!onOpenPersonal || Boolean(phase)} onClick={() => openPersonal('leave', { action: 'create' })}><span className="staff-leave-symbol" aria-hidden="true"><Umbrella size={20} /></span><span>휴가 등록</span></button><button type="button" disabled={!onOpenPersonal || Boolean(phase)} onClick={() => openPersonal('meetings', { action: 'create' })}><CalendarDays size={19} /><span>미팅 추가</span></button></div>
          <button type="button" className="staff-location-link" disabled={!onOpenPersonal || Boolean(phase)} onClick={() => openPersonal('operations')}><FileCheck2 size={19} /><span>매장 업무 · 오픈·마감과 인수인계</span><ChevronRight size={18} /></button>
          <EsignPendingCard storeId={storeId} actorId={data.actor.id} onOpen={() => openPersonal('contracts')} disabled={!onOpenPersonal || Boolean(phase)} />
          <div className="staff-overview-links"><button type="button" onClick={openSchedule}><strong>일정<ChevronRight size={16} /></strong><span>{todayCount ? `오늘 ${todayCount}개의 일정` : '오늘은 일정이 없어요.'}</span></button><button type="button" onClick={() => navigate('tasks')}><strong>해야할 일<ChevronRight size={16} /></strong><span>{taskCount ? `${taskCount}건을 확인해 주세요.` : '모두 완료했어요.'}</span></button></div>
          <section className="staff-my-work" aria-label="내 근무"><h2 className="staff-group-title">내 근무</h2><button type="button" className="staff-week-card" disabled={!onOpenPersonal} onClick={() => openPersonal('attendance')}><div><span>승인된 근무</span><span>{week.start.slice(5).replace('-', '.')} – {week.end.slice(5).replace('-', '.')}</span></div><div><span className="staff-target-label"><Clock3 size={22} />채운 시간</span><p><strong>{staffDuration(week.recognizedMinutes)}</strong><span> / {week.target === null ? '기준 미설정' : staffDuration(week.target)}</span></p></div>{week.target !== null && week.target > 0 && <progress value={week.recognizedMinutes} max={week.target} aria-label="주간 근무 달성률" />}<small>{week.pendingCount ? `승인 대기 ${week.pendingCount}건 · ` : ''}{week.paidLeaveMinutes ? `유급휴가 ${staffDuration(week.paidLeaveMinutes)} · ` : ''}승인된 기록을 기준으로 표시합니다.</small></button>
            <button type="button" className="staff-location-link" onClick={() => setClockSheet(true)}><MapPin size={18} /><span>{location ? '출퇴근 위치 확인' : '출퇴근 위치 설정이 필요해요'}</span><ChevronRight size={18} /></button>
          </section>
          <section className="staff-team-today"><h2 className="staff-group-title">구성원 근무</h2><button type="button" className="staff-team-card" onClick={() => { setScheduleMode('store'); openSchedule(); }}><span><UserRound size={22} />오늘의 매장 근무표</span><strong>{new Set(team.filter(row => row.date === today && row.kind === 'work').map(row => row.employeeId)).size}명<ChevronRight size={18} /></strong></button><p className="staff-hint">공개된 근무 일정만 표시합니다.</p></section>
          {unreadNotices > 0 && <button type="button" className="staff-location-link" onClick={() => { setOpenNotice(''); setNoticeSheet(true); }}><Bell size={18} /><span>아직 확인하지 않은 공지 {unreadNotices}개</span><ChevronRight size={18} /></button>}
          {!noticeSheet && noticeList}
        </>}
      </>}
      {homeTab === 'schedule' && <section className="staff-schedule-screen" aria-label="내 근무 일정">
        <header className="staff-screen-heading"><h1>{Number(month.slice(0, 4))}년 {Number(month.slice(5))}월</h1><div><button className="staff-icon-button" type="button" aria-label="일정 필터" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}><span className="staff-filter-icon" aria-hidden="true">≡</span></button><button className="staff-icon-button" type="button" aria-label="일정 추가" disabled={!onOpenPersonal || Boolean(phase)} onClick={() => openPersonal('meetings', { action: 'create' })}><Plus size={23} /></button></div></header>
        {filterOpen && <div className="staff-calendar-filter"><div className="staff-segment" aria-label="근무표 범위"><button type="button" aria-pressed={scheduleMode === 'mine'} onClick={() => setScheduleMode('mine')}>나</button><button type="button" aria-pressed={scheduleMode === 'store'} disabled={!view?.employeeId} onClick={() => setScheduleMode('store')}>매장</button></div><label>동료<select value={coworker} onChange={event => setCoworker(event.target.value)}><option value="all">모든 동료</option>{coworkers.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label></div>}
        <div className="staff-month-nav"><button type="button" aria-label={calendarExpanded ? '이전 달' : '이전 주'} onClick={() => calendarExpanded ? changeMonth(-1) : changeWeek(-7)}>‹</button><button type="button" className="staff-today" onClick={() => { setMonth(today.slice(0, 7)); setSelectedDate(today); }}>오늘</button><button type="button" aria-label={calendarExpanded ? '다음 달' : '다음 주'} onClick={() => calendarExpanded ? changeMonth(1) : changeWeek(7)}>›</button><button type="button" className="staff-calendar-toggle" aria-expanded={calendarExpanded} onClick={() => setCalendarExpanded(!calendarExpanded)}>{calendarExpanded ? '주간 보기' : '월 전체 보기'}</button></div>
        <ScheduleCalendar month={month} today={today} selected={selectedDate} mode={scheduleMode} rows={schedules} onSelect={date => { setSelectedDate(date); setMonth(date.slice(0, 7)); }} compact={!calendarExpanded} />
        <div className="staff-calendar-handle" aria-hidden="true" />
        <div className="staff-schedule-day"><div className="staff-shift-bands">{mine.filter(row => row.date === selectedDate).map(row => <button type="button" key={row.id} onClick={() => openPersonal('attendance')}><span><Clock3 size={19} />{row.kind === 'off' ? '휴무' : `근무 ${staffDuration(shiftMinutes(row))}`}</span><small>{row.kind === 'work' ? `${row.startTime} – ${row.endTime}${row.endTime <= row.startTime ? ' 다음 날' : ''}` : ''}</small><ChevronRight size={18} /></button>)}</div>
          <section className="staff-day-section"><h2>내 일정 <em>{dayLeaves.length + dayMeetings.length}</em></h2>{!dayLeaves.length && !dayMeetings.length ? <p className="staff-empty">일정이 없는 날이에요.</p> : <ul>{dayLeaves.map(row => <li key={row.id}><button type="button" onClick={() => openPersonal('leave', { recordId: row.id })}><span className="staff-event-mark leave"><Umbrella size={20} /></span><span><strong>{view?.workspace.attendance.leaveTypes.find(type => type.id === row.typeId)?.name || '휴가'}</strong><small>{row.slots.filter(slot => slot.date === selectedDate).map(slot => `${slot.startTime} – ${slot.endTime}`).join(', ')} · {row.status === 'pending' ? '승인 대기' : '승인 완료'}</small></span><ChevronRight size={18} /></button></li>)}{dayMeetings.map(row => <li key={row.id}><button type="button" onClick={() => openPersonal('meetings', { recordId: row.id })}><span className="staff-event-mark"><CalendarDays size={20} /></span><span><strong>{row.title}</strong><small>미팅 · 시간 미지정</small></span><ChevronRight size={18} /></button></li>)}</ul>}</section>
          <section className="staff-day-section"><h2>동료 일정 <em>{dayTeam.length}</em></h2>{!dayTeam.length ? <p className="staff-empty">선택한 동료의 일정이 없어요.</p> : <ul>{dayTeam.map(row => <li className="staff-coworker-shift" key={row.id}><span className="staff-schedule-avatar">{row.employeeName.slice(0, 1)}</span><div><strong>{row.employeeName}</strong><p>{row.kind === 'off' ? '휴무' : `${row.startTime} – ${row.endTime}${row.endTime <= row.startTime ? ' (다음 날)' : ''}`}</p><small>{row.kind === 'work' ? `휴게 ${row.breakMinutes}분` : '게시된 일정'}</small></div></li>)}</ul>}</section>
        </div><button type="button" className="staff-calendar-export" disabled={!mine.some(row => row.date.startsWith(`${month}-`) && row.kind === 'work')} onClick={exportCalendar}><CalendarDays size={18} />내 근무표 캘린더로 내보내기</button><p className="staff-hint">선택한 월의 공개 근무표를 .ics 파일로 저장합니다.</p>
      </section>}
      {homeTab === 'tasks' && <HrStaffTasks response={view} actorId={data.actor.id} busy={Boolean(phase) || loading || Boolean(loadError)} onOpenPersonal={openPersonal} />}
      {homeTab === 'more' && <HrStaffMore response={view} data={data} busy={Boolean(phase) || loading || Boolean(loadError)} onOpenPersonal={openPersonal} onOpenSchedule={() => { setScheduleMode('store'); openSchedule(); }} onOpenNotices={() => setNoticeSheet(true)} />}
      {clockSheet && <HrDialog title="근무 등록" busy={Boolean(phase)} onClose={() => setClockSheet(false)}>{locationPanel}</HrDialog>}
      {noticeSheet && <HrDialog title="매장 공지" busy={Boolean(phase)} onClose={() => setNoticeSheet(false)}>{noticeList}</HrDialog>}
      {homeTab === 'today' && !clockSheet && <section className="staff-clock-dock" aria-label="내 출퇴근"><div><strong>{clockedIn ? '근무 중' : sameDayOut ? '퇴근 완료' : '시작 전'}</strong><span>{clockedIn ? `${clockDate(latest!.at)} 출근` : todayShifts.find(row => row.kind === 'work') ? `${todayShifts.find(row => row.kind === 'work')!.startTime} 근무 예정` : '근무 예정'}</span></div>{clockAction}</section>}
    </>}
    <StaffBottomNav active={homeTab} onSelect={navigate} disabled={Boolean(phase)} />
  </main>;

  function changeMonth(offset: number) {
    const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1));
    const next = date.toISOString().slice(0, 7); setMonth(next); setSelectedDate(`${next}-01`);
  }
  function changeWeek(offset: number) { const date = addStaffDays(selectedDate, offset); setSelectedDate(date); setMonth(date.slice(0, 7)); }
}

function ScheduleCalendar({ month, today, selected, mode, rows, onSelect, compact }: { month: string; today: string; selected: string; mode: 'mine' | 'store'; rows: HrStoreScheduleEntry[]; onSelect: (date: string) => void; compact: boolean }) {
  const year = Number(month.slice(0, 4)); const monthIndex = Number(month.slice(5)) - 1;
  const offset = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const weeks = compact ? 1 : Math.ceil((days + offset) / 7);
  const sunday = addStaffDays(selected, -new Date(`${selected}T00:00:00Z`).getUTCDay());
  return <table className={`staff-calendar ${compact ? 'is-week' : ''}`} aria-label={`${year}년 ${monthIndex + 1}월 근무 달력`}><thead><tr>{['일', '월', '화', '수', '목', '금', '토'].map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead><tbody>{Array.from({ length: weeks }, (_, week) => <tr key={week}>{Array.from({ length: 7 }, (_, weekday) => {
    const day = week * 7 + weekday - offset + 1;
    if (!compact && (day < 1 || day > days)) return <td key={weekday} />;
    const date = compact ? addStaffDays(sunday, weekday) : `${month}-${String(day).padStart(2, '0')}`; const dayRows = rows.filter(row => row.date === date);
    const working = dayRows.filter(row => row.kind === 'work'); const text = mode === 'store' ? working.length ? `${new Set(working.map(row => row.employeeId)).size}명` : dayRows.length ? '휴무' : '' : working[0]?.startTime || (dayRows.length ? '휴무' : '');
    return <td key={weekday}><button type="button" className={`${selected === date ? 'selected' : ''} ${today === date ? 'today' : ''}`} aria-label={`${date}${text ? ` ${text}` : ' 일정 없음'}`} aria-pressed={selected === date} aria-current={today === date ? 'date' : undefined} onClick={() => onSelect(date)}><span>{Number(date.slice(8))}</span>{!compact && <small className={working.length ? 'work' : 'off'}>{text || '\u00a0'}</small>}</button></td>;
  })}</tr>)}</tbody></table>;
}
