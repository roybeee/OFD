import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { normalizeBootstrap } from '../api/client';
import type { HrResponse } from '../api/oda-hr-client';
import { HrLocationError } from '../lib/hr-location';
import { OdaStaffPage, staffDate } from './OdaStaffPage';
import { OdaHrPage } from './OdaHrPage';

const api = vi.hoisted(() => ({ get: vi.fn(), command: vi.fn(), position: vi.fn() }));
vi.mock('../api/oda-hr-client', async original => ({ ...await original<typeof import('../api/oda-hr-client')>(), getOdaHr: api.get, commandOdaHr: api.command }));
vi.mock('../lib/hr-location', async original => ({ ...await original<typeof import('../lib/hr-location')>(), getCurrentHrPosition: api.position }));
const NOW = Date.parse('2026-09-15T00:30:00Z');
const position = () => ({ latitude: 37.5, longitude: 127, accuracy: 10, timestamp: Date.now() });
const data = () => normalizeBootstrap({ currentActor: { id: 'staff-actor', name: '테스트 직원', role: 'store_staff' }, stores: [{ id: 's1', name: '첫 매장', business: {} }, { id: 's2', name: '두 번째 매장', business: {} }], capabilities: ['oda.hr.read'], meta: { appMode: 'production' } });
function response(storeId = 's1'): HrResponse {
  const w = createHrWorkspace(storeId, '테스트 매장', new Date(NOW).toISOString());
  w.settings.clockLocation = { address: '서울 매장 주소', latitude: 37.5, longitude: 127, radiusMeters: 200, updatedAt: new Date(NOW).toISOString(), updatedBy: 'manager' };
  w.employees.push({ id: 'e1', name: '테스트 직원', employeeNumber: 'E1', actorId: 'staff-actor', departmentId: '', jobTitle: '', employmentType: 'part_time', status: 'active', hireDate: '2026-01-01', payType: 'hourly', basePay: 0, history: [] });
  return { workspace: w, permissions: { manage: false, payroll: false, self: true }, employeeId: 'e1', storeSchedule: [] };
}
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW); vi.clearAllMocks();
  window.history.replaceState({}, '', '/store/oda-hr'); api.get.mockImplementation(async (id: string) => response(id)); api.position.mockImplementation(async () => position());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
function findButton(label: string, within: ParentNode = container) {
  return [...within.querySelectorAll('button')].find(row => {
    const copy = row.cloneNode(true) as HTMLButtonElement;
    copy.querySelectorAll('[aria-hidden="true"]').forEach(hidden => hidden.remove());
    return (row.getAttribute('aria-label') || copy.textContent?.trim()) === label;
  });
}
async function click(label: string, within: ParentNode = container) {
  const button = findButton(label, within);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function navigate(label: string) { await click(label, container.querySelector('nav[aria-label="직원 앱 메뉴"]')!); }
async function searchMenu(query: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="메뉴·공지 검색"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function selectStore(id: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="직원 홈 매장"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id); select.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function render() { await act(async () => root.render(<OdaStaffPage data={data()} notify={vi.fn()} />)); }

describe('employee workday home', () => {
  it('does not write on entry and explains a denied fresh location without registering attendance', async () => {
    api.position.mockRejectedValue(new HrLocationError('denied', '위치 사용이 허용되지 않았습니다. 브라우저 설정에서 허용해 주세요.'));
    await render(); expect(api.command).not.toHaveBeenCalled(); expect(api.position).not.toHaveBeenCalled();
    await click('출근하기'); expect(container.textContent).toContain('위치 사용이 허용되지 않았습니다'); expect(api.command).not.toHaveBeenCalled();
  });

  it.each([
    [{ latitude: 37.503, longitude: 127, accuracy: 10 }, '매장 근처에서 확인'],
    [{ latitude: 37.5, longitude: 127, accuracy: 75 }, '위치 정확도가 부족'],
    [{ latitude: 37.5, longitude: 127, accuracy: 10, timestamp: NOW - 61_000 }, '위치 정보가 오래'],
  ])('rejects an outside, inaccurate or old reading before any POST', async (value, message) => {
    api.position.mockResolvedValue({ ...position(), ...value }); await render(); await click('출근하기');
    expect(container.querySelector('.staff-clock-error')?.textContent).toContain(message); expect(api.command).not.toHaveBeenCalled();
  });

  it('gets a new location even after a preview, uses the refreshed version and prevents double clicks', async () => {
    const initial = response(); const fresh = response(); fresh.workspace.version = 9;
    api.get.mockResolvedValueOnce(initial).mockResolvedValue(fresh);
    const saved = response(); saved.workspace.version = 10;
    saved.workspace.attendance.clockEvents.push({ id: 'clock1', employeeId: 'e1', actorId: 'staff-actor', kind: 'in', at: new Date(NOW).toISOString(), workEntryId: '' });
    let resolve!: (value: HrResponse) => void; api.command.mockImplementation(() => new Promise<HrResponse>(done => { resolve = done; }));
    await render(); await click('근무 등록'); await click('위치 다시 확인'); expect(api.position).toHaveBeenCalledTimes(1);
    const button = findButton('출근하기', container.querySelector('[role="dialog"]')!)!;
    await act(async () => { button.click(); button.click(); });
    expect(api.position).toHaveBeenCalledTimes(2); expect(api.command).toHaveBeenCalledTimes(1);
    expect(api.command).toHaveBeenCalledWith('s1', 9, 'clock.in', { employeeId: 'e1', location: position() });
    await act(async () => resolve(saved)); expect(container.textContent).toContain('출근을 기록했습니다'); expect(findButton('퇴근하기')).toBeTruthy();
  });

  it('uses the last clock state across midnight and records clock-out with a fresh location', async () => {
    const initial = response(); initial.workspace.attendance.clockEvents.push({ id: 'yesterday', employeeId: 'e1', actorId: 'staff-actor', kind: 'in', at: '2026-09-14T14:30:00Z', workEntryId: '' });
    api.get.mockResolvedValue(initial);
    const saved = structuredClone(initial); saved.workspace.attendance.clockEvents.push({ id: 'out', employeeId: 'e1', actorId: 'staff-actor', kind: 'out', at: new Date(NOW).toISOString(), workEntryId: 'work' });
    api.command.mockResolvedValue(saved); await render(); expect(container.querySelector('.staff-clock-dock')?.textContent).toContain('9. 14. 23:30 출근');
    await click('근무 등록'); expect(container.textContent).toContain('이전 날짜의 출근 기록');
    await click('퇴근하기'); expect(api.command).toHaveBeenCalledWith('s1', 0, 'clock.out', { employeeId: 'e1', location: position() });
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).toContain('퇴근 완료');
  });

  it('discards a late location after switching stores and never posts to the previous store', async () => {
    let resolve!: (value: ReturnType<typeof position>) => void; api.position.mockImplementation(() => new Promise(done => { resolve = done; }));
    await render(); await click('출근하기'); await selectStore('s2');
    await act(async () => resolve(position()));
    expect(api.command).not.toHaveBeenCalled(); expect(container.querySelector<HTMLSelectElement>('[aria-label="직원 홈 매장"]')!.value).toBe('s2');
    expect(container.textContent).not.toContain('위치 확인 중…');
  });

  it('stops if another device changed the clock state while refreshing', async () => {
    const changed = response(); changed.workspace.attendance.clockEvents.push({ id: 'other', employeeId: 'e1', actorId: 'staff-actor', kind: 'in', at: new Date(NOW).toISOString(), workEntryId: '' });
    api.get.mockResolvedValueOnce(response()).mockResolvedValueOnce(changed);
    await render(); await click('출근하기'); expect(api.command).not.toHaveBeenCalled();
    expect(container.textContent).toContain('출퇴근 상태가 변경'); expect(findButton('퇴근하기')).toBeTruthy();
  });

  it('shows only published schedules, separates own and team days, and orders pinned published notices first', async () => {
    const r = response();
    r.workspace.attendance.shifts.push({ id: 'mine', employeeId: 'e1', date: '2026-09-15', templateId: '', startTime: '18:00', endTime: '02:00', breakMinutes: 30, kind: 'work', status: 'published', revision: 1, publishedAt: new Date(NOW).toISOString(), note: '' }, { id: 'draft', employeeId: 'e1', date: '2026-09-16', templateId: '', startTime: '10:00', endTime: '15:00', breakMinutes: 30, kind: 'work', status: 'draft', revision: 1, publishedAt: '', note: '' });
    r.storeSchedule = [{ id: 'mine', employeeId: 'e1', employeeName: '테스트 직원', date: '2026-09-15', startTime: '18:00', endTime: '02:00', breakMinutes: 30, kind: 'work' }, { id: 'team', employeeId: 'e2', employeeName: '팀 동료', date: '2026-09-15', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work' }];
    r.workspace.notices = [{ id: 'ordinary', title: '일반 공지', body: '내용', pinned: false, status: 'published', createdBy: 'm', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, { id: 'pin', title: '고정 공지', body: '중요 안내', pinned: true, status: 'published', createdBy: 'm', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }, { id: 'secret', title: '비공개 초안', body: '미게시', pinned: true, status: 'draft', createdBy: 'm', createdAt: '', updatedAt: '' }];
    api.get.mockResolvedValue(r); await render(); expect(container.textContent).not.toContain('팀 동료');
    expect(container.querySelector('.staff-notices li strong')?.textContent).toBe('고정 공지'); expect(container.textContent).not.toContain('비공개 초안');
    await navigate('일정'); expect(container.querySelector('.staff-shift-bands')?.textContent).toContain('02:00 다음 날');
    expect(container.querySelectorAll('.staff-calendar tbody tr')).toHaveLength(1);
    expect(container.querySelectorAll('.staff-calendar tbody button')).toHaveLength(7);
    expect(container.querySelector('[aria-label="2026-09-16 일정 없음"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="2026-09-15 18:00"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="2026-09-15 2명"]')).toBeNull();
    await click('일정 필터'); await click('매장'); expect(container.textContent).toContain('팀 동료'); expect(container.querySelector('[aria-label="2026-09-15 2명"]')).toBeTruthy();
    await click('나'); expect(container.querySelector('[aria-label="2026-09-15 18:00"]')).toBeTruthy();
    await click('다음 주'); expect(container.querySelector('[aria-label="2026-09-22 일정 없음"]')?.getAttribute('aria-pressed')).toBe('true');
    await click('이전 주'); expect(container.querySelector('[aria-label="2026-09-15 18:00"]')?.getAttribute('aria-pressed')).toBe('true');
    await click('월 전체 보기'); expect(container.querySelectorAll('.staff-calendar tbody button')).toHaveLength(30);
    await click('다음 달'); expect(container.querySelector('[aria-label="2026년 10월 근무 달력"]')).toBeTruthy();
    expect(container.querySelectorAll('.staff-calendar tbody button')).toHaveLength(31);
  });

  it('blocks unlinked employees and unset locations without leaking the team schedule', async () => {
    const r = response(); delete r.employeeId; delete r.workspace.settings.clockLocation; r.permissions.self = false;
    r.storeSchedule = [{ id: 'secret', employeeId: 'e2', employeeName: '다른 직원', date: '2026-09-15', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work' }];
    api.get.mockResolvedValue(r); await render();
    expect(container.textContent).toContain('관리자에게 직원 계정 연결'); expect(container.textContent).toContain('출퇴근 위치 설정이 필요해요');
    expect(findButton('출근하기')!.disabled).toBe(true);
    await click('근무 등록'); expect(container.textContent).toContain('위치가 아직 등록되지 않았습니다');
    expect(findButton('출근하기', container.querySelector('[role="dialog"]')!)!.disabled).toBe(true);
    await click('근무 등록 닫기'); await navigate('일정'); await click('일정 필터');
    expect(findButton('매장')!.disabled).toBe(true);
    expect(container.textContent).not.toContain('다른 직원'); expect(api.position).not.toHaveBeenCalled();
  });

  it('updates the Korean date across midnight and refreshes on focus', async () => {
    await render(); expect(staffDate(Date.parse('2026-09-15T15:01:00Z'))).toBe('2026-09-16');
    await act(async () => { vi.setSystemTime(Date.parse('2026-09-15T15:00:01Z')); await vi.advanceTimersByTimeAsync(30_000); });
    expect(container.querySelector('.staff-heading h1')?.textContent).toBe('9월 16일'); expect(api.get).toHaveBeenCalledTimes(2);
    await navigate('일정'); expect(container.querySelector('[aria-current="date"]')?.getAttribute('aria-label')).toBe('2026-09-16 일정 없음');
    await act(async () => window.dispatchEvent(new Event('focus'))); expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('searches published notices and personal menus, and switches the four screens without writing', async () => {
    const r = response();
    r.workspace.notices = [{ id: 'public', title: '9월 운영 안내', body: '마감 점검 안내', pinned: true, status: 'published', createdBy: 'manager', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() },
      { id: 'draft', title: '9월 비공개 안내', body: '공개 전 내용', pinned: false, status: 'draft', createdBy: 'manager', createdAt: '', updatedAt: '' }];
    api.get.mockResolvedValue(r); const onOpenPersonal = vi.fn();
    await act(async () => root.render(<OdaStaffPage data={data()} notify={vi.fn()} onOpenPersonal={onOpenPersonal} />));
    expect([...container.querySelectorAll('nav[aria-label="직원 앱 메뉴"] button')].map(row => row.textContent)).toEqual(['오늘', '일정', '할 일', '더 보기']);
    await searchMenu('9월');
    expect(container.querySelector('[aria-label="검색 결과"]')?.textContent).toContain('9월 운영 안내');
    expect(container.textContent).not.toContain('9월 비공개 안내');
    await click('공지 · 9월 운영 안내');
    expect(container.querySelector('[role="dialog"] .staff-notice-body')?.textContent).toBe('마감 점검 안내');
    await click('매장 공지 닫기');
    await searchMenu('휴가'); await click('내 휴가', container.querySelector('[aria-label="검색 결과"]')!);
    expect(onOpenPersonal).toHaveBeenCalledWith('leave');
    for (const [label, view] of [['일정', 'schedule'], ['할 일', 'tasks'], ['더 보기', 'more'], ['오늘', 'today']] as const) {
      await navigate(label);
      expect(container.querySelector('nav[aria-label="직원 앱 메뉴"] [aria-current="page"]')?.textContent).toBe(label);
      expect(new URLSearchParams(window.location.search).get('view')).toBe(view);
    }
    expect(container.querySelector<HTMLInputElement>('[aria-label="메뉴·공지 검색"]')?.value).toBe('');
    expect(api.command).not.toHaveBeenCalled(); expect(api.position).not.toHaveBeenCalled();
  });

  it('routes staff into the focused home and retains only personal menus without legacy clock buttons', async () => {
    window.history.replaceState({}, '', '/store/oda-hr?tab=settings');
    await act(async () => root.render(<OdaHrPage data={data()} notify={vi.fn()} />));
    expect(container.querySelector('[aria-label="인사관리 메뉴"]')).toBeNull();
    await navigate('더 보기'); await click('근무', container.querySelector('[aria-label="전체 메뉴"]')!);
    expect(container.querySelector('[aria-label="인사관리 메뉴"]')?.textContent).not.toContain('설정');
    expect(container.textContent).toContain('출퇴근은 직원 홈에서 위치를 확인');
    expect([...container.querySelectorAll('button')].some(row => ['출근', '퇴근'].includes(row.textContent || ''))).toBe(false);
    await click('직원 홈으로 돌아가기'); expect(findButton('출근하기')).toBeTruthy();
    expect(container.querySelector('nav[aria-label="직원 앱 메뉴"] [aria-current="page"]')?.textContent).toBe('오늘');
  });
});
