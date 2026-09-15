import { useEffect, useRef, useState } from 'react';
import type { HrStoreScheduleEntry } from '../../../../packages/domain/src/oda-hr';
import { ApiError } from '../api/client';
import { commandOdaHr, getOdaHr, type HrResponse } from '../api/oda-hr-client';
import { CalendarDays, Check, Clock3, MapPin, RefreshCcw } from '../components/icons';
import { Button } from '../components/ui';
import { getCurrentHrPosition, hrDistanceMeters, type HrPosition } from '../lib/hr-location';
import type { BootstrapData } from '../types';
import './OdaStaffPage.css';

export const staffPersonalTabs = [
  ['attendance', '근무 기록·정정 신청'], ['leave', '내 휴가'], ['approvals', '내 결재'], ['expenses', '내 비용 요청'],
  ['payroll', '내 급여'], ['goals', '내 목표'], ['reviews', '내 평가'], ['meetings', '내 미팅'],
  ['contracts', '내 계약'], ['documents', '내 문서'], ['help', '인사 도움말'],
] as const;
export type StaffPersonalTab = typeof staffPersonalTabs[number][0];
type Props = { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void; onOpenPersonal?: (tab: StaffPersonalTab) => void };
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

export function OdaStaffPage({ data, notify, onOpenPersonal }: Props) {
  const stores = data.stores.filter(store => store.active !== false);
  const initialStore = stores.find(store => store.id === new URLSearchParams(window.location.search).get('store'))?.id || stores.find(store => store.id === data.store.id)?.id || stores[0]?.id || '';
  const [storeId, setStoreId] = useState(initialStore);
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
    operation.current++; geoRequest.current++; locked.current = false;
    activeStore.current = next; setStoreId(next); setPhase(null); setGeo({ phase: 'idle' }); setResponse(null);
    setClockError(''); setSuccess(''); setScheduleMode('mine'); setOpenNotice('');
    const params = new URLSearchParams(window.location.search); params.set('store', next); params.delete('tab');
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
  }
  useEffect(() => {
    function popstate() {
      const requested = new URLSearchParams(window.location.search).get('store');
      const next = stores.find(store => store.id === requested)?.id || stores[0]?.id;
      if (next && next !== activeStore.current) selectStore(next);
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
    locked.current = true; setPhase('locating'); setGeo({ phase: 'checking' }); setClockError(''); setSuccess('');
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
      setResponse(saved); setNow(Date.now());
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
      if (token === operation.current) { locked.current = false; saving.current = false; if (mounted.current) setPhase(null); }
    }
  }

  const team: HrStoreScheduleEntry[] = view?.employeeId ? view.storeSchedule || [] : [];
  const mine: HrStoreScheduleEntry[] = view?.employeeId ? view.workspace.attendance.shifts.filter(row => row.status === 'published' && row.employeeId === view.employeeId).map(row => ({ ...row, employeeName: employee?.name || data.actor.name })) : [];
  const schedules = scheduleMode === 'mine' ? mine : team;
  const dayRows = schedules.filter(row => row.date === selectedDate).sort((a, b) => Number(b.employeeId === view?.employeeId) - Number(a.employeeId === view?.employeeId) || a.startTime.localeCompare(b.startTime) || a.employeeName.localeCompare(b.employeeName, 'ko'));
  const notices = view?.workspace.notices.filter(row => row.status === 'published').slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)) || [];
  const clockDisabled = !view?.employeeId || !location || Boolean(phase) || loading || Boolean(loadError);
  const geoMessage = !location ? '매장 출퇴근 위치가 아직 등록되지 않았습니다. 관리자에게 설정을 요청해 주세요.' : geo.phase === 'checking' ? '현재 위치를 확인하고 있습니다…' : geo.phase === 'error' ? geo.message : locationResult?.message || '출퇴근 버튼을 누르면 현재 위치를 새로 확인합니다.';

  return <main id="main-content" className="oda-staff-page" tabIndex={-1}>
    <header className="staff-heading"><div><p className="staff-eyebrow">ODA · MY WORKDAY</p><h1>{employee?.name || data.actor.name}님, 안녕하세요</h1><p>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now)}</p></div><div className="staff-store"><label><span>근무 매장</span><select aria-label="직원 홈 매장" value={storeId} disabled={phase === 'saving' || !stores.length} onChange={event => selectStore(event.target.value)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><button className="staff-refresh" type="button" aria-label="직원 홈 새로고침" disabled={Boolean(phase) || loading || !storeId} onClick={() => { geoRequest.current++; setGeo({ phase: 'idle' }); setClockError(''); setSuccess(''); setRetry(value => value + 1); }}><RefreshCcw size={19} /></button></div></header>
    {!stores.length ? <section className="staff-empty">배정된 매장이 없습니다. 계정 관리자에게 매장 배정을 요청해 주세요.</section> : <>
      {loading && <p className="staff-loading" role="status">근무 정보를 불러오고 있습니다.</p>}
      {loadError && <div className="staff-error" role="alert"><p>{loadError}</p><Button variant="secondary" disabled={loading || Boolean(phase)} onClick={() => setRetry(value => value + 1)}>다시 불러오기</Button></div>}
      <div className="staff-primary-grid"><section className={`staff-clock-card ${clockedIn ? 'is-working' : ''}`} aria-label="내 출퇴근">
        <div className="staff-clock-top"><span><Clock3 size={18} /> 오늘의 근무</span><span className="staff-work-status"><i />{clockedIn ? '근무 중' : sameDayOut ? '퇴근 완료' : '출근 전'}</span></div>
        <h2>{clockedIn ? '오늘도 함께해 주셔서 고마워요' : sameDayOut ? '오늘도 수고하셨습니다' : '준비되셨나요?'}</h2><p className="staff-clock-description">{clockedIn ? `${clockDate(latest!.at)}부터 근무 중` : '매장에 도착하면 출근을 기록해 주세요.'}</p>
        <div className="staff-clock-times"><div><span>최근 출근</span><strong>{clockTime(recentIn?.at)}</strong></div><span className="staff-time-divider" /><div><span>최근 퇴근</span><strong>{clockTime(recentOut?.at)}</strong></div></div>
        {clockedIn && staffDate(Date.parse(latest!.at)) !== today && <p className="staff-overnight">이전 날짜의 출근 기록이 이어지고 있습니다. 퇴근으로 근무를 마무리하세요.</p>}
        {!view?.employeeId && !loading && <p className="staff-unlinked">계정에 연결된 직원 정보가 없습니다. 관리자에게 직원 계정 연결을 요청해 주세요.</p>}
        <button className="staff-clock-button" type="button" disabled={clockDisabled} onClick={() => void recordClock()}>{phase === 'locating' ? '위치 확인 중…' : phase === 'saving' ? '기록 중…' : clockedIn ? '퇴근하기' : '출근하기'}<span aria-hidden="true">→</span></button>
        {success && <p className="staff-clock-success" role="status"><Check size={16} />{success}</p>}
        {clockError && <p className="staff-clock-error" role="alert">{clockError}</p>}
      </section>
      <section className="staff-location-card" aria-label="출퇴근 위치 확인"><div className="staff-section-heading"><h2><MapPin size={19} /> 출퇴근 위치</h2><span className={`staff-location-badge ${geo.phase === 'ready' && locationResult?.valid ? 'verified' : ''}`}>{!location ? '미설정' : geo.phase === 'checking' ? '확인 중' : locationResult?.valid ? '위치 확인' : '확인 필요'}</span></div>
        <strong className="staff-store-name">{stores.find(store => store.id === storeId)?.name}</strong><p className="staff-address">{configuredAddress || '등록된 주소가 없습니다.'}</p>
        <div className="staff-location-measures"><div><span>매장과의 거리</span><strong>{locationResult ? `${Math.round(locationResult.distance).toLocaleString('ko-KR')}m` : '—'}</strong></div><div><span>현재 위치 오차</span><strong>{geo.position ? `±${Math.ceil(geo.position.accuracy)}m` : '—'}</strong></div></div>
        <p className={`staff-location-message ${locationResult?.valid ? 'verified' : ''}`} role="status">{geoMessage}</p>
        <button type="button" className="staff-location-retry" disabled={!location || geo.phase === 'checking' || Boolean(phase)} onClick={() => void checkPosition()}><RefreshCcw size={15} />위치 다시 확인</button>
        <p className="staff-location-rule">매장 반경 200m · 위치 오차 50m 이하<br />위치 오차까지 반경 안에 포함되어야 합니다.</p>
      </section></div>
      <section className="staff-schedule-card" aria-label="내 근무 일정"><div className="staff-section-heading"><div><h2><CalendarDays size={20} /> 근무 일정</h2><p>게시된 일정만 표시합니다.</p></div><div className="staff-segment" aria-label="근무표 범위"><button type="button" aria-pressed={scheduleMode === 'mine'} onClick={() => setScheduleMode('mine')}>나</button><button type="button" aria-pressed={scheduleMode === 'store'} disabled={!view?.employeeId} onClick={() => setScheduleMode('store')}>매장</button></div></div>
        <div className="staff-schedule-grid"><div><div className="staff-month-nav"><button type="button" aria-label="이전 달" onClick={() => changeMonth(-1)}>‹</button><strong>{Number(month.slice(0, 4))}년 {Number(month.slice(5))}월</strong><button type="button" aria-label="다음 달" onClick={() => changeMonth(1)}>›</button><button className="staff-today" type="button" onClick={() => { setMonth(today.slice(0, 7)); setSelectedDate(today); }}>오늘</button></div>
          <ScheduleCalendar month={month} today={today} selected={selectedDate} mode={scheduleMode} rows={schedules} onSelect={setSelectedDate} />
        </div><div className="staff-day-schedule"><h3>{Number(selectedDate.slice(5, 7))}월 {Number(selectedDate.slice(8))}일 <span>{scheduleMode === 'mine' ? '내 일정' : '매장 근무표'}</span></h3>
          {!dayRows.length ? <div className="staff-empty"><CalendarDays size={24} /><p>{view?.employeeId ? '게시된 근무 일정이 없습니다.' : '직원 계정 연결 후 일정을 확인할 수 있습니다.'}</p></div> : <ul>{dayRows.map(row => <li key={row.id}><span className={`staff-schedule-avatar ${row.employeeId === view?.employeeId ? 'mine' : ''}`}>{row.employeeName.slice(0, 1)}</span><div><strong>{row.employeeName}{row.employeeId === view?.employeeId && <small>나</small>}</strong><p>{row.kind === 'off' ? '휴무' : `${row.startTime} – ${row.endTime}${row.endTime <= row.startTime ? ' (다음 날)' : ''}`}</p>{row.kind === 'work' && <small>휴게 {row.breakMinutes}분</small>}</div><span className={`staff-shift-kind ${row.kind}`}>{row.kind === 'off' ? '휴무' : '근무'}</span></li>)}</ul>}
        </div></div>
      </section>
      <section className="staff-notices" aria-label="매장 공지"><div className="staff-section-heading"><div><h2>매장 공지</h2><p>함께 확인할 소식을 모았습니다.</p></div><span className="staff-notice-count">{notices.length}</span></div>
        {!notices.length ? <p className="staff-empty">게시된 매장 공지가 없습니다.</p> : <ul>{notices.map(notice => <li key={notice.id}><button type="button" aria-expanded={openNotice === notice.id} onClick={() => setOpenNotice(openNotice === notice.id ? '' : notice.id)}><span>{notice.pinned && <small className="staff-pinned">중요</small>}<strong>{notice.title}</strong><time>{staffDate(Date.parse(notice.updatedAt)).replaceAll('-', '.')}</time></span><span aria-hidden="true">{openNotice === notice.id ? '−' : '+'}</span></button>{openNotice === notice.id && <p className="staff-notice-body">{notice.body}</p>}</li>)}</ul>}
      </section>
      {onOpenPersonal && <details className="staff-personal-menu"><summary>내 인사 메뉴<span>휴가·급여·문서 등</span></summary><nav aria-label="내 인사 메뉴">{staffPersonalTabs.map(([id, label]) => <button type="button" key={id} disabled={Boolean(phase)} onClick={() => onOpenPersonal(id)}>{label}<span aria-hidden="true">›</span></button>)}</nav></details>}
    </>}
  </main>;

  function changeMonth(offset: number) {
    const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1));
    const next = date.toISOString().slice(0, 7); setMonth(next); setSelectedDate(`${next}-01`);
  }
}

function ScheduleCalendar({ month, today, selected, mode, rows, onSelect }: { month: string; today: string; selected: string; mode: 'mine' | 'store'; rows: HrStoreScheduleEntry[]; onSelect: (date: string) => void }) {
  const year = Number(month.slice(0, 4)); const monthIndex = Number(month.slice(5)) - 1;
  const offset = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const weeks = Math.ceil((days + offset) / 7);
  return <table className="staff-calendar" aria-label={`${year}년 ${monthIndex + 1}월 근무 달력`}><thead><tr>{['일', '월', '화', '수', '목', '금', '토'].map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead><tbody>{Array.from({ length: weeks }, (_, week) => <tr key={week}>{Array.from({ length: 7 }, (_, weekday) => {
    const day = week * 7 + weekday - offset + 1;
    if (day < 1 || day > days) return <td key={weekday} />;
    const date = `${month}-${String(day).padStart(2, '0')}`; const dayRows = rows.filter(row => row.date === date);
    const working = dayRows.filter(row => row.kind === 'work'); const text = mode === 'store' ? working.length ? `${new Set(working.map(row => row.employeeId)).size}명` : dayRows.length ? '휴무' : '' : working[0]?.startTime || (dayRows.length ? '휴무' : '');
    return <td key={weekday}><button type="button" className={`${selected === date ? 'selected' : ''} ${today === date ? 'today' : ''}`} aria-label={`${date}${text ? ` ${text}` : ' 일정 없음'}`} aria-pressed={selected === date} aria-current={today === date ? 'date' : undefined} onClick={() => onSelect(date)}><span>{day}</span><small className={working.length ? 'work' : 'off'}>{text || '\u00a0'}</small></button></td>;
  })}</tr>)}</tbody></table>;
}
