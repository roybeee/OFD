import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace, type HrContext } from '../../../../packages/domain/src/oda-hr';
import { applyHrPayrollCommand } from '../../../../packages/domain/src/oda-hr-payroll';
import { applyOdaHrPayrollCost, getOdaHrPayrollCost, type HrPayrollCostPreview } from '../api/oda-hr-client';
import { HrPayroll } from './HrPayroll';
import type { HrPanelProps } from './shared';

vi.mock('../api/oda-hr-client', () => ({ applyOdaHrPayrollCost: vi.fn(), getOdaHrPayrollCost: vi.fn() }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
async function click(name: string) { expect(button(name)).toBeTruthy(); await act(async () => button(name)!.click()); }
function fixture(): HrPanelProps {
  const workspace = createHrWorkspace('store', '테스트 매장', '2026-01-01T00:00:00.000Z'); let seq = 0;
  workspace.employees = ['본인', '다른직원'].map((name, index) => ({ id: `e${index}`, employeeNumber: `E${index}`, name, departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2025-01-01', payType: 'monthly', basePay: 3_000_000, history: [] }));
  workspace.attendance.locks.push({ id: 'lock', startDate: '2025-12-01', endDate: '2025-12-31', employeeIds: [], status: 'locked', revision: 1, at: '', actorId: 'hr', reason: '' });
  const ctx: HrContext = { actorId: 'hr', manager: true, payroll: true, today: '2026-01-01', now: '2026-01-01T00:00:00.000Z', id: () => `${++seq}` };
  applyHrPayrollCommand(workspace, { type: 'payroll.create', input: { month: '2025-12', payDate: '2026-01-05' } }, ctx);
  const run = workspace.payroll.runs[0]!;
  for (const row of run.rows) applyHrPayrollCommand(workspace, { type: 'payroll.updateRow', input: { runId: run.id, employeeId: row.employeeId, incomeTax: 0, localTax: 0, employeeInsurance: 0, employerInsurance: 0, manualConfirmed: true } }, ctx);
  for (const action of ['review', 'lock']) applyHrPayrollCommand(workspace, { type: `payroll.${action}`, input: { runId: run.id } }, ctx);
  return { workspace, actorId: 'hr', employeeId: 'e0', permissions: { manage: true, payroll: true, self: true }, busy: false, mutate: vi.fn(async () => {}), onReload: vi.fn(async () => {}) };
}
const preview: HrPayrollCostPreview = { storeId: 'store', month: '2025-12', hrVersion: 12, odaVersion: 4, payrollRunId: '1', payrollRunRevision: 8, payrollStatus: 'locked', odaStatus: 'draft', gross: 6_000_000, employerInsurance: 200_000, total: 6_200_000, currentAmount: 6_100_000, otherLaborAmount: 0, otherLaborCount: 0, alreadyApplied: false, canApply: true, blockers: [] };

it('loads an aggregate preview without writing, then sends exactly its reviewed versions on explicit apply', async () => {
  const props = fixture(); vi.mocked(getOdaHrPayrollCost).mockResolvedValue(preview);
  vi.mocked(applyOdaHrPayrollCost).mockResolvedValue({ ...preview, hrVersion: 13, odaVersion: 5, currentAmount: 6_200_000, alreadyApplied: true, canApply: false });
  await act(async () => root.render(<HrPayroll {...props} />));
  expect(getOdaHrPayrollCost).not.toHaveBeenCalled(); expect(applyOdaHrPayrollCost).not.toHaveBeenCalled();
  await click('월 정산 인건비 미리보기');
  expect(getOdaHrPayrollCost).toHaveBeenCalledWith('store', '2025-12'); expect(applyOdaHrPayrollCost).not.toHaveBeenCalled();
  const dialog = container.querySelector('[role="dialog"]')!; expect(dialog.textContent).toContain('6,200,000원'); expect(dialog.textContent).toContain('6,100,000원'); expect(dialog.textContent).not.toContain('다른직원');
  await click('월정산 인건비에 반영'); expect(applyOdaHrPayrollCost).toHaveBeenCalledExactlyOnceWith('store', preview); expect(props.onReload).toHaveBeenCalledOnce();
  expect(button('월정산 인건비에 반영')!.disabled).toBe(true);
});

it('does not write a blocked or stale preview and requires the user to refresh it', async () => {
  const props = fixture(); vi.mocked(getOdaHrPayrollCost).mockResolvedValue({ ...preview, canApply: false, blockers: ['확정된 월 정산입니다.'] });
  await act(async () => root.render(<HrPayroll {...props} />)); await click('월 정산 인건비 미리보기');
  expect(button('월정산 인건비에 반영')!.disabled).toBe(true); await click('월정산 인건비에 반영'); expect(applyOdaHrPayrollCost).not.toHaveBeenCalled();
  await click('닫기'); vi.mocked(getOdaHrPayrollCost).mockResolvedValue(preview); vi.mocked(applyOdaHrPayrollCost).mockRejectedValue(new Error('최신 미리보기를 확인해 주세요.'));
  await click('월 정산 인건비 미리보기'); await click('월정산 인건비에 반영'); expect(button('월정산 인건비에 반영')).toBeUndefined(); expect(button('미리보기 다시 확인')).toBeTruthy(); expect(applyOdaHrPayrollCost).toHaveBeenCalledOnce();
});

it('removing an employee from a filled form never also submits the manual payroll fields', async () => {
  const props = fixture(); const run = props.workspace.payroll.runs[0]!; run.status = 'draft';
  await act(async () => root.render(<HrPayroll {...props} />)); await click('입력·검토'); await click('이 정산에서 제외');
  expect(props.mutate).toHaveBeenCalledExactlyOnceWith('payroll.removeEmployee', { runId: run.id, revision: run.revision, employeeId: 'e0' });
});

it('staff sees only their published statement and no cost transfer controls', async () => {
  const props = fixture(); props.permissions = { manage: false, payroll: false, self: true };
  const run = props.workspace.payroll.runs[0]!; run.status = 'published'; run.publishedAt = '2026-01-01T00:00:00.000Z';
  await act(async () => root.render(<HrPayroll {...props} />)); expect(container.textContent).toContain('본인'); expect(container.textContent).not.toContain('다른직원');
  expect(button('월 정산 인건비 미리보기')).toBeUndefined(); expect(button('급여 초안 만들기')).toBeUndefined();
});


it('renders employee cards only for their currently published statements with stored totals and payment dates', async () => {
  const props = fixture(); props.permissions = { manage: false, payroll: false, self: true };
  const run = props.workspace.payroll.runs[0]!; run.status = 'published'; run.publishedAt = '2026-01-01T00:00:00.000Z';
  const row = run.rows.find(item => item.employeeId === 'e0')!;
  row.adjustments = [{ id: 'allowance', kind: 'allowance', category: 'manual', label: '확정 수당', amount: 250000 }, { id: 'deduction', kind: 'deduction', category: 'manual', label: '확정 공제', amount: 50000 }];
  row.incomeTax = 100000; row.localTax = 10000; row.employeeInsurance = 150000;
  props.workspace.payroll.runs.push(
    { ...structuredClone(run), id: 'draft', title: '비공개 초안', status: 'draft' },
    { ...structuredClone(run), id: 'locked', title: '미공개 확정', status: 'locked' },
    { ...structuredClone(run), id: 'future', title: '공개 예약 명세', publishedAt: '2099-01-01T00:00:00.000Z' },
    { ...structuredClone(run), id: 'other-only', title: '타인 전용 명세', rows: run.rows.filter(item => item.employeeId !== 'e0') },
  );
  await act(async () => root.render(<HrPayroll {...props} />));
  expect(container.querySelectorAll('.staff-payroll-card')).toHaveLength(1);
  expect(container.querySelector('table')).toBeNull();
  const card = container.querySelector('.staff-payroll-card')!;
  expect(card.textContent).toContain('3,250,000원'); expect(card.textContent).toContain('310,000원'); expect(card.textContent).toContain('2,940,000원');
  expect(card.textContent).toContain('2025-12-01 ~ 2025-12-31'); expect(card.textContent).toContain('지급일 2026-01-05');
  for (const privateText of ['비공개 초안','미공개 확정','공개 예약 명세','타인 전용 명세','다른직원']) expect(container.textContent).not.toContain(privateText);
  await click('상세 보기');
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('2025-12 급여명세서');
  expect(dialog.textContent).toContain('확정 수당'); expect(dialog.textContent).toContain('확정 공제'); expect(dialog.textContent).toContain('2,940,000원');
  expect(dialog.querySelector('input')).toBeNull(); expect(props.mutate).not.toHaveBeenCalled();
});

it('opens the clicked older month rather than the newest statement and closes if that publication is withdrawn', async () => {
  const props = fixture(); props.permissions = { manage: false, payroll: false, self: true };
  const old = props.workspace.payroll.runs[0]!; old.status = 'published'; old.publishedAt = '2026-01-01T00:00:00.000Z';
  props.workspace.payroll.runs.push({ ...structuredClone(old), id: 'newer', month: '2026-01', title: '1월 명세', payDate: '2026-02-05' });
  await act(async () => root.render(<HrPayroll {...props} />));
  const cards = container.querySelectorAll('.staff-payroll-card'); expect(cards).toHaveLength(2);
  expect(cards[0]!.textContent).toContain('2026년 1월');
  await act(async () => cards[1]!.querySelector('button')!.click());
  expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('2025-12 급여명세서');
  old.status = 'draft';
  await act(async () => root.render(<HrPayroll {...props} />));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelectorAll('.staff-payroll-card')).toHaveLength(1);
});

it('downloads the selected employee statement with the existing CSV exporter and no other employee data', async () => {
  const props = fixture(); props.permissions = { manage: false, payroll: false, self: true };
  const run = props.workspace.payroll.runs[0]!; run.status = 'published'; run.publishedAt = '2026-01-01T00:00:00.000Z';
  let exported: Blob | undefined;
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL(blob: Blob) { exported = blob; return 'blob:statement'; }
    static revokeObjectURL() {}
  });
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => root.render(<HrPayroll {...props} />)); await click('CSV 내려받기');
  expect(anchor).toHaveBeenCalledOnce(); expect(exported).toBeTruthy();
  const csv = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(exported!); });
  expect(csv).toContain('본인'); expect(csv).not.toContain('다른직원'); expect(csv).toContain('3000000');
  expect(props.mutate).not.toHaveBeenCalled();
});
