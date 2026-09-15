import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { normalizeBootstrap } from '../api/client';
import type { HrResponse } from '../api/oda-hr-client';
import type { BootstrapData } from '../types';
import { HrStaffMore, useStaffTextPreference } from './HrStaffMore';

let root: Root; let container: HTMLDivElement; let actorId: string; let run = 0;
const onOpenPersonal = vi.fn(); const onOpenNotices = vi.fn(); const onOpenSchedule = vi.fn();
const fixture = (storeId = 's1'): HrResponse => {
  const workspace = createHrWorkspace(storeId, '등록된 회사', '2026-09-16T00:00:00Z');
  workspace.departments = [{ id: 'kitchen', name: '주방팀', archived: false }];
  workspace.employees = [
    { id: 'own', name: '박직원', employeeNumber: 'PRIVATE-NUMBER', departmentId: 'kitchen', jobTitle: '매니저', actorId, employmentType: 'regular', status: 'active', hireDate: '2026-05-24', payType: 'monthly', basePay: 6543210, email: 'private@example.test', phone: '010-1234-5678', history: [] },
    { id: 'coworker', name: '김동료', employeeNumber: 'COLLEAGUE-NUMBER', departmentId: 'kitchen', jobTitle: '조리사', employmentType: 'regular', status: 'active', hireDate: '', payType: 'monthly', basePay: 0, history: [] },
    { id: 'retired', name: '퇴직 직원', employeeNumber: 'R1', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'retired', hireDate: '', payType: 'monthly', basePay: 0, history: [] },
  ];
  workspace.settings.clockLocation = { address: '서울 기준 위치', latitude: 37.5, longitude: 127, radiusMeters: 200, updatedAt: '', updatedBy: 'manager' };
  return { workspace, employeeId: 'own', permissions: { manage: false, payroll: false, self: true }, storeAddress: '서울 등록 주소' };
};
const data = (): BootstrapData => normalizeBootstrap({ currentActor: { id: actorId, name: '계정 이름', role: 'store_staff' }, stores: [{ id: 's1', name: '성수점', business: {} }, { id: 's2', name: '외대점', business: {} }], capabilities: ['oda.hr.read'] });
function Harness({ response, busy = false }: { response: HrResponse | null; busy?: boolean }) {
  const bootstrap = data();
  const text = useStaffTextPreference(bootstrap.actor.id, response?.workspace.storeId || bootstrap.store.id);
  return <main className="oda-staff-page" data-staff-text={text}><HrStaffMore response={response} data={bootstrap} busy={busy} onOpenPersonal={onOpenPersonal} onOpenNotices={onOpenNotices} onOpenSchedule={onOpenSchedule} /></main>;
}
beforeEach(() => {
  actorId = `more-test-${++run}`; vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function render(response: HrResponse | null = fixture(), busy = false) { await act(async () => root.render(<Harness response={response} busy={busy} />)); }
async function click(label: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll('button')].find(row => (row.getAttribute('aria-label') || row.textContent?.trim()) === label)!;
  expect(button, label).toBeTruthy(); await act(async () => button.click());
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="구성원 검색"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('opens each existing personal function and dedicated views from the row menu', async () => {
  await render();
  for (const [label, tab] of [['근무', 'attendance'], ['휴가', 'leave'], ['미팅', 'meetings'], ['워크플로우', 'approvals'], ['비용 요청', 'expenses'], ['급여명세서', 'payroll'], ['계약 기록', 'contracts'], ['문서·증명서', 'documents'], ['내 목표', 'goals'], ['내 평가', 'reviews'], ['인사 도움말', 'help']]) {
    await click(label); expect(onOpenPersonal).toHaveBeenLastCalledWith(tab);
  }
  await click('공지'); expect(onOpenNotices).toHaveBeenCalledOnce();
  await click('구성원 근무'); expect(onOpenSchedule).toHaveBeenCalledOnce();
  expect(container.textContent).not.toMatch(/전자계약|미니게임|1:1 문의/);
});

it('uses the linked employee name and actual calendar tenure rather than the login name', async () => {
  await render();
  const profile = container.querySelector('.staff-more-profile')!;
  expect(profile.textContent).toContain('박직원'); expect(profile.textContent).toContain('입사한 지 3개월 23일');
  const future = fixture(); future.workspace.employees[0].hireDate = '2026-10-01'; await render(future);
  expect(profile.textContent).toContain('입사 예정 · 2026.10.01');
  future.workspace.employees[0].hireDate = '2026-02-30'; await render(future);
  expect(profile.textContent).toContain('입사일 미등록');
});

it('searches the scoped directory while excluding pay, contact, private dates and history', async () => {
  await render(); await click('구성원');
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true'); expect(dialog.textContent).toContain('김동료');
  expect(dialog.textContent).not.toMatch(/6543210|private@example|010-1234|PRIVATE-NUMBER|COLLEAGUE-NUMBER|2026-05-24|퇴직 직원/);
  await search('조리사'); expect(dialog.textContent).toContain('김동료'); expect(dialog.textContent).not.toContain('박직원');
  await search('없는 이름'); expect(dialog.textContent).toContain('검색 결과가 없습니다.');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await click('구성원'); expect(container.querySelector<HTMLInputElement>('[aria-label="구성원 검색"]')!.value).toBe('');
});

it('shows company and store information from the current scoped response without employee pay data', async () => {
  await render(); await click('회사 정보');
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('등록된 회사'); expect(dialog.textContent).toContain('성수점');
  expect(dialog.textContent).toContain('서울 등록 주소'); expect(dialog.textContent).toContain('서울 기준 위치 · 반경 200m');
  expect(dialog.textContent).not.toMatch(/6543210|private@example|127|37.5/);
  await render(fixture('s2')); expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('persists favorites and larger text for the account and store and restores them on revisiting', async () => {
  await render(); await click('즐겨찾기 등록'); await click('휴가 즐겨찾기'); await click('급여명세서 즐겨찾기'); await click('완료');
  const favorites = container.querySelector('nav[aria-label="즐겨찾기"]')!;
  expect(favorites.textContent).toContain('휴가'); expect(favorites.textContent).toContain('급여명세서');
  await click('휴가', favorites); expect(onOpenPersonal).toHaveBeenLastCalledWith('leave');
  await click('앱 설정'); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector('main')!.dataset.staffText).toBe('comfortable');
  const saved = JSON.parse(localStorage.getItem(`oda:staff-preferences:${actorId}:s1`)!);
  expect(saved).toEqual({ version: 1, text: 'comfortable', favorites: ['leave', 'payroll'] });
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.querySelector('main')!.dataset.staffText).toBe('comfortable');
  expect(container.querySelector('nav[aria-label="즐겨찾기"]')!.textContent).toContain('급여명세서');
  await render(fixture('s2')); expect(container.querySelector('main')!.dataset.staffText).toBe('standard');
  expect(container.querySelector('nav[aria-label="즐겨찾기"]')).toBeNull();
  await render(fixture()); expect(container.querySelector('main')!.dataset.staffText).toBe('comfortable');
  actorId = 'another-actor'; await render(); expect(container.querySelector('main')!.dataset.staffText).toBe('standard');
  expect(container.querySelector('nav[aria-label="즐겨찾기"]')).toBeNull();
});

it('handles unavailable device storage by retaining this-session preferences and explaining persistence', async () => {
  await render(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  await click('앱 설정'); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector('main')!.dataset.staffText).toBe('comfortable');
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain('이번 접속 동안만 적용');
  await click('앱 설정 닫기'); await click('즐겨찾기 등록'); await click('휴가 즐겨찾기'); await click('완료');
  expect(container.querySelector('nav[aria-label="즐겨찾기"]')!.textContent).toContain('휴가');
});

it('ignores malformed saved preferences and unknown favorite IDs, and accepts updates from another tab', async () => {
  const key = `oda:staff-preferences:${actorId}:s1`;
  localStorage.setItem(key, '{invalid'); await render();
  expect(container.querySelector('nav[aria-label="즐겨찾기"]')).toBeNull();
  await act(async () => {
    localStorage.setItem(key, JSON.stringify({ version: 1, text: 'comfortable', favorites: ['payroll', 'unsupported', 'payroll', 123] }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  expect(container.querySelector('main')!.dataset.staffText).toBe('comfortable');
  const favorites = container.querySelector('nav[aria-label="즐겨찾기"]')!;
  expect(favorites.querySelectorAll('button')).toHaveLength(1); expect(favorites.textContent).toContain('급여명세서');
});

it('blocks actions while the parent is saving or the store response has not loaded', async () => {
  await render(fixture(), true); await click('휴가'); await click('공지'); await click('구성원');
  expect(onOpenPersonal).not.toHaveBeenCalled(); expect(onOpenNotices).not.toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
  await render(null); await click('앱 설정'); expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('.staff-more-profile')!.textContent).toContain('직원 계정 연결 대기');
});
