import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { HrAttendance } from './HrAttendance';
const location = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lib/hr-location', () => ({ getCurrentHrPosition: location.read }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => { location.read.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function fixture() {
  const workspace = createHrWorkspace('s1', '테스트 매장', new Date().toISOString());
  workspace.employees.push({ id: 'e1', employeeNumber: 'E1', name: '재무 겸직 직원', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay: 0, history: [] });
  workspace.settings.clockLocation = { address: '테스트 매장 주소', latitude: 37.5, longitude: 127, radiusMeters: 200, updatedAt: new Date().toISOString(), updatedBy: 'manager' };
  return workspace;
}
function button(label: string) { return [...host.querySelectorAll('button')].find(row => row.textContent === label)!; }

it('preserves linked finance clock actions with a fresh position and prevents duplicate clicks during acquisition', async () => {
  const workspace = fixture(); const mutate = vi.fn(async () => {});
  let deliver!: (value: unknown) => void;
  location.read.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  await act(async () => root.render(<HrAttendance workspace={workspace} permissions={{ manage: false, payroll: true, self: true }} employeeId="e1" mutate={mutate} busy={false} tab="attendance" />));
  await act(async () => { button('출근').click(); button('출근').click(); });
  expect(location.read).toHaveBeenCalledTimes(1); expect(mutate).not.toHaveBeenCalled();
  const position = { latitude: 37.5, longitude: 127, accuracy: 8, timestamp: Date.now() };
  await act(async () => deliver(position));
  expect(mutate).toHaveBeenCalledExactlyOnceWith('clock.in', { employeeId: 'e1', location: position });
  workspace.attendance.clockEvents.push({ id: 'c1', kind: 'in', employeeId: 'e1', at: new Date().toISOString(), actorId: 'finance', workEntryId: '' });
  await act(async () => root.render(<HrAttendance workspace={workspace} permissions={{ manage: false, payroll: true, self: true }} employeeId="e1" mutate={mutate} busy={false} tab="attendance" />));
  location.read.mockRejectedValueOnce(new Error('위치 권한을 허용해 주세요.'));
  await act(async () => button('퇴근').click());
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('위치 권한을 허용해 주세요.');
  expect(button('퇴근').disabled).toBe(false);
});

it('keeps staff personal history and correction requests while routing clock registration to the employee home', async () => {
  await act(async () => root.render(<HrAttendance workspace={fixture()} permissions={{ manage: false, payroll: false, self: true }} employeeId="e1" mutate={vi.fn()} busy={false} tab="attendance" hideClock />));
  expect(button('출근')).toBeUndefined(); expect(button('퇴근')).toBeUndefined();
  expect(button('근무 기록 저장')).toBeTruthy();
  expect(host.textContent).toContain('관리자 승인 후 반영됩니다');
  expect(host.textContent).toContain('직원 홈에서 위치를 확인');
  expect(location.read).not.toHaveBeenCalled();
});
