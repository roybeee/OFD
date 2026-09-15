import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace, type HrEmployee } from '../../../../packages/domain/src/oda-hr';
import { HrPersonnel } from './HrPersonnel';

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
