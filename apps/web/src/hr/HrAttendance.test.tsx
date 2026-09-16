import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { HrAttendance } from './HrAttendance';
import { hrToday } from './shared';
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
  expect(button('근무 기록 저장')).toBeUndefined();
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('관리자 승인 후 반영됩니다');
  expect(host.textContent).toContain('직원 홈에서 위치를 확인');
  await act(async () => button('근무 정정 신청').click());
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('근무 등록·정정 신청');
  expect(button('근무 기록 저장')).toBeTruthy();
  expect(host.querySelectorAll('form')).toHaveLength(1);
  expect(location.read).not.toHaveBeenCalled();
});


it('opens a leave form directly and consumes the intent after a successful save', async () => {
  const workspace = fixture(); const mutate = vi.fn(async () => {});
  workspace.attendance.leaveTypes = [{ id: 'annual', name: '연차', paid: true, deductBalance: false, unitMinutes: 30, requireApproval: true }];
  const props = { workspace, actorId: 'staff', permissions: { manage: false, payroll: false, self: true }, employeeId: 'e1', mutate, busy: false };
  const intent = { nonce: 1, action: 'create' as const };
  await act(async () => root.render(<HrAttendance {...props} tab="leave" entryIntent={intent} />));
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('휴가 신청');
  expect(mutate).not.toHaveBeenCalled();
  await act(async () => host.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenCalledExactlyOnceWith('leave.request', expect.objectContaining({ employeeId: 'e1', typeId: 'annual' }));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.render(<HrAttendance {...props} workspace={{ ...workspace, version: 1 }} tab="leave" entryIntent={{ ...intent }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('opens the requested historical record and guards a coworkers private record', async () => {
  const workspace = fixture(); const mutate = vi.fn();
  const base = { employeeId: 'e1', date: '2026-01-08', endDate: '2026-01-08', startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480, status: 'pending' as const, source: 'manual' as const, policyId: '', revision: 2, createdAt: '2026-01-08T00:00:00Z', createdBy: 'staff', reviewedAt: '', reviewedBy: '', rawClockIds: [] };
  workspace.attendance.workEntries = [{ ...base, id: 'mine', note: '내 정정 사유' }, { ...base, id: 'private', employeeId: 'e2', note: '타인 비공개 사유' }];
  const props = { workspace, actorId: 'staff', permissions: { manage: false, payroll: false, self: true }, employeeId: 'e1', mutate, busy: false };
  await act(async () => root.render(<HrAttendance {...props} tab="attendance" entryIntent={{ nonce: 1, recordId: 'mine' }} hideClock />));
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('내 정정 사유');
  expect(host.querySelector<HTMLInputElement>('input[type="month"]')?.value).toBe('2026-01');
  await act(async () => root.render(<HrAttendance {...props} tab="attendance" entryIntent={{ nonce: 2, recordId: 'private' }} hideClock />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain('조회 권한이 없습니다');
  expect(host.textContent).not.toContain('타인 비공개 사유');
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps a failed direct leave submission open with entered values and error inside the dialog', async () => {
  const workspace = fixture();
  workspace.attendance.leaveTypes = [{ id: 'annual', name: '연차', paid: true, deductBalance: false, unitMinutes: 30, requireApproval: true }];
  const mutate = vi.fn(async () => { throw new Error('잔액을 확인해 주세요.'); });
  await act(async () => root.render(<HrAttendance workspace={workspace} actorId="staff" permissions={{ manage: false, payroll: false, self: true }} employeeId="e1" mutate={mutate} busy={false} tab="leave" entryIntent={{ nonce: 1, action: 'create' }} />));
  const dialog = host.querySelector('[role="dialog"]')!;
  (dialog.querySelector('[name="note"]') as HTMLTextAreaElement).value = '가족 일정';
  await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('잔액을 확인');
  expect((host.querySelector('[role="dialog"] [name="note"]') as HTMLTextAreaElement).value).toBe('가족 일정');
});


it('preserves the revision opened for editing so a background refresh cannot overwrite a newer work record', async () => {
  const workspace = fixture(); const mutate = vi.fn(async () => {});
  const record = { id: 'mine', employeeId: 'e1', date: '2026-01-08', endDate: '2026-01-08', startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480, status: 'pending' as const, source: 'manual' as const, policyId: '', note: '기존 사유', revision: 2, createdAt: '2026-01-08T00:00:00Z', createdBy: 'staff', reviewedAt: '', reviewedBy: '', rawClockIds: [] };
  workspace.attendance.workEntries = [record];
  const props = { workspace, actorId: 'staff', permissions: { manage: false, payroll: false, self: true }, employeeId: 'e1', mutate, busy: false };
  const entryIntent = { nonce: 1, recordId: 'mine' };
  await act(async () => root.render(<HrAttendance {...props} tab="attendance" entryIntent={entryIntent} hideClock />));
  await act(async () => button('근무 기록 수정').click());
  const fresh = { ...workspace, version: 1, attendance: { ...workspace.attendance, workEntries: [{ ...record, revision: 3, note: '다른 곳에서 수정' }] } };
  await act(async () => root.render(<HrAttendance {...props} workspace={fresh} tab="attendance" entryIntent={entryIntent} hideClock />));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect((dialog.querySelector('[name="note"]') as HTMLInputElement).value).toBe('기존 사유');
  await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenCalledExactlyOnceWith('work.update', expect.objectContaining({ id: 'mine', expectedRevision: 2, note: '기존 사유' }));
});

it('uses staff work cards to open the exact record without exposing coworker notes or an inline table', async () => {
  const workspace = fixture(); const mutate = vi.fn(async () => {}); const date = hrToday();
  const record = { id: 'mine', employeeId: 'e1', date, endDate: date, startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480, status: 'pending' as const, source: 'manual' as const, policyId: '', note: '내 상세 사유', revision: 4, createdAt: workspace.updatedAt, createdBy: 'staff', reviewedAt: '', reviewedBy: '', rawClockIds: [] };
  workspace.attendance.workEntries = [record, { ...record, id: 'other', employeeId: 'e2', note: '타인 사유 비공개' }];
  await act(async () => root.render(<HrAttendance workspace={workspace} actorId="staff" permissions={{ manage: false, payroll: false, self: true }} employeeId="e1" mutate={mutate} busy={false} tab="attendance" hideClock />));
  expect(host.querySelector('table')).toBeNull(); expect(host.querySelector('form')).toBeNull();
  const cards = host.querySelectorAll<HTMLButtonElement>('.staff-record-card');
  expect(cards).toHaveLength(1); expect(cards[0]!.textContent).toContain('인정 8시간');
  expect(host.textContent).not.toContain('타인 사유'); expect(host.textContent).not.toContain('내 상세 사유');
  await act(async () => cards[0]!.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('내 상세 사유');
  await act(async () => button('신청 취소').click());
  expect(mutate).toHaveBeenCalledExactlyOnceWith('work.cancel', { id: 'mine', expectedRevision: 4 });
});

it('shows staff leave balances, request cards and ledger without wide tables, and creates through one sheet', async () => {
  const workspace = fixture(); const mutate = vi.fn(async () => {}); const date = hrToday();
  workspace.attendance.leaveLedger = [{ id: 'grant', employeeId: 'e1', typeId: 'annual', lotId: 'grant', requestId: '', kind: 'grant', minutes: 960, effectiveFrom: date, expiresOn: `${date.slice(0, 4)}-12-31`, sourceEntryId: '', note: '연차 지급', at: workspace.updatedAt, actorId: 'owner' }];
  workspace.attendance.leaveRequests = [{ id: 'leave-mine', employeeId: 'e1', typeId: 'annual', startDate: date, endDate: date, slots: [{ date, startTime: '09:00', endTime: '18:00', minutes: 480 }], minutes: 480, paid: true, note: '개인 사유 상세', status: 'pending', revision: 3, createdAt: workspace.updatedAt, createdBy: 'staff', reviewedAt: '', reviewedBy: '' }];
  await act(async () => root.render(<HrAttendance workspace={workspace} actorId="staff" permissions={{ manage: false, payroll: false, self: true }} employeeId="e1" mutate={mutate} busy={false} tab="leave" />));
  expect(host.querySelector('table')).toBeNull(); expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('.staff-leave-balance')?.textContent).toContain('16시간');
  expect(host.querySelector('.staff-leave-ledger')?.textContent).toContain('+960분');
  const card = host.querySelector<HTMLButtonElement>('.staff-record-card')!;
  expect(card.textContent).toContain('승인 대기'); expect(card.textContent).toContain('8시간');
  await act(async () => card.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('개인 사유 상세');
  await act(async () => button('신청 취소').click());
  expect(mutate).toHaveBeenCalledExactlyOnceWith('leave.cancel', { id: 'leave-mine', expectedRevision: 3 });
  await act(async () => button('닫기').click());
  await act(async () => button('휴가 신청').click());
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('휴가 신청');
  expect(host.querySelectorAll('form')).toHaveLength(1);
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenLastCalledWith('leave.request', expect.objectContaining({ employeeId: 'e1', typeId: 'annual', startDate: date }));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps locked staff records readable but removes mutation actions and preserves manager tables', async () => {
  const workspace = fixture(); const mutate = vi.fn(); const date = hrToday();
  workspace.attendance.workEntries = [{ id: 'locked', employeeId: 'e1', date, endDate: date, startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480, status: 'approved', source: 'clock', policyId: '', note: '마감 기록', revision: 1, createdAt: workspace.updatedAt, createdBy: 'staff', reviewedAt: '', reviewedBy: '', rawClockIds: [] }];
  workspace.attendance.locks = [{ id: 'lock', employeeIds: ['e1'], startDate: date, endDate: date, status: 'locked', revision: 1, at: workspace.updatedAt, actorId: 'owner', reason: '월 마감' }];
  const props = { workspace, employeeId: 'e1', mutate, busy: false };
  await act(async () => root.render(<HrAttendance {...props} actorId="staff" permissions={{ manage: false, payroll: false, self: true }} tab="attendance" hideClock />));
  await act(async () => host.querySelector<HTMLButtonElement>('.staff-record-card')!.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('마감 기록');
  expect(button('신청 취소')).toBeUndefined(); expect(button('근무 기록 수정')).toBeUndefined();
  expect(mutate).not.toHaveBeenCalled();
  await act(async () => root.render(<HrAttendance {...props} actorId="owner" permissions={{ manage: true, payroll: true, self: true }} tab="attendance" />));
  expect(host.querySelector('.hr-table')).toBeTruthy();
  expect(host.querySelector('.staff-record-list')).toBeNull();
  expect(button('근무 기록 저장')).toBeTruthy();
});
