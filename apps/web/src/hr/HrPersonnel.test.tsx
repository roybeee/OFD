import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace, type HrEmployee } from '../../../../packages/domain/src/oda-hr';
import { HrPersonnel } from './HrPersonnel';
import { hrToday } from './shared';

let root: Root; let container: HTMLDivElement;
const employee: HrEmployee = { id: 'e1', employeeNumber: '001', name: '직원', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay: 0, history: [] };
const fixture = () => { const w = createHrWorkspace('s1', '실제 매장', '2026-09-15T00:00:00Z'); w.employees.push({ ...employee }); return w; };
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(label: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll('button')].find(row => row.textContent?.trim() === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
async function field(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('publishes a notice only after explicitly saving its title, body and visibility', async () => {
  const mutate = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<HrPersonnel workspace={fixture()} permissions={{ manage: true, payroll: true, self: false }} actorId="manager" busy={false} mutate={mutate} tab="overview" onTabChange={vi.fn()} />));
  await click('공지 작성'); expect(mutate).not.toHaveBeenCalled();
  await field('title', '다음 주 안내'); await field('body', '실제 공지 본문'); await field('status', 'published');
  await act(async () => container.querySelector<HTMLInputElement>('[name="pinned"]')!.click()); await submit();
  expect(mutate).toHaveBeenCalledWith('notice.create', { title: '다음 주 안내', body: '실제 공지 본문', status: 'published', pinned: true });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('requires a recipient for personal documents and saves the selected recipient', async () => {
  const mutate = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<HrPersonnel workspace={fixture()} permissions={{ manage: true, payroll: true, self: false }} actorId="manager" busy={false} mutate={mutate} tab="documents" onTabChange={vi.fn()} />));
  await click('문서 작성');
  expect(container.querySelector<HTMLSelectElement>('[name="employeeId"]')!.required).toBe(true);
  await field('category', 'policy'); expect(container.querySelector<HTMLSelectElement>('[name="employeeId"]')!.required).toBe(false);
  await field('category', 'certificate'); await field('title', '재직증명서'); await field('body', '검토한 문서 내용'); await field('employeeId', 'e1'); await submit();
  expect(mutate).toHaveBeenCalledWith('document.create', { title: '재직증명서', category: 'certificate', employeeId: 'e1', body: '검토한 문서 내용' });
});

it('does not submit hidden pay placeholders when a personnel manager edits a directory record', async () => {
  const mutate = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<HrPersonnel workspace={fixture()} permissions={{ manage: true, payroll: false, self: false }} actorId="manager" busy={false} mutate={mutate} tab="people" onTabChange={vi.fn()} />));
  await click('상세 보기'); await click('정보 수정');
  expect(container.querySelector('[name="basePay"]')).toBeNull();
  await field('name', '변경 이름'); await field('reason', '직원 이름 수정'); await submit();
  expect(mutate).toHaveBeenCalledWith('employee.update', expect.objectContaining({ id: 'e1', reason: '직원 이름 수정', changes: expect.objectContaining({ name: '변경 이름' }) }));
  expect(mutate.mock.calls[0][1].changes).not.toHaveProperty('basePay');
  expect(mutate.mock.calls[0][1].changes).not.toHaveProperty('payType');
});

it('saves explicit personnel defaults without implying the informational contact sets approval rights', async () => {
  const mutate = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<HrPersonnel workspace={fixture()} permissions={{ manage: true, payroll: true, self: false }} actorId="manager" busy={false} mutate={mutate} tab="settings" onTabChange={vi.fn()} />));
  expect(container.textContent).toContain('승인 권한이나 결재선에 자동 적용되지 않습니다');
  await field('workdayHours', '7.5'); await field('annualLeaveDays', '17'); await field('approvalEmployeeId', 'e1'); await submit();
  expect(mutate).toHaveBeenCalledWith('settings.update', { companyName: '실제 매장', workdayHours: 7.5, weeklyDays: 5, annualLeaveDays: 17, approvalEmployeeId: 'e1', timezone: 'Asia/Seoul', reason: '' });
});

it('shows saved staff setup gaps without treating inactive account links, drafts or future hires as ready', async () => {
  const w = fixture(); const today = hrToday(); const month = today.slice(0, 7);
  w.employees = [
    { ...employee, id: 'linked', name: '연결 직원', actorId: 'valid', hireDate: today },
    { ...employee, id: 'stale', name: '확인 직원', actorId: 'disabled', hireDate: today },
    { ...employee, id: 'future', name: '입사 예정', hireDate: '9999-01-01' },
    { ...employee, id: 'retired', status: 'retired', name: '퇴직 직원' },
  ];
  const shift = { templateId: '', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work' as const, revision: 1, publishedAt: '', note: '' };
  w.attendance.shifts = [
    { ...shift, id: 'posted', employeeId: 'linked', date: today, status: 'published' },
    { ...shift, id: 'draft', employeeId: 'stale', date: today, status: 'draft' },
    { ...shift, id: 'old', employeeId: 'stale', date: '2000-01-01', status: 'published' },
  ];
  w.notices = [{ id: 'draft', title: '초안', body: '', pinned: false, status: 'draft', createdBy: 'manager', createdAt: today, updatedAt: today }];
  const mutate = vi.fn(); const onTabChange = vi.fn();
  await act(async () => root.render(<HrPersonnel workspace={w} accounts={[{ id: 'valid', name: '계정', role: 'store_staff' }]} permissions={{ manage: true, payroll: true, self: false }} actorId="manager" busy={false} mutate={mutate} tab="overview" onTabChange={onTabChange} />));
  const setup = container.querySelector('[aria-label="직원 화면 준비 현황"]')!;
  expect(setup.textContent).toContain('설정 필요');
  expect(setup.textContent).toContain('1/2명 연결');
  expect(setup.textContent).toContain('연결 확인 필요: 확인 직원');
  expect(setup.textContent).toContain(`${Number(month.slice(5))}월 근무표`);
  expect(setup.textContent).toContain('1/2명 게시');
  expect(setup.textContent).toContain('0건 게시');
  await click('출퇴근 위치 설정', setup); expect(onTabChange).toHaveBeenLastCalledWith('settings');
  await click('직원 계정 연결 확인', setup); expect(onTabChange).toHaveBeenLastCalledWith('people');
  await click('당월 근무표 관리', setup); expect(onTabChange).toHaveBeenLastCalledWith('shifts');
  const scroll = vi.fn(); container.querySelector('#hr-store-notices')!.scrollIntoView = scroll;
  await click('매장 공지 보기', setup); expect(scroll).toHaveBeenCalledOnce();
  expect(mutate).not.toHaveBeenCalled();
});

it('never calls an empty employee list complete and hides manager readiness from employees', async () => {
  const w = fixture(); w.employees = [];
  const common = { workspace: w, actorId: 'manager', busy: false, mutate: vi.fn(), onTabChange: vi.fn(), tab: 'overview' as const };
  await act(async () => root.render(<HrPersonnel {...common} permissions={{ manage: true, payroll: true, self: false }} />));
  expect(container.querySelector('[aria-label="직원 화면 준비 현황"] .hr-setup-ready')).toBeNull();
  await act(async () => root.render(<HrPersonnel {...common} permissions={{ manage: false, payroll: false, self: false }} />));
  expect(container.querySelector('[aria-label="직원 화면 준비 현황"]')).toBeNull();
});
