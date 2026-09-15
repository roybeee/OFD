import assert from 'node:assert/strict';
import test from 'node:test';
import { createHrWorkspace, type HrContext, type HrEmployee, type HrWorkspace } from './oda-hr.ts';
import { applyHrPayrollCommand, calculateHrPayrollRow, calculateHrPayrollRun, exportHrPayrollCsv, getHrPayrollFinalizedTotal, getHrPayrollStateForContext } from './oda-hr-payroll.ts';
import type { HrLeaveRequest, HrWorkEntry } from './oda-hr-attendance.ts';

const NOW = '2026-10-05T00:00:00.000Z';
let sequence = 0;
const manager: HrContext = { actorId: 'hr', manager: true, payroll: true, today: '2026-10-05', now: NOW, id: () => `id-${++sequence}` };
function employee(id: string, overrides: Partial<HrEmployee> = {}): HrEmployee {
  const row: HrEmployee = { id, employeeNumber: id, name: `직원${id}`, departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay: 3_000_000, history: [], ...overrides };
  if (!overrides.history) row.history = [{ at: '2026-01-01T00:00:00.000Z', effectiveDate: row.hireDate, reason: '등록', changes: { basePay: row.basePay, payType: row.payType } }];
  return row;
}
function work(employeeId: string, date: string, minutes: number, status: HrWorkEntry['status'] = 'approved'): HrWorkEntry {
  return { id: `work-${++sequence}`, employeeId, date, endDate: date, startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: minutes, status, source: 'manual', policyId: '', note: '', revision: 1, createdAt: NOW, createdBy: 'hr', reviewedAt: NOW, reviewedBy: 'hr', rawClockIds: [] };
}
function leave(employeeId: string, minutes: number, paid: boolean, status: HrLeaveRequest['status'] = 'approved'): HrLeaveRequest {
  return { id: `leave-${++sequence}`, employeeId, typeId: paid ? 'paid' : 'unpaid', startDate: '2026-09-10', endDate: '2026-09-10', slots: [{ date: '2026-09-10', startTime: '09:00', endTime: '11:00', minutes }], minutes, paid, note: '', status, revision: 1, createdAt: NOW, createdBy: 'hr', reviewedAt: NOW, reviewedBy: 'hr' };
}
function workspace(employees: HrEmployee[] = [employee('a')]): HrWorkspace {
  const w = createHrWorkspace('test-store', '테스트', NOW); w.employees = employees;
  w.attendance.locks.push({ id: 'closed', startDate: '2024-01-01', endDate: '2026-09-30', employeeIds: [], status: 'locked', revision: 1, at: NOW, actorId: 'hr', reason: '마감' });
  return w;
}
function create(w: HrWorkspace, extra: Record<string, unknown> = {}) {
  applyHrPayrollCommand(w, { type: 'payroll.create', input: { month: '2026-09', payDate: '2026-10-05', ...extra } }, manager);
  return w.payroll.runs[0]!;
}
function command(w: HrWorkspace, type: string, input: Record<string, unknown> = {}, ctx = manager) {
  return applyHrPayrollCommand(w, { type: `payroll.${type}`, input: { runId: w.payroll.runs[0]!.id, ...input } }, ctx);
}
function confirm(w: HrWorkspace, employeeId = 'a', extra: Record<string, unknown> = {}) {
  command(w, 'updateRow', { employeeId, incomeTax: 0, localTax: 0, employeeInsurance: 0, employerInsurance: 0, manualConfirmed: true, ...extra });
}

test('월급은 입퇴사일을 포함해 월력으로 비례하고 귀속월 밖 구성원은 제외한다', () => {
  const w = workspace([employee('a', { hireDate: '2026-09-15' }), employee('b', { status: 'retired', endDate: '2026-09-10' }), employee('past', { status: 'retired', endDate: '2026-08-31' }), employee('future', { hireDate: '2026-10-01' })]);
  const run = create(w);
  assert.deepEqual(run.rows.map(row => [row.employeeId, row.payableDays, row.baseAmount]), [['a', 16, 1_600_000], ['b', 10, 1_000_000]]);
  assert.equal(calculateHrPayrollRun(run).net, null);
});

test('윤년 월력 29일과 명시적인 부분월 전액 정책을 각각 적용한다', () => {
  const w = workspace([employee('a', { hireDate: '2024-02-29', basePay: 2_900_000 })]);
  assert.equal(create(w, { month: '2024-02' }).rows[0]!.baseAmount, 100_000);
  const full = workspace([employee('a', { hireDate: '2026-09-15' })]);
  assert.equal(create(full, { proration: 'full' }).rows[0]!.baseAmount, 3_000_000);
});

test('시급은 승인근무와 유급휴가만 지급하며 무급휴가·미승인근무를 재공제하지 않는다', () => {
  const w = workspace([employee('a', { payType: 'hourly', basePay: 12_000 })]);
  w.attendance.workEntries.push(work('a', '2026-09-01', 480), work('a', '2026-09-02', 120, 'pending'));
  w.attendance.leaveRequests.push(leave('a', 120, true), leave('a', 240, false));
  const row = create(w).rows[0]!;
  assert.equal(row.baseAmount, 120_000); assert.equal(row.unpaidLeaveMinutes, 240); assert.equal(row.pendingCount, 1);
  assert.equal(row.adjustments.length, 0);
  assert.throws(() => command(w, 'addAdjustment', { employeeId: 'a', kind: 'deduction', category: 'unpaid_leave', label: '무급', amount: 10_000 }), /전체 기간이 월급제/);
  confirm(w); assert.throws(() => command(w, 'review'), /미처리/);
});

test('월 중 시급 변경은 날짜별 승인시간과 적용일 이력으로 재현한다', () => {
  const e = employee('a', { payType: 'hourly', basePay: 20_000, history: [
    { at: '2026-01-01', effectiveDate: '2026-01-01', reason: '등록', changes: { payType: 'hourly', basePay: 10_000 } },
    { at: '2026-09-16', effectiveDate: '2026-09-16', reason: '인상', changes: { basePay: 20_000 }, previousSnapshot: { payType: 'hourly', basePay: 10_000 } },
  ] });
  const w = workspace([e]); w.attendance.workEntries.push(work('a', '2026-09-15', 60), work('a', '2026-09-16', 120));
  const row = create(w).rows[0]!;
  assert.equal(row.baseAmount, 50_000);
  assert.deepEqual(row.segments.map(segment => [segment.startDate, segment.basePay, segment.recognizedMinutes]), [['2026-09-01', 10_000, 60], ['2026-09-16', 20_000, 120]]);
});

test('월 중 월급 변경은 각 적용기간을 비례계산하고 소수원은 구간별 반올림한다', () => {
  const e = employee('a', { basePay: 4_000_000, history: [
    { at: '2026-01-01', effectiveDate: '2026-01-01', reason: '등록', changes: { payType: 'monthly', basePay: 3_000_000 } },
    { at: NOW, effectiveDate: '2026-09-16', reason: '인상 소급', changes: { basePay: 4_000_000 } },
  ] });
  assert.equal(create(workspace([e])).rows[0]!.baseAmount, 3_500_000);
  const w = workspace([employee('h', { payType: 'hourly', basePay: 10_000 })]); w.attendance.workEntries.push(work('h', '2026-09-01', 1));
  assert.equal(create(w).rows[0]!.baseAmount, 167);
});

test('세액을 추정하지 않고 0을 포함한 명시적 입력·검토를 요구한다', () => {
  const w = workspace(); const row = create(w).rows[0]!;
  assert.equal(row.incomeTax, null); assert.equal(calculateHrPayrollRow(row).net, null);
  assert.throws(() => command(w, 'review'), /직접 입력/);
  confirm(w, 'a', { manualConfirmed: false }); assert.throws(() => command(w, 'review'), /직접 입력/);
  confirm(w); command(w, 'review'); assert.equal(w.payroll.runs[0]!.status, 'reviewed');
});

test('세액·수당·보험을 구분하고 인건비에는 근로자 공제를 이중 합산하지 않는다', () => {
  const w = workspace(); create(w);
  command(w, 'addAdjustment', { employeeId: 'a', kind: 'allowance', label: '추가수당', amount: 100_000 });
  command(w, 'addAdjustment', { employeeId: 'a', kind: 'deduction', label: '선지급 상계', amount: 50_000 });
  confirm(w, 'a', { incomeTax: 100_000, localTax: 10_000, employeeInsurance: 200_000, employerInsurance: 250_000 });
  assert.deepEqual(calculateHrPayrollRun(w.payroll.runs[0]!), { gross: 3_100_000, deductions: 360_000, net: 2_740_000, employerInsurance: 250_000, laborCost: 3_350_000 });
  assert.equal(getHrPayrollFinalizedTotal(w.payroll, '2026-09'), 0);
  command(w, 'review'); command(w, 'lock'); assert.equal(getHrPayrollFinalizedTotal(w.payroll, '2026-09'), 3_350_000);
});

test('근태 마감 변경과 급여원천 변경 뒤에는 최신정보 반영과 재확인이 필요하다', () => {
  const w = workspace(); w.attendance.locks = []; create(w); confirm(w);
  assert.throws(() => command(w, 'review'), /마감/);
  w.attendance.locks.push({ id: 'lock', startDate: '2026-09-01', endDate: '2026-09-30', employeeIds: ['a'], status: 'locked', revision: 1, at: NOW, actorId: 'hr', reason: '' });
  assert.throws(() => command(w, 'review'), /최신정보/);
  command(w, 'refresh'); assert.equal(w.payroll.runs[0]!.rows[0]!.manualConfirmed, false);
  confirm(w); command(w, 'review');
  w.employees[0]!.history.push({ at: NOW, effectiveDate: '2026-09-01', reason: '정정', changes: { basePay: 3_200_000 } });
  assert.throws(() => command(w, 'lock'), /최신정보/);
  assert.equal(w.payroll.runs[0]!.status, 'reviewed');
});

test('검토·잠금 후 편집은 차단되고 재개는 이전 확정본을 보존하고 공개를 철회한다', () => {
  const w = workspace(); const run = create(w); confirm(w); command(w, 'review');
  assert.throws(() => confirm(w), /다시 열어야/);
  command(w, 'lock'); command(w, 'publish');
  assert.equal(run.history[0]!.rows[0]!.baseAmount, 3_000_000);
  command(w, 'reopen', { reason: '누락 수당 추가' });
  assert.equal(run.status, 'draft'); assert.equal(run.publishedAt, undefined); assert.equal(run.rows[0]!.manualConfirmed, false);
  assert.equal(run.history.length, 2); assert.equal(getHrPayrollFinalizedTotal(w.payroll, '2026-09'), 0);
  command(w, 'addAdjustment', { employeeId: 'a', kind: 'allowance', label: '수당', amount: 50_000 });
  assert.equal(run.history[0]!.rows[0]!.adjustments.length, 0);
  assert.throws(() => command(w, 'delete'), /확정 이력/);
});

test('직원 조회와 CSV는 공개시각 도달 후 본인 행만 포함하고 감사본을 노출하지 않는다', () => {
  const w = workspace([employee('a', { name: '=HYPERLINK("test")' }), employee('b')]); const run = create(w); confirm(w); confirm(w, 'b'); command(w, 'review'); command(w, 'lock');
  const self = { ...manager, actorId: 'actor-a', employeeId: 'a', manager: false, payroll: false };
  assert.equal(getHrPayrollStateForContext(w.payroll, self).runs.length, 0);
  command(w, 'publish', { publishAt: '2026-10-06T00:00:00.000Z' });
  assert.equal(getHrPayrollStateForContext(w.payroll, self).runs.length, 0);
  const due = { ...self, now: '2026-10-06T00:00:00.000Z' }; const visible = getHrPayrollStateForContext(w.payroll, due).runs[0]!;
  assert.deepEqual(visible.rows.map(row => row.employeeId), ['a']); assert.equal(visible.history.length, 0); assert.equal(visible.rows[0]!.sourceKey, '');
  const csv = exportHrPayrollCsv(run, due); assert.match(csv, /'=HYPERLINK/); assert.doesNotMatch(csv, /직원b/);
  assert.equal(getHrPayrollStateForContext(w.payroll, { ...due, employeeId: 'unknown', manager: true }).runs.length, 0);
  assert.throws(() => exportHrPayrollCsv(run, self), /본인 급여/);
});

test('급여 권한·정수금액·동시수정·중복월·초과공제를 서버 도메인에서 차단한다', () => {
  const w = workspace();
  assert.throws(() => applyHrPayrollCommand(w, { type: 'payroll.create', input: { month: '2026-09', payDate: '2026-10-05' } }, { ...manager, payroll: false }), /권한/);
  const run = create(w); assert.throws(() => create(w), /이미/);
  const before = structuredClone(w.payroll);
  assert.throws(() => confirm(w, 'a', { incomeTax: 0.1 }), /정수/); assert.deepEqual(w.payroll, before);
  assert.throws(() => command(w, 'addAdjustment', { revision: 999, employeeId: 'a', kind: 'allowance', label: '상여', amount: 100 }), /다른 변경/);
  assert.deepEqual(w.payroll, before);
  confirm(w, 'a', { incomeTax: 3_000_001 }); assert.throws(() => command(w, 'review'), /초과/);
  assert.equal(run.status, 'draft');
});

test('휴직 지급판단은 검토 메모를 요구하고 여러 행 새로고침 실패는 원본을 보존한다', () => {
  const w = workspace([employee('a', { status: 'leave' }), employee('b')]); create(w); confirm(w); confirm(w, 'b');
  assert.throws(() => command(w, 'review'), /휴직/);
  confirm(w, 'a', { note: '해당월 전액 지급 확인' });
  w.employees[0]!.history.push({ at: NOW, effectiveDate: '2026-09-01', reason: '변경', changes: { basePay: 100_000 } });
  w.employees[1]!.endDate = '2026-08-31'; const before = structuredClone(w.payroll);
  assert.throws(() => command(w, 'refresh'), /재직한 기간/); assert.deepEqual(w.payroll, before);
});
