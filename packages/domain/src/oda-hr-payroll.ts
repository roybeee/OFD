import type { HrCommand, HrContext, HrEmployee, HrWorkspace } from './oda-hr.ts';
import { getHrAttendanceTotals } from './oda-hr-attendance.ts';
import { hrDate, hrEmployee, hrEnum, hrFail, hrNumber, hrStringArray, hrText } from './oda-hr-utils.ts';

/** KRW integers. Tax and insurance are externally determined, explicitly confirmed inputs. */
export interface HrPayrollAdjustment {
  id: string;
  kind: 'allowance' | 'deduction';
  category: 'manual' | 'unpaid_leave';
  label: string;
  amount: number;
}
export interface HrPayrollSegment {
  startDate: string; endDate: string; payType: 'monthly' | 'hourly'; basePay: number;
  payableDays: number; recognizedMinutes: number; paidLeaveMinutes: number; baseAmount: number;
}
export interface HrPayrollRow {
  employeeId: string;
  employeeNumber: string;
  name: string;
  payType: 'monthly' | 'hourly';
  basePay: number;
  employmentStatus: HrEmployee['status'];
  periodStart: string;
  periodEnd: string;
  calendarDays: number;
  payableDays: number;
  recognizedMinutes: number;
  paidLeaveMinutes: number;
  unpaidLeaveMinutes: number;
  pendingCount: number;
  attendanceLocked: boolean;
  sourceKey: string;
  baseAmount: number;
  segments: HrPayrollSegment[];
  adjustments: HrPayrollAdjustment[];
  incomeTax: number | null;
  localTax: number | null;
  employeeInsurance: number | null;
  employerInsurance: number | null;
  manualConfirmed: boolean;
  note: string;
}
export interface HrPayrollTotals {
  gross: number;
  deductions: number;
  net: number | null;
  employerInsurance: number;
  laborCost: number;
}
export interface HrPayrollSnapshot {
  revision: number;
  status: HrPayrollRun['status'];
  rows: HrPayrollRow[];
  totals: HrPayrollTotals;
  at: string;
  actorId: string;
  reason: string;
}
export interface HrPayrollRun {
  id: string;
  month: string;
  payDate: string;
  title: string;
  proration: 'calendar' | 'full';
  status: 'draft' | 'reviewed' | 'locked' | 'published';
  rows: HrPayrollRow[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  lockedAt?: string;
  lockedBy?: string;
  publishedAt?: string;
  publishedBy?: string;
  history: HrPayrollSnapshot[];
}
export interface HrPayrollState { runs: HrPayrollRun[] }
export function createHrPayrollState(): HrPayrollState { return { runs: [] }; }

const MAX_MONEY = 1_000_000_000;
const MANUAL_FIELDS = ['incomeTax', 'localTax', 'employeeInsurance', 'employerInsurance'] as const;
const DAY = 86_400_000;
function money(value: number): number {
  if (!Number.isSafeInteger(value)) hrFail('금액이 안전한 정수 범위를 벗어났습니다.');
  return value;
}
function payrollPermission(ctx: HrContext): void {
  if (!ctx.payroll) hrFail('급여 관리 권한이 필요합니다.', 'HR_FORBIDDEN', 403);
}
function monthPeriod(month: string): { start: string; end: string; days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) hrFail('귀속월을 YYYY-MM 형식으로 입력해 주세요.');
  const [year, part] = month.split('-').map(Number);
  if (!year || year < 1900 || year > 2200 || !part) hrFail('지원하는 귀속월은 1900~2200년입니다.');
  const days = new Date(Date.UTC(year, part, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${days}`, days };
}
function employmentPeriod(employee: HrEmployee, month: string): { start: string; end: string; days: number; calendarDays: number } | null {
  const period = monthPeriod(month);
  hrDate({ date: employee.hireDate }, 'date');
  if (employee.endDate) hrDate({ date: employee.endDate }, 'date');
  if (employee.status === 'retired' && !employee.endDate) hrFail(`${employee.name}: 퇴직일을 먼저 입력해 주세요.`);
  const start = employee.hireDate > period.start ? employee.hireDate : period.start;
  const end = employee.endDate && employee.endDate < period.end ? employee.endDate : period.end;
  if (start > end) return null;
  return { start, end, days: Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1, calendarDays: period.days };
}
function payOnDate(employee: HrEmployee, date: string): { basePay: number; payType: 'monthly' | 'hourly' } {
  // The earliest pre-change snapshot also supports records created before full creation snapshots existed.
  const initial = employee.history[0];
  const seed = initial?.previousSnapshot ?? initial?.changes ?? {};
  let basePay = typeof seed.basePay === 'number' ? seed.basePay : employee.basePay;
  let payType = seed.payType === 'monthly' || seed.payType === 'hourly' ? seed.payType : employee.payType;
  const changes = employee.history.map((entry, index) => ({ ...entry, index }))
    .filter(entry => entry.effectiveDate <= date)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.index - b.index);
  for (const entry of changes) {
    if (entry.changes.basePay !== undefined) basePay = hrNumber(entry.changes, 'basePay', 0, MAX_MONEY, true);
    if (entry.changes.payType !== undefined) payType = hrEnum(entry.changes, 'payType', ['monthly', 'hourly'] as const);
  }
  return { basePay: hrNumber({ basePay }, 'basePay', 0, MAX_MONEY, true), payType };
}
function buildRow(workspace: HrWorkspace, employee: HrEmployee, run: Pick<HrPayrollRun, 'month' | 'proration'>): HrPayrollRow {
  const period = employmentPeriod(employee, run.month);
  if (!period) hrFail(`${employee.name}: 귀속월에 재직한 기간이 없습니다.`);
  const totals = getHrAttendanceTotals(workspace, employee.id, period.start, period.end);
  const recognizedMinutes = hrNumber({ minutes: totals.recognizedMinutes }, 'minutes', 0, 44_640, true);
  const paidLeaveMinutes = hrNumber({ minutes: totals.paidLeaveMinutes }, 'minutes', 0, 44_640, true);
  const segments: HrPayrollSegment[] = [];
  for (let date = period.start; date <= period.end; date = new Date(Date.parse(date) + DAY).toISOString().slice(0, 10)) {
    const rate = payOnDate(employee, date);
    const last = segments[segments.length - 1];
    if (last && last.basePay === rate.basePay && last.payType === rate.payType) { last.endDate = date; last.payableDays += 1; }
    else segments.push({ startDate: date, endDate: date, ...rate, payableDays: 1, recognizedMinutes: 0, paidLeaveMinutes: 0, baseAmount: 0 });
  }
  for (const segment of segments) {
    const times = getHrAttendanceTotals(workspace, employee.id, segment.startDate, segment.endDate);
    segment.recognizedMinutes = times.recognizedMinutes; segment.paidLeaveMinutes = times.paidLeaveMinutes;
    segment.baseAmount = money(segment.payType === 'hourly'
      ? Math.round(segment.basePay * (times.recognizedMinutes + times.paidLeaveMinutes) / 60)
      : Math.round(segment.basePay * segment.payableDays / (run.proration === 'full' ? period.days : period.calendarDays)));
  }
  const baseAmount = segments.reduce((sum, segment) => money(sum + segment.baseAmount), 0);
  const lastRate = segments[segments.length - 1]!;
  const sourceKey = JSON.stringify({ segments, status: employee.status, start: period.start, end: period.end, totals });
  return {
    employeeId: employee.id, employeeNumber: employee.employeeNumber, name: employee.name,
    payType: lastRate.payType, basePay: lastRate.basePay, employmentStatus: employee.status,
    periodStart: period.start, periodEnd: period.end, calendarDays: period.calendarDays, payableDays: period.days,
    recognizedMinutes, paidLeaveMinutes, unpaidLeaveMinutes: totals.unpaidLeaveMinutes,
    pendingCount: totals.pendingCount, attendanceLocked: totals.locked, sourceKey, baseAmount, segments,
    adjustments: [], incomeTax: null, localTax: null, employeeInsurance: null, employerInsurance: null,
    manualConfirmed: false, note: '',
  };
}

export function calculateHrPayrollRow(row: HrPayrollRow): HrPayrollTotals {
  const allowance = row.adjustments.filter(item => item.kind === 'allowance').reduce((total, item) => money(total + item.amount), 0);
  const manualDeductions = row.adjustments.filter(item => item.kind === 'deduction').reduce((total, item) => money(total + item.amount), 0);
  const gross = money(row.baseAmount + allowance);
  const deductions = money(manualDeductions + (row.incomeTax ?? 0) + (row.localTax ?? 0) + (row.employeeInsurance ?? 0));
  const employerInsurance = row.employerInsurance ?? 0;
  const net = MANUAL_FIELDS.every(key => row[key] !== null) ? money(gross - deductions) : null;
  return { gross, deductions, net, employerInsurance, laborCost: money(gross + employerInsurance) };
}
export function calculateHrPayrollRun(run: HrPayrollRun): HrPayrollTotals {
  return run.rows.reduce<HrPayrollTotals>((sum, row) => {
    const next = calculateHrPayrollRow(row);
    return {
      gross: money(sum.gross + next.gross), deductions: money(sum.deductions + next.deductions),
      net: sum.net === null || next.net === null ? null : money(sum.net + next.net),
      employerInsurance: money(sum.employerInsurance + next.employerInsurance), laborCost: money(sum.laborCost + next.laborCost),
    };
  }, { gross: 0, deductions: 0, net: 0, employerInsurance: 0, laborCost: 0 });
}
/** Only locked snapshots are eligible to become ODA labor expense. Employee withholdings are not a second cost. */
export function getHrPayrollFinalizedTotal(state: HrPayrollState, month: string): number {
  return state.runs.filter(run => run.month === month && (run.status === 'locked' || run.status === 'published'))
    .reduce((sum, run) => money(sum + calculateHrPayrollRun(run).laborCost), 0);
}
export function getHrPayrollStateForContext(state: HrPayrollState, ctx: HrContext): HrPayrollState {
  if (ctx.payroll) return structuredClone(state);
  if (!ctx.employeeId) return createHrPayrollState();
  return { runs: state.runs.filter(run => run.status === 'published' && run.publishedAt && run.publishedAt <= ctx.now)
    .map(run => ({ ...structuredClone(run), rows: run.rows.filter(row => row.employeeId === ctx.employeeId).map(row => ({ ...structuredClone(row), sourceKey: '', note: '' })), history: [] }))
    .filter(run => run.rows.length > 0) };
}
function runById(workspace: HrWorkspace, input: Record<string, unknown>): HrPayrollRun {
  const id = hrText(input, 'runId', 120);
  const run = workspace.payroll.runs.find(item => item.id === id);
  if (!run) hrFail('급여 정산을 찾을 수 없습니다.', 'HR_PAYROLL_NOT_FOUND', 404);
  return run;
}
function editable(run: HrPayrollRun): void {
  if (run.status !== 'draft') hrFail('검토된 급여는 사유를 기록하고 다시 열어야 수정할 수 있습니다.', 'HR_PAYROLL_LOCKED', 409);
}
function rowById(run: HrPayrollRun, input: Record<string, unknown>): HrPayrollRow {
  const id = hrText(input, 'employeeId', 120);
  const row = run.rows.find(item => item.employeeId === id);
  if (!row) hrFail('급여 대상자를 찾을 수 없습니다.', 'HR_PAYROLL_ROW_NOT_FOUND', 404);
  return row;
}
function reviewable(workspace: HrWorkspace, run: HrPayrollRun): void {
  if (!run.rows.length) hrFail('급여 대상자가 없습니다.');
  for (const row of run.rows) {
    const current = buildRow(workspace, hrEmployee(workspace, row.employeeId), run);
    if (current.sourceKey !== row.sourceKey) hrFail(`${row.name}: 구성원 또는 근태 정보가 바뀌었습니다. 초안에서 최신정보를 반영해 주세요.`, 'HR_PAYROLL_STALE', 409);
    if (!current.attendanceLocked || current.pendingCount) hrFail(`${row.name}: 해당 기간 근태를 마감하고 미처리 요청을 확인해 주세요.`, 'HR_PAYROLL_ATTENDANCE_OPEN', 409);
    if (!row.manualConfirmed || MANUAL_FIELDS.some(key => row[key] === null)) hrFail(`${row.name}: 세액·보험 금액을 0원 포함 직접 입력하고 검토를 확인해 주세요.`);
    if (row.employmentStatus === 'leave' && row.note.trim().length < 3) hrFail(`${row.name}: 휴직 중 지급률·기간을 확인한 내용을 적어 주세요.`);
    if ((calculateHrPayrollRow(row).net ?? -1) < 0) hrFail(`${row.name}: 공제금이 지급액을 초과합니다.`);
  }
}
function snapshot(run: HrPayrollRun, ctx: HrContext, reason: string, revision = run.revision): void {
  run.history.push({ revision, status: run.status, rows: structuredClone(run.rows), totals: calculateHrPayrollRun(run), at: ctx.now, actorId: ctx.actorId, reason });
}

/** Mutates only after validation; unknown commands are left for other HR modules. */
export function applyHrPayrollCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  if (!command.type.startsWith('payroll.')) return false;
  payrollPermission(ctx);
  const input = command.input;
  if (command.type === 'payroll.create') {
    const month = hrText(input, 'month', 7); monthPeriod(month);
    if (workspace.payroll.runs.some(run => run.month === month)) hrFail('같은 귀속월 급여가 이미 있습니다. 기존 정산을 다시 열어 주세요.', 'HR_PAYROLL_DUPLICATE', 409);
    const payDate = hrDate(input, 'payDate');
    const proration = hrEnum(input, 'proration', ['calendar', 'full'] as const, 'calendar');
    const ids = input.employeeIds === undefined ? workspace.employees.filter(employee => employmentPeriod(employee, month)).map(employee => employee.id) : hrStringArray(input, 'employeeIds', 2000);
    if (!ids.length) hrFail('귀속월에 재직한 대상자가 없습니다.');
    const rows = ids.map(id => buildRow(workspace, hrEmployee(workspace, id), { month, proration }));
    const title = hrText(input, 'title', 100, true) || `${month} 급여명세서`;
    workspace.payroll.runs.push({ id: ctx.id(), month, payDate, title, proration, rows, status: 'draft', revision: 1, createdAt: ctx.now, updatedAt: ctx.now, createdBy: ctx.actorId, history: [] });
    return true;
  }
  const run = runById(workspace, input);
  if (input.revision !== undefined && input.revision !== run.revision) hrFail('다른 변경이 저장되었습니다. 새로고침 후 다시 처리해 주세요.', 'HR_CONFLICT', 409);
  switch (command.type) {
    case 'payroll.updateRow': {
      editable(run);
      const row = rowById(run, input);
      const values = Object.fromEntries(MANUAL_FIELDS.map(key => [key, hrNumber(input, key, 0, MAX_MONEY, true)])) as Record<typeof MANUAL_FIELDS[number], number>;
      const note = hrText(input, 'note', 1000, true);
      if (typeof input.manualConfirmed !== 'boolean') hrFail('세액·보험 검토 여부를 확인해 주세요.');
      Object.assign(row, values, { note, manualConfirmed: input.manualConfirmed });
      break;
    }
    case 'payroll.addAdjustment': {
      editable(run);
      const row = rowById(run, input);
      const kind = hrEnum(input, 'kind', ['allowance', 'deduction'] as const);
      const category = hrEnum(input, 'category', ['manual', 'unpaid_leave'] as const, 'manual');
      if (category === 'unpaid_leave' && (kind !== 'deduction' || row.segments.some(segment => segment.payType === 'hourly'))) hrFail('무급휴가 차감 항목은 전체 기간이 월급제인 경우에만 사용할 수 있습니다.');
      const label = hrText(input, 'label', 80);
      const amount = hrNumber(input, 'amount', 1, MAX_MONEY, true);
      if (row.adjustments.length >= 100) hrFail('추가 항목은 구성원당 100개까지 입력할 수 있습니다.');
      row.adjustments.push({ id: ctx.id(), kind, category, label, amount });
      row.manualConfirmed = false;
      break;
    }
    case 'payroll.removeAdjustment': {
      editable(run);
      const row = rowById(run, input);
      const id = hrText(input, 'adjustmentId', 120);
      if (!row.adjustments.some(item => item.id === id)) hrFail('수당·공제 항목을 찾을 수 없습니다.');
      row.adjustments = row.adjustments.filter(item => item.id !== id);
      row.manualConfirmed = false;
      break;
    }
    case 'payroll.addEmployee': {
      editable(run);
      const id = hrText(input, 'employeeId', 120);
      if (run.rows.some(row => row.employeeId === id)) hrFail('이미 포함된 구성원입니다.');
      run.rows.push(buildRow(workspace, hrEmployee(workspace, id), run));
      break;
    }
    case 'payroll.removeEmployee': {
      editable(run);
      const row = rowById(run, input);
      run.rows = run.rows.filter(item => item !== row);
      break;
    }
    case 'payroll.refresh': {
      editable(run);
      const rows = run.rows.map(old => {
        const next = buildRow(workspace, hrEmployee(workspace, old.employeeId), run);
        if (next.segments.some(segment => segment.payType === 'hourly') && old.adjustments.some(item => item.category === 'unpaid_leave')) hrFail(`${old.name}: 시급제 전환 전 무급휴가 차감 항목을 제거해 주세요.`);
        return { ...next, adjustments: old.adjustments, ...Object.fromEntries(MANUAL_FIELDS.map(key => [key, old[key]])), note: old.note, manualConfirmed: old.sourceKey === next.sourceKey && old.manualConfirmed };
      });
      run.rows = rows;
      break;
    }
    case 'payroll.review':
      editable(run); reviewable(workspace, run);
      run.status = 'reviewed'; run.reviewedAt = ctx.now; run.reviewedBy = ctx.actorId;
      break;
    case 'payroll.lock':
      if (run.status !== 'reviewed') hrFail('급여 검토를 완료한 뒤 잠글 수 있습니다.', 'HR_PAYROLL_STATE', 409);
      reviewable(workspace, run);
      run.status = 'locked'; run.lockedAt = ctx.now; run.lockedBy = ctx.actorId;
      snapshot(run, ctx, '급여 확정', run.revision + 1);
      break;
    case 'payroll.publish': {
      if (run.status !== 'locked') hrFail('잠금 완료된 급여만 공개할 수 있습니다.', 'HR_PAYROLL_STATE', 409);
      const requested = hrText(input, 'publishAt', 40, true) || ctx.now;
      const parsed = new Date(requested);
      if (!Number.isFinite(parsed.valueOf())) hrFail('공개 시각을 확인해 주세요.');
      run.publishedAt = parsed.toISOString(); run.publishedBy = ctx.actorId; run.status = 'published';
      break;
    }
    case 'payroll.reopen': {
      if (run.status === 'draft') hrFail('이미 작성 중인 급여입니다.');
      const reason = hrText(input, 'reason', 1000);
      if (reason.length < 3) hrFail('변경 사유를 3자 이상 적어 주세요.');
      snapshot(run, ctx, reason);
      run.status = 'draft';
      delete run.reviewedAt; delete run.reviewedBy; delete run.lockedAt; delete run.lockedBy; delete run.publishedAt; delete run.publishedBy;
      run.rows.forEach(row => { row.manualConfirmed = false; });
      break;
    }
    case 'payroll.delete':
      editable(run);
      if (run.history.length) hrFail('확정 이력이 있는 급여는 삭제할 수 없습니다.');
      workspace.payroll.runs = workspace.payroll.runs.filter(item => item !== run);
      return true;
    default:
      hrFail('지원하지 않는 급여 작업입니다.', 'HR_UNKNOWN_COMMAND', 400);
  }
  run.revision += 1; run.updatedAt = ctx.now;
  return true;
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '미검토' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportHrPayrollCsv(run: HrPayrollRun, ctx: HrContext): string {
  const visible = getHrPayrollStateForContext({ runs: [run] }, ctx).runs[0];
  if (!visible) hrFail('공개된 본인 급여만 내려받을 수 있습니다.', 'HR_FORBIDDEN', 403);
  const headers = ['귀속월', '지급일', '사번', '이름', '최종구간구분', '최종구간단가', '적용시작', '적용종료', '재직일수', '월력일수', '인정근무분', '유급휴가분', '기본급', '수당합계', '수동공제', '소득세', '지방소득세', '근로자보험', '회사보험', '총지급', '공제합계', '실지급', '상태', '월급비례정책', '기간별계산근거'];
  const lines = visible.rows.map(row => {
    const total = calculateHrPayrollRow(row);
    return [run.month, run.payDate, row.employeeNumber, row.name, row.payType === 'hourly' ? '시급' : '월급', row.basePay, row.periodStart, row.periodEnd, row.payableDays, row.calendarDays, row.recognizedMinutes, row.paidLeaveMinutes, row.baseAmount,
      row.adjustments.filter(item => item.kind === 'allowance').reduce((sum, item) => sum + item.amount, 0), row.adjustments.filter(item => item.kind === 'deduction').reduce((sum, item) => sum + item.amount, 0), row.incomeTax, row.localTax, row.employeeInsurance, row.employerInsurance, total.gross, total.deductions, total.net, run.status, run.proration,
      row.segments.map(segment => `${segment.startDate}~${segment.endDate}: ${segment.payType}, ${segment.basePay}원, ${segment.payableDays}일, 근무${segment.recognizedMinutes}분+유급휴가${segment.paidLeaveMinutes}분, 기본급${segment.baseAmount}원`).join('; ')];
  });
  return '\uFEFF' + [headers, ...lines].map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
