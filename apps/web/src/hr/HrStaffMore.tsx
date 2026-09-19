import { useEffect, useState, type ReactNode } from 'react';
import type { HrResponse } from '../api/oda-hr-client';
import { CalendarDays, ChevronRight, CircleDollarSign, ClipboardCheck, Clock3, FileCheck2, Info, LockKeyhole, ReceiptText, Search, Sparkles, UserRound } from '../components/icons';
import type { StaffPersonalTab } from '../pages/OdaStaffPage';
import type { BootstrapData } from '../types';
import { HrDialog, hrToday } from './shared';

type Props = {
  response: HrResponse | null;
  data: BootstrapData;
  busy: boolean;
  onOpenPersonal: (tab: StaffPersonalTab) => void;
  onOpenSchedule: () => void;
  onOpenNotices: () => void;
};
type MenuId = 'operations' | 'notices' | 'attendance' | 'leave' | 'schedule' | 'people' | 'meetings' | 'approvals' | 'expenses' | 'payroll' | 'contracts' | 'documents' | 'goals' | 'reviews' | 'company' | 'settings' | 'help';
type Menu = { id: MenuId; label: string; icon: ReactNode; personal?: StaffPersonalTab };
type StaffPreferences = { version: 1; text: 'standard' | 'comfortable'; favorites: MenuId[] };
const menuIds: MenuId[] = ['operations', 'notices', 'attendance', 'leave', 'schedule', 'people', 'meetings', 'approvals', 'expenses', 'payroll', 'contracts', 'documents', 'goals', 'reviews', 'company', 'settings', 'help'];
const preferenceEvent = 'oda:staff-preferences';
// Keep display preferences usable for this session even when device storage is disabled.
const sessionPreferences = new Map<string, StaffPreferences>();
const preferenceKey = (actorId: string, storeId: string) => `oda:staff-preferences:${encodeURIComponent(actorId)}:${encodeURIComponent(storeId)}`;
const defaults = (): StaffPreferences => ({ version: 1, text: 'standard', favorites: [] });

function readPreferences(key: string): StaffPreferences {
  const saved = sessionPreferences.get(key);
  if (saved) return saved;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (!value || typeof value !== 'object') return defaults();
    const source = value as Record<string, unknown>;
    if (source.version !== 1) return defaults();
    return { version: 1, text: source.text === 'comfortable' ? 'comfortable' : 'standard', favorites: Array.isArray(source.favorites) ? [...new Set(source.favorites.filter((id): id is MenuId => typeof id === 'string' && menuIds.includes(id as MenuId)))].slice(0, menuIds.length) : [] };
  } catch { return defaults(); }
}

function useStaffPreferences(actorId: string, storeId: string) {
  const key = preferenceKey(actorId, storeId);
  const [state, setState] = useState(() => ({ key, value: readPreferences(key) }));
  useEffect(() => {
    const refresh = () => setState({ key, value: readPreferences(key) });
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === key) refresh(); };
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { sessionPreferences.delete(key); refresh(); } };
    refresh();
    window.addEventListener(preferenceEvent, changed);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(preferenceEvent, changed); window.removeEventListener('storage', storage); };
  }, [key]);
  const preferences = state.key === key ? state.value : readPreferences(key);
  function update(value: StaffPreferences): boolean {
    sessionPreferences.set(key, value);
    let persisted = true;
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { persisted = false; }
    setState({ key, value });
    window.dispatchEvent(new CustomEvent(preferenceEvent, { detail: key }));
    return persisted;
  }
  return { preferences, update };
}

/** The page reads this value so the device preference also applies outside the More tab. */
export function useStaffTextPreference(actorId: string, storeId: string) {
  return useStaffPreferences(actorId, storeId).preferences.text;
}

function tenureLabel(hireDate: string | undefined): string {
  if (!hireDate || !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return '입사일 미등록';
  const start = new Date(`${hireDate}T00:00:00Z`);
  if (!Number.isFinite(start.valueOf()) || start.toISOString().slice(0, 10) !== hireDate) return '입사일 미등록';
  const today = hrToday();
  if (hireDate > today) return `입사 예정 · ${hireDate.replaceAll('-', '.')}`;
  const end = new Date(`${today}T00:00:00Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const anchor = (offset: number) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(start.getUTCDate(), last)); return date;
  };
  if (anchor(months) > end) months--;
  const days = Math.floor((end.valueOf() - anchor(months).valueOf()) / 86_400_000);
  const years = Math.floor(months / 12); const remainder = months % 12;
  const duration = [years ? `${years}년` : '', remainder ? `${remainder}개월` : '', days ? `${days}일` : ''].filter(Boolean).join(' ');
  return duration ? `입사한 지 ${duration}` : '오늘 입사했어요';
}

function MenuSymbol({ kind }: { kind: 'notice' | 'leave' | 'team' | 'settings' | 'star' }) {
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'notice' && <><path d="m4 9 8-2 7-4v18l-7-4-8-2V9Z" /><path d="m7 16 1 5h4l-1-4M3 11v2" /></>}
    {kind === 'leave' && <><path d="M3 12a9 9 0 0 1 18 0H3Zm9 0v7a2 2 0 0 0 4 0M12 2v1" /><path d="M8 12c0-5 2-9 4-9s4 4 4 9" /></>}
    {kind === 'team' && <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>}
    {kind === 'settings' && <><path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 2 3-1 2 4 3-1 1-3 4-1 1-4-3-2V6l-4-1-2-2h-2Z" /><circle cx="12" cy="12" r="3" /></>}
    {kind === 'star' && <path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />}
  </svg>;
}

export function HrStaffMore({ response, data, busy, onOpenPersonal, onOpenSchedule, onOpenNotices }: Props) {
  const workspace = response?.workspace;
  const storeId = workspace?.storeId || data.store.id;
  const scope = `${data.actor.id}:${storeId}`;
  const { preferences, update } = useStaffPreferences(data.actor.id, storeId);
  const [editingFavorites, setEditingFavorites] = useState(false);
  const [dialog, setDialog] = useState<{ scope: string; name: 'people' | 'company' | 'settings' } | null>(null);
  const [query, setQuery] = useState('');
  const [storageError, setStorageError] = useState('');
  const employee = workspace?.employees.find(row => row.id === response?.employeeId);
  const name = employee?.name || data.actor.name;
  const currentStore = data.stores.find(row => row.id === storeId);
  const disabled = busy || !response;
  const currentDialog = dialog?.scope === scope ? dialog.name : null;
  const menus: Menu[] = [
    { id: 'operations', label: '매장 업무·인수인계', icon: <ClipboardCheck size={23} aria-hidden="true" />, personal: 'operations' },
    { id: 'notices', label: '공지', icon: <MenuSymbol kind="notice" /> },
    { id: 'attendance', label: '근무', icon: <Clock3 size={23} aria-hidden="true" />, personal: 'attendance' },
    { id: 'leave', label: '휴가', icon: <MenuSymbol kind="leave" />, personal: 'leave' },
    { id: 'schedule', label: '구성원 근무', icon: <MenuSymbol kind="team" /> },
    { id: 'people', label: '구성원', icon: <UserRound size={23} aria-hidden="true" /> },
    { id: 'meetings', label: '미팅', icon: <CalendarDays size={23} aria-hidden="true" />, personal: 'meetings' },
    { id: 'approvals', label: '워크플로우', icon: <ClipboardCheck size={23} aria-hidden="true" />, personal: 'approvals' },
    { id: 'expenses', label: '비용 요청', icon: <ReceiptText size={23} aria-hidden="true" />, personal: 'expenses' },
    { id: 'payroll', label: '급여명세서', icon: <CircleDollarSign size={23} aria-hidden="true" />, personal: 'payroll' },
    { id: 'contracts', label: '계약 기록', icon: <LockKeyhole size={23} aria-hidden="true" />, personal: 'contracts' },
    { id: 'documents', label: '문서·증명서', icon: <FileCheck2 size={23} aria-hidden="true" />, personal: 'documents' },
    { id: 'goals', label: '내 목표', icon: <Sparkles size={23} aria-hidden="true" />, personal: 'goals' },
    { id: 'reviews', label: '내 평가', icon: <ClipboardCheck size={23} aria-hidden="true" />, personal: 'reviews' },
    { id: 'company', label: '회사 정보', icon: <Info size={23} aria-hidden="true" /> },
    { id: 'settings', label: '앱 설정', icon: <MenuSymbol kind="settings" /> },
    { id: 'help', label: '인사 도움말', icon: <Info size={23} aria-hidden="true" />, personal: 'help' },
  ];
  const favorites = preferences.favorites.flatMap(id => { const menu = menus.find(row => row.id === id); return menu ? [menu] : []; });
  useEffect(() => { setEditingFavorites(false); setDialog(null); setQuery(''); setStorageError(''); }, [scope]);

  function open(menu: Menu) {
    if (disabled) return;
    if (menu.personal) { onOpenPersonal(menu.personal); return; }
    if (menu.id === 'notices') { onOpenNotices(); return; }
    if (menu.id === 'schedule') { onOpenSchedule(); return; }
    if (menu.id === 'people' || menu.id === 'company' || menu.id === 'settings') { setQuery(''); setDialog({ scope, name: menu.id }); }
  }
  function save(next: StaffPreferences) {
    setStorageError(update(next) ? '' : '기기 저장 공간을 사용할 수 없어 이번 접속 동안만 적용됩니다.');
  }
  function toggleFavorite(id: MenuId) {
    save({ ...preferences, favorites: preferences.favorites.includes(id) ? preferences.favorites.filter(value => value !== id) : [...preferences.favorites, id] });
  }
  function menuRow(menu: Menu, favorite = false) {
    return <li className="staff-more-row" key={menu.id}>
      <button className="staff-more-link" type="button" disabled={disabled} onClick={() => open(menu)}>{menu.icon}<span>{menu.label}</span><ChevronRight size={18} aria-hidden="true" /></button>
      {editingFavorites && !favorite && <button className="staff-more-star" type="button" disabled={disabled} aria-label={`${menu.label} 즐겨찾기`} aria-pressed={preferences.favorites.includes(menu.id)} onClick={() => toggleFavorite(menu.id)}><MenuSymbol kind="star" /></button>}
    </li>;
  }
  const department = (id: string) => workspace?.departments.find(row => row.id === id)?.name || '';
  const search = query.trim().toLocaleLowerCase('ko-KR');
  const people = (workspace?.employees || []).filter(row => row.status !== 'retired' && (!search || [row.name, row.jobTitle, department(row.departmentId)].some(value => value.toLocaleLowerCase('ko-KR').includes(search)))).sort((a, b) => Number(b.id === response?.employeeId) - Number(a.id === response?.employeeId) || a.name.localeCompare(b.name, 'ko'));

  return <section className="staff-more" aria-label="더 보기">
    <div className="staff-more-profile"><span className="staff-more-avatar" aria-hidden="true">{name.slice(-2)}</span><div><h2>{name}</h2><p>{employee ? tenureLabel(employee.hireDate) : '직원 계정 연결 대기'}</p></div></div>
    <div className="staff-more-heading"><h3>전체 메뉴</h3><button type="button" disabled={disabled} aria-pressed={editingFavorites} onClick={() => setEditingFavorites(value => !value)}>{editingFavorites ? '완료' : '즐겨찾기 등록'}</button></div>
    {editingFavorites && <p className="staff-more-hint">자주 쓰는 메뉴의 별을 누르면 상단에 표시됩니다.</p>}
    {storageError && <p className="staff-more-warning" role="status">{storageError}</p>}
    {favorites.length > 0 && !editingFavorites && <nav className="staff-more-favorites" aria-label="즐겨찾기"><h3>즐겨찾기</h3><ul>{favorites.map(menu => menuRow(menu, true))}</ul></nav>}
    <nav className="staff-more-menu" aria-label="전체 메뉴"><ul>{menus.filter(menu => menu.id !== 'settings' && menu.id !== 'help').map(menu => menuRow(menu))}</ul><ul className="staff-more-utility">{menus.filter(menu => menu.id === 'settings' || menu.id === 'help').map(menu => menuRow(menu))}</ul></nav>
    <footer className="staff-more-footer"><strong>ODA</strong><span>직원 워크스테이션</span></footer>

    {currentDialog === 'people' && <HrDialog title="구성원" busy={busy} onClose={() => setDialog(null)}><div className="staff-more-directory"><label className="staff-more-search"><Search size={19} aria-hidden="true" /><input aria-label="구성원 검색" type="search" placeholder="이름, 조직, 직책 검색" value={query} onChange={event => setQuery(event.target.value)} /></label><p className="staff-more-hint">{currentStore?.name || workspace?.settings.companyName} · {people.length}명</p>{people.length ? <ul>{people.map(person => <li key={person.id}><span className="staff-more-avatar" aria-hidden="true">{person.name.slice(-2)}</span><div><strong>{person.name}{person.id === response?.employeeId && <small>나</small>}</strong><p>{[department(person.departmentId), person.jobTitle].filter(Boolean).join(' · ') || '소속 정보 미등록'}</p></div></li>)}</ul> : <p className="staff-empty">{search ? '검색 결과가 없습니다.' : '등록된 구성원이 없습니다.'}</p>}</div></HrDialog>}
    {currentDialog === 'company' && <HrDialog title="회사 정보" busy={busy} onClose={() => setDialog(null)}><dl className="staff-more-info"><div><dt>회사명</dt><dd>{workspace?.settings.companyName || '미등록'}</dd></div><div><dt>근무 매장</dt><dd>{currentStore?.name || '미등록'}</dd></div><div><dt>매장 주소</dt><dd>{response?.storeAddress || workspace?.settings.clockLocation?.address || currentStore?.roadAddress || '미등록'}</dd></div><div><dt>출퇴근 등록 위치</dt><dd>{workspace?.settings.clockLocation ? `${workspace.settings.clockLocation.address} · 반경 200m` : '관리자 설정 필요'}</dd></div><div><dt>기준 시간대</dt><dd>대한민국 · 서울</dd></div></dl></HrDialog>}
    {currentDialog === 'settings' && <HrDialog title="앱 설정" busy={busy} onClose={() => setDialog(null)}><div className="staff-more-settings"><label className="staff-more-setting"><span><strong>편안한 글자 크기</strong><small>글자를 조금 더 크게 표시합니다.</small></span><input type="checkbox" checked={preferences.text === 'comfortable'} disabled={busy} onChange={event => save({ ...preferences, text: event.target.checked ? 'comfortable' : 'standard' })} /></label><p className="staff-more-hint">글자 크기와 즐겨찾기는 이 기기의 현재 계정·매장에 저장됩니다.</p>{storageError && <p className="staff-more-warning" role="status">{storageError}</p>}<div className="staff-more-settings-note"><strong>출퇴근 위치 권한</strong><p>출퇴근 버튼을 누를 때 현재 위치를 확인합니다. 위치가 차단된 경우 브라우저의 사이트 권한에서 위치 접근을 허용해 주세요.</p></div></div></HrDialog>}
  </section>;
}
