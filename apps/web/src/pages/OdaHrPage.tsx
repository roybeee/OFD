import { useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api/client';
import { commandOdaHr, getOdaHr, type HrResponse } from '../api/oda-hr-client';
import { ChevronLeft, RefreshCcw, UserRound } from '../components/icons';
import { Button } from '../components/ui';
import { HrAttendance } from '../hr/HrAttendance';
import { HrPayroll } from '../hr/HrPayroll';
import { HrPersonnel } from '../hr/HrPersonnel';
import { HrTalent } from '../hr/HrTalent';
import { HrEsign } from '../hr/HrEsign';
import { HrWorkflow } from '../hr/HrWorkflow';
import { HrStoreOperations } from '../hr/HrStoreOperations';
import { HrEmpty, HrRecoveryContext, hrError, type HrPanelProps } from '../hr/shared';
import type { BootstrapData } from '../types';
import './OdaHrPage.css';
import { OdaStaffPage, staffPersonalTabs, type StaffPersonalTab } from './OdaStaffPage';
import { StaffBottomNav, staffHomeTabs, type StaffHomeTab } from '../hr/StaffNavigation';
import type { StaffDestination, StaffEntryIntent } from '../hr/StaffDestination';
import { useStaffTextPreference } from '../hr/HrStaffMore';

export const hrTabs = [
  ['overview', '홈·인사이트'], ['operations', '매장 업무'], ['people', '직원·조직'], ['attendance', '근무 기록'], ['shifts', '근무 일정'],
  ['leave', '휴가'], ['approvals', '전자결재'], ['expenses', '비용 청구'], ['payroll', '급여'],
  ['goals', '목표'], ['reviews', '평가'], ['meetings', '미팅'], ['recruitment', '채용'],
  ['contracts', '계약'], ['documents', '문서함'], ['settings', '설정'], ['help', '도움말'],
] as const;
export type HrTab = typeof hrTabs[number][0];

export function odaHrLocation(search: string, stores: ReadonlyArray<{ id: string }>, fallbackStore = ''): { storeId: string; tab: HrTab } {
  const query = new URLSearchParams(search);
  const tab = query.get('tab');
  const requestedStore = query.get('store');
  return {
    storeId: stores.find(store => store.id === requestedStore)?.id || stores.find(store => store.id === fallbackStore)?.id || stores[0]?.id || '',
    tab: hrTabs.some(([id]) => id === tab) ? tab as HrTab : 'overview',
  };
}

type Props = { data: BootstrapData; notify: (message: string, tone?: 'success' | 'info' | 'warning') => void };

export function OdaHrPage({ data, notify }: Props) {
  const sequence = useRef(0);
  const staffBusy = useRef(false);
  const currentUrl = useRef(window.location.href);
  function readRoute() {
    const query = new URLSearchParams(window.location.search), tab = query.get('tab'), view = query.get('view');
    const personalTab = staffPersonalTabs.some(([id]) => id === tab) ? tab as StaffPersonalTab : null;
    const homeTab = staffHomeTabs.includes(view as StaffHomeTab) ? view as StaffHomeTab : 'today';
    const recordId = query.get('record')?.slice(0, 120) || undefined;
    const childId = query.get('child')?.slice(0, 120) || undefined;
    const action = query.get('action') === 'create' ? 'create' as const : undefined;
    return { personalTab, homeTab, entryIntent: personalTab && (recordId || action) ? { recordId, childId, action, nonce: ++sequence.current } : undefined };
  }
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    function pop() {
      if (staffBusy.current) { window.history.pushState({}, '', currentUrl.current); return; }
      currentUrl.current = window.location.href; setRoute(readRoute());
    }
    if (data.actor.role === 'store_staff') window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [data.actor.id, data.actor.role]);
  function writeRoute(query: URLSearchParams) {
    const next = `${window.location.pathname}?${query}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.pushState({}, '', next);
    currentUrl.current = window.location.href;
    setRoute(readRoute());
    document.scrollingElement?.scrollTo?.({ top: 0 });
  }
  function staffNavigate(tab: StaffHomeTab) {
    if (staffBusy.current) return;
    const query = new URLSearchParams(window.location.search); query.set('view', tab);
    for (const name of ['tab', 'record', 'child', 'action']) query.delete(name);
    writeRoute(query);
  }
  function openStaffPersonal(tab: StaffPersonalTab, destination?: StaffDestination) {
    if (staffBusy.current) return;
    const query = new URLSearchParams(window.location.search); query.set('tab', tab);
    for (const name of ['record', 'child', 'action']) query.delete(name);
    if (destination?.recordId) query.set('record', destination.recordId);
    if (destination?.childId) query.set('child', destination.childId);
    if (destination?.action) query.set('action', destination.action);
    writeRoute(query);
  }
  if (data.actor.role === 'store_staff') {
    if (!route.personalTab) return <OdaStaffPage data={data} notify={notify} onOpenPersonal={openStaffPersonal} initialTab={route.homeTab} onHomeTabChange={staffNavigate} onBusyChange={value => { if (value) currentUrl.current = window.location.href; staffBusy.current = value; }} />;
    return <OdaHrWorkspacePage key={`${route.personalTab}:${route.entryIntent?.nonce || ''}`} data={data} notify={notify} personalTab={route.personalTab} entryIntent={route.entryIntent} onHome={() => staffNavigate(route.homeTab)} onStaffNavigate={staffNavigate} onPersonalNavigate={openStaffPersonal} onBusyChange={value => { if (value) currentUrl.current = window.location.href; staffBusy.current = value; }} />;
  }
  return <OdaHrWorkspacePage data={data} notify={notify} />;
}

function OdaHrWorkspacePage({ data, notify, personalTab, entryIntent, onHome, onStaffNavigate, onPersonalNavigate, onBusyChange }: Props & { personalTab?: StaffPersonalTab; entryIntent?: StaffEntryIntent; onHome?: () => void; onStaffNavigate?: (tab: StaffHomeTab) => void; onPersonalNavigate?: (tab: StaffPersonalTab) => void; onBusyChange?: (busy: boolean) => void }) {
  const personal = data.actor.role === 'store_staff';
  const visibleTabs = personal ? hrTabs.filter(([id]) => staffPersonalTabs.some(([allowed]) => allowed === id)) : hrTabs;
  const stores = data.stores.filter(store => store.active !== false);
  const initial = odaHrLocation(window.location.search, stores, data.store.id);
  const [storeId, setStoreId] = useState(initial.storeId);
  const [tab, setTab] = useState<HrTab>(personalTab || initial.tab);
  const [activeIntent, setActiveIntent] = useState(entryIntent);
  const staffText = useStaffTextPreference(data.actor.id, storeId);
  const [response, setResponse] = useState<HrResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const lock = useRef(false);
  const loadedStore = useRef('');
  const operationRetries = useRef(new Map<string, string>());
  const activeStore = useRef(storeId);
  activeStore.current = storeId;
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    function onPopState() {
      if (lock.current) return;
      const location = odaHrLocation(window.location.search, stores, data.store.id);
      if (location.storeId !== activeStore.current) setActiveIntent(undefined);
      setStoreId(location.storeId); setTab(personal && !visibleTabs.some(([id]) => id === location.tab) ? personalTab || 'leave' : location.tab);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [data]);

  useEffect(() => {
    const controller = new AbortController();
    if (loadedStore.current !== storeId) { setResponse(null); setCommandError(''); }
    setLoadError('');
    if (!storeId) { setLoading(false); return; }
    setLoading(true);
    void getOdaHr(storeId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      loadedStore.current = storeId; setResponse(result);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(hrError(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [storeId, retry]);

  function select(nextStore: string, nextTab: HrTab) {
    if (lock.current || !visibleTabs.some(([id]) => id === nextTab)) return;
    const query = new URLSearchParams(window.location.search);
    query.set('store', nextStore); query.set('tab', nextTab);
    for (const name of ['record', 'child', 'action']) query.delete(name);
    if (personal && nextTab !== tab && nextStore === storeId) { onPersonalNavigate?.(nextTab as StaffPersonalTab); return; }
    window.history.replaceState({}, '', `${window.location.pathname}?${query}`);
    setActiveIntent(undefined); setStoreId(nextStore); setTab(nextTab);
    setCommandError('');
  }

  async function mutate(type: string, input: Record<string, unknown>) {
    if (!response || loading || loadError || lock.current) throw new Error('인사 정보를 불러온 뒤 다시 시도해 주세요.');
    const mutationStore = storeId;
    lock.current = true; onBusyChange?.(true); setBusy(true); setCommandError('');
    const operationSignature = type.startsWith('operations.') ? JSON.stringify([mutationStore, response.workspace.version, type, input]) : '';
    try {
      const key = operationSignature ? operationRetries.current.get(operationSignature) || newIdempotencyKey() : undefined;
      if (operationSignature && key) operationRetries.current.set(operationSignature, key);
      const result = key
        ? await commandOdaHr(mutationStore, response.workspace.version, type, input, key)
        : await commandOdaHr(mutationStore, response.workspace.version, type, input);
      if (operationSignature) operationRetries.current.delete(operationSignature);
      if (alive.current && activeStore.current === mutationStore) { setResponse(result); notify('변경 사항을 저장했습니다.', 'success'); }
    } catch (error) {
      if (operationSignature && error instanceof ApiError && error.status < 500) operationRetries.current.delete(operationSignature);
      let message = hrError(error);
      if (error instanceof ApiError && error.status === 409 && ['VERSION_CONFLICT', 'HR_CONFLICT', 'hr_conflict'].includes(error.code)) {
        message = `${hrError(error)} 최신 정보를 불러왔습니다. 입력 내용을 확인한 뒤 다시 저장해 주세요.`;
        try {
          const latest = await getOdaHr(mutationStore);
          if (alive.current && activeStore.current === mutationStore) setResponse(latest);
        } catch (refreshError) {
          message = `${hrError(error)} 최신 정보를 다시 불러온 뒤 저장해 주세요.`;
          if (alive.current) setLoadError(hrError(refreshError));
        }
      }
      if (alive.current) setCommandError(message);
      throw new Error(message);
    } finally {
      lock.current = false; onBusyChange?.(false);
      if (alive.current) setBusy(false);
    }
  }

  async function reload() {
    const requestedStore = storeId;
    setLoading(true); setLoadError('');
    try {
      const result = await getOdaHr(requestedStore);
      if (alive.current && activeStore.current === requestedStore) { loadedStore.current = requestedStore; setResponse(result); }
    } catch (error) {
      if (alive.current && activeStore.current === requestedStore) setLoadError(hrError(error));
      throw error;
    } finally {
      if (alive.current && activeStore.current === requestedStore) setLoading(false);
    }
  }

  const panel: HrPanelProps | null = response && loadedStore.current === storeId ? {
    workspace: response.workspace, permissions: response.permissions, employeeId: response.employeeId,
    actorId: data.actor.id, mutate, busy: busy || loading || Boolean(loadError), onReload: reload, storeAddress: response.storeAddress,
  } : null;
  const title = hrTabs.find(([id]) => id === tab)?.[1] || '인사관리';

  return <main id="main-content" className={`page oda-hr-page${personal ? ' oda-hr-personal' : ''}`} data-staff-text={personal ? staffText : undefined} tabIndex={-1}>
    {personal ? <header className="staff-personal-heading"><div><button className="staff-icon-button" type="button" aria-label="직원 홈으로 돌아가기" onClick={onHome} disabled={busy}><ChevronLeft size={22} /></button><h1>{staffPersonalTabs.find(([id]) => id === tab)?.[1] || title}</h1><button className="staff-icon-button" type="button" aria-label="인사 정보 새로고침" disabled={busy || loading} onClick={() => setRetry(value => value + 1)}><RefreshCcw size={19} /></button></div><label className="staff-personal-context"><span>근무 매장</span><select aria-label="인사관리 매장" value={storeId} disabled={busy || !stores.length} onChange={event => select(event.target.value, tab)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label></header> : <header className="hr-page-heading"><div><p className="hr-kicker">ODA · PEOPLE</p><h1><UserRound size={28} aria-hidden="true" /> {personal ? '내 인사 메뉴' : '인사관리'}</h1><p>{personal ? '나의 신청과 기록을 확인하세요. 출퇴근은 직원 홈에서 기록합니다.' : '직원과 조직, 매일의 근무부터 성장까지 한곳에서 관리합니다.'}</p>{onHome && <Button variant="secondary" onClick={onHome} disabled={busy} style={{ marginTop: 12 }}>직원 홈으로 돌아가기</Button>}</div>
      <div className="hr-header-actions"><label className="hr-field"><span>작업할 매장</span><select aria-label="인사관리 매장" value={storeId} disabled={busy || !stores.length} onChange={event => select(event.target.value, tab)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <Button variant="secondary" onClick={() => setRetry(value => value + 1)} disabled={busy || loading || !storeId}><RefreshCcw size={16} /> {loading ? '불러오는 중' : '새로고침'}</Button></div>
    </header>}
    {!stores.length ? <HrEmpty title="배정된 매장이 없습니다">계정 관리자에게 매장 배정을 요청해 주세요.</HrEmpty> : <>
      <nav className={personal ? "staff-personal-menu" : "hr-tabs"} aria-label="인사관리 메뉴">{personal ? <label><span>내 인사 메뉴</span><select aria-label="내 인사 메뉴" value={tab} disabled={busy} onChange={event => select(storeId, event.target.value as HrTab)}>{staffPersonalTabs.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label> : <>{visibleTabs.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} disabled={busy} onClick={() => select(storeId, id)}>{personal ? staffPersonalTabs.find(([key]) => key === id)?.[1] || label : label}</button>)}</>}</nav>
      {loadError && <div className="hr-error" role="alert"><strong>인사 정보를 불러오지 못했습니다.</strong><p>{loadError}</p><Button variant="secondary" disabled={loading || busy} onClick={() => setRetry(value => value + 1)}>다시 불러오기</Button></div>}
      {commandError && <div className="hr-error" role="alert">{commandError}</div>}
      {loading && <p className="hr-loading" role="status">선택한 매장의 인사 정보를 불러오고 있습니다.</p>}
      {panel && <HrRecoveryContext.Provider value={{ error: loadError, pending: busy || loading, retry: () => setRetry(value => value + 1) }}><section className="hr-content" aria-label={title} aria-busy={busy || loading} key={storeId}>
        {(['overview', 'people', 'documents', 'settings', 'help'] as string[]).includes(tab) && <HrPersonnel {...panel} accounts={response?.accounts || []} tab={tab as 'overview' | 'people' | 'documents' | 'settings' | 'help'} onTabChange={next => select(storeId, next)} onStaffHome={personal ? () => onStaffNavigate?.('today') : onHome} />}
        {(tab === 'attendance' || tab === 'leave' || tab === 'shifts') && <HrAttendance {...panel} tab={tab} hideClock={personal} entryIntent={personalTab === tab ? activeIntent : undefined} />}
        {(tab === 'approvals' || tab === 'expenses') && <HrWorkflow {...panel} tab={tab} entryIntent={personalTab === tab ? activeIntent : undefined} />}
        {tab === 'operations' && <HrStoreOperations {...panel} />}
        {tab === 'payroll' && <HrPayroll {...panel} />}
        {(tab === 'goals' || tab === 'reviews' || tab === 'meetings' || tab === 'recruitment') && <HrTalent {...panel} tab={tab} entryIntent={personalTab === tab ? activeIntent : undefined} />}
        {tab === 'contracts' && <HrEsign {...panel} accounts={response?.accounts || []} />}
      </section></HrRecoveryContext.Provider>}
    </>}
    {personal && onStaffNavigate && <StaffBottomNav active="more" onSelect={onStaffNavigate} disabled={busy} />}
  </main>;
}
