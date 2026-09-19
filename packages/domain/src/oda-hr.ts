import { applyHrOperationsCommand, canUseHrOperations, createHrStoreOperations, type HrStoreOperations } from './oda-hr-operations.ts';
export { HR_STORE_CHECKLIST, type HrStoreOperations, type HrStoreCheck, type HrStoreHandover } from './oda-hr-operations.ts';
import { createHrAttendanceState, applyHrAttendanceCommand, projectHrAttendanceState, type HrAttendanceState } from './oda-hr-attendance.ts';
import { createHrPayrollState, applyHrPayrollCommand, getHrPayrollStateForContext, type HrPayrollState } from './oda-hr-payroll.ts';
import { createHrTalentState, applyHrTalentCommand, projectHrTalentState, type HrTalentState } from './oda-hr-talent.ts';
import { createHrWorkflowState, applyHrWorkflowCommand, projectHrWorkflowState, type HrWorkflowState } from './oda-hr-workflow.ts';
import { hrDate, hrEmployee, hrEnum, hrFail, hrManager, hrNumber, hrText } from './oda-hr-utils.ts';
import { createHrClockLocation, type HrClockLocation } from './oda-hr-location.ts';

export interface HrEmployee {
  id: string; employeeNumber: string; name: string; actorId?: string; departmentId: string; jobTitle: string;
  employmentType: 'regular' | 'contract' | 'part_time'; status: 'active' | 'leave' | 'retired'; hireDate: string; endDate?: string;
  payType: 'monthly' | 'hourly'; basePay: number; email?: string; phone?: string;
  history: Array<{ at: string; effectiveDate: string; reason: string; changes: Record<string, unknown>; previousSnapshot?: Record<string, unknown> }>;
}
export interface HrDepartment { id: string; name: string; parentId?: string; leaderId?: string; archived: boolean }
export interface HrSettings { companyName: string; workdayHours: number; weeklyDays: number; annualLeaveDays: number; timezone: 'Asia/Seoul'; approvalEmployeeId?: string; clockLocation?: HrClockLocation }
export interface HrNoticeReceipt { actorId: string; employeeId?: string; noticeUpdatedAt: string; acknowledgedAt: string }
export interface HrNotice { id: string; title: string; body: string; pinned: boolean; status: 'draft' | 'published' | 'archived'; createdBy: string; createdAt: string; updatedAt: string; receipts?: HrNoticeReceipt[] }
export interface HrDocument { id: string; title: string; category: 'contract' | 'certificate' | 'policy' | 'other'; employeeId?: string; body: string; status: 'active' | 'archived'; createdBy: string; createdAt: string; updatedAt: string }
export interface HrHistory { id: string; type: string; actorId: string; at: string; summary: string }
export interface HrWorkspace {
  id: string; storeId: string; version: number; updatedAt: string; employees: HrEmployee[]; departments: HrDepartment[];
  settings: HrSettings; notices: HrNotice[]; documents: HrDocument[]; history: HrHistory[];
  operations: HrStoreOperations;
  attendance: HrAttendanceState; payroll: HrPayrollState; talent: HrTalentState; workflow: HrWorkflowState;
}
export interface HrCommand { type: string; input: Record<string, unknown> }
export interface HrContext { operationsAllowed?: boolean; actorId: string; employeeId?: string; manager: boolean; payroll: boolean; today: string; now: string; id: () => string }
export interface HrPermissions { manage: boolean; payroll: boolean; self: boolean }
export interface HrStoreScheduleEntry { id: string; employeeId: string; employeeName: string; date: string; startTime: string; endTime: string; breakMinutes: number; kind: 'work' | 'off' }
export interface HrResponse { workspace: HrWorkspace; permissions: HrPermissions; employeeId?: string; accounts?: Array<{ id: string; name: string; role: string }>; storeSchedule?: HrStoreScheduleEntry[]; storeAddress?: string }

/** Coarse command gate precedes object lookup; slices enforce ownership, assignment and state. */
export const HR_COMMAND_ACCESS: Readonly<Record<string, 'manager' | 'member' | 'self' | 'payroll' | 'finance'>> = Object.freeze(Object.fromEntries([
  ...['operations.handover.resolve', 'workspace.initialize', 'employee.create', 'employee.update', 'employee.retire', 'department.upsert', 'department.archive', 'settings.update',
    'notice.create', 'notice.update', 'notice.archive', 'document.create', 'document.update', 'document.archive',
    'work.policy.create', 'work.policy.assign', 'work.approve', 'work.reject', 'clock.resolve', 'leave.type.create', 'leave.grant', 'leave.approve', 'leave.reject',
    'shift.template.create', 'shift.save', 'shift.publish', 'shift.cancel', 'attendance.lock', 'attendance.unlock', 'attendance.holidays.set', 'attendance.location.set',
    'review.create', 'review.update', 'review.delete', 'review.open', 'review.close', 'review.publish', 'review.revoke',
    'recruitment.createJob', 'recruitment.updateJob', 'recruitment.deleteJob', 'recruitment.addCandidate', 'recruitment.moveCandidate', 'recruitment.reopenCandidate',
    'contract.create', 'contract.update', 'contract.complete', 'contract.cancel', 'contract.applyPersonnel', 'workflow.template.save', 'workflow.template.archive'].map(type => [type, 'manager']),
  ...['operations.check', 'operations.handover.create', 'notice.acknowledge', 'work.create', 'work.update', 'work.cancel', 'clock.in', 'clock.out', 'leave.request', 'leave.cancel',
    'goal.create', 'goal.update', 'goal.complete', 'goal.reopen', 'goal.delete', 'meeting.create', 'meeting.update', 'meeting.privateNote', 'meeting.addTask', 'meeting.toggleTask', 'meeting.delete',
    'workflow.create', 'workflow.update', 'workflow.submit', 'workflow.approve', 'workflow.reject', 'workflow.withdraw', 'workflow.delegation.save', 'workflow.delegation.revoke',
    'expense.create', 'expense.update', 'expense.submit', 'expense.withdraw', 'expense.reopen'].map(type => [type, 'member']),
  ...['review.answer', 'review.submit', 'review.withdraw'].map(type => [type, 'self']),
  ...['payroll.create', 'payroll.updateRow', 'payroll.addAdjustment', 'payroll.removeAdjustment', 'payroll.addEmployee', 'payroll.removeEmployee', 'payroll.refresh',
    'payroll.review', 'payroll.lock', 'payroll.publish', 'payroll.reopen', 'payroll.delete'].map(type => [type, 'payroll']),
  ['expense.review', 'finance'],
] as Array<[string, 'manager' | 'member' | 'self' | 'payroll' | 'finance']>));

export function assertHrCommandPermission(type: string, ctx: HrContext): void {
  const permission = HR_COMMAND_ACCESS[type];
  if (!permission) hrFail('지원하지 않는 인사관리 작업입니다.', 'HR_COMMAND_UNKNOWN', 422);
  const allowed = permission === 'manager' ? ctx.manager : permission === 'self' ? Boolean(ctx.employeeId)
    : permission === 'member' ? ctx.manager || Boolean(ctx.employeeId) : permission === 'payroll' ? ctx.payroll : ctx.manager || ctx.payroll;
  if (!allowed) hrFail('이 인사관리 작업을 처리할 권한이 없습니다.', 'HR_FORBIDDEN', 403);
}

/** An empty read model is virtual until the first explicit command. No invented employee records. */
export function createHrWorkspace(storeId: string, companyName: string, now: string): HrWorkspace {
  return { id: `hr:${storeId}`, storeId, version: 0, updatedAt: now, employees: [], departments: [], notices: [], documents: [], history: [],
    settings: { companyName, workdayHours: 8, weeklyDays: 5, annualLeaveDays: 15, timezone: 'Asia/Seoul' },
    operations: createHrStoreOperations(), attendance: createHrAttendanceState(), payroll: createHrPayrollState(), talent: createHrTalentState(), workflow: createHrWorkflowState() };
}
function keys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) hrFail('지원하지 않는 입력 항목이 있습니다.');
}
function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== 'boolean') hrFail(`${key}: 참/거짓 값을 입력해 주세요.`);
  return input[key] as boolean;
}
function department(workspace: HrWorkspace, id: string): HrDepartment {
  const row = workspace.departments.find(item => item.id === id && !item.archived);
  if (!row) hrFail('사용 중인 조직을 선택해 주세요.', 'HR_DEPARTMENT_NOT_FOUND', 404);
  return row;
}
function uniqueEmployee(workspace: HrWorkspace, employee: HrEmployee): void {
  if (workspace.employees.some(row => row.id !== employee.id && row.employeeNumber === employee.employeeNumber)) hrFail('이미 사용 중인 사번입니다.', 'HR_EMPLOYEE_NUMBER_EXISTS', 409);
  if (employee.actorId && workspace.employees.some(row => row.id !== employee.id && row.actorId === employee.actorId)) hrFail('이미 다른 구성원에게 연결된 계정입니다.', 'HR_ACTOR_ALREADY_LINKED', 409);
  if (employee.departmentId) department(workspace, employee.departmentId);
  if (employee.endDate && employee.endDate < employee.hireDate) hrFail('퇴직일은 입사일 이후여야 합니다.');
  if (employee.status === 'retired' && !employee.endDate) hrFail('퇴직일을 입력해 주세요.');
}
const employeeKeys = ['employeeNumber', 'name', 'actorId', 'departmentId', 'jobTitle', 'employmentType', 'hireDate', 'payType', 'basePay', 'email', 'phone', 'status', 'endDate'];
function employeeChanges(employee: HrEmployee, input: Record<string, unknown>): void {
  keys(input, employeeKeys);
  for (const key of ['employeeNumber', 'name'] as const) if (key in input) employee[key] = hrText(input, key, 100);
  if ('departmentId' in input) employee.departmentId = hrText(input, 'departmentId', 120, true);
  // Native contract duties allow 300 characters; preserve completed terms when
  // applying them to personnel instead of rejecting or truncating signed text.
  if ('jobTitle' in input) employee.jobTitle = hrText(input, 'jobTitle', 300, true);
  for (const key of ['actorId', 'email', 'phone'] as const) if (key in input) {
    const value = hrText(input, key, key === 'email' ? 254 : 120, true);
    if (value) employee[key] = value; else delete employee[key];
  }
  if (employee.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) hrFail('이메일 형식을 확인해 주세요.');
  if ('employmentType' in input) employee.employmentType = hrEnum(input, 'employmentType', ['regular', 'contract', 'part_time']);
  if ('status' in input) employee.status = hrEnum(input, 'status', ['active', 'leave', 'retired']);
  if ('payType' in input) employee.payType = hrEnum(input, 'payType', ['monthly', 'hourly']);
  if ('basePay' in input) employee.basePay = hrNumber(input, 'basePay', 0, 1_000_000_000, true);
  if ('hireDate' in input) employee.hireDate = hrDate(input, 'hireDate');
  if ('endDate' in input) { if (input.endDate === '' || input.endDate === null) delete employee.endDate; else employee.endDate = hrDate(input, 'endDate'); }
}
function coreCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  const input = command.input;
  if (command.type === 'notice.acknowledge') {
    keys(input, ['id', 'updatedAt']);
    const row = workspace.notices.find(notice => notice.id === hrText(input, 'id', 120) && notice.status === 'published');
    if (!row) hrFail('게시된 공지를 찾을 수 없습니다.', 'HR_NOTICE_NOT_FOUND', 404);
    if (hrText(input, 'updatedAt', 40) !== row.updatedAt) hrFail('공지 내용이 변경되었습니다. 새 내용을 읽은 뒤 확인해 주세요.', 'HR_NOTICE_CHANGED', 409);
    if (ctx.employeeId && hrEmployee(workspace, ctx.employeeId).status === 'retired') hrFail('해당 매장의 재직 구성원을 찾을 수 없습니다.', 'HR_EMPLOYEE_NOT_FOUND', 404);
    const receipts = row.receipts ?? [];
    if (!receipts.some(receipt => receipt.actorId === ctx.actorId && receipt.noticeUpdatedAt === row.updatedAt)) {
      row.receipts = [...receipts.filter(receipt => receipt.actorId !== ctx.actorId), {
        actorId: ctx.actorId, ...(ctx.employeeId ? { employeeId: ctx.employeeId } : {}), noticeUpdatedAt: row.updatedAt, acknowledgedAt: ctx.now,
      }];
    }
    return true;
  }
  if (!['workspace.initialize', 'employee.create', 'employee.update', 'employee.retire', 'department.upsert', 'department.archive', 'settings.update', 'attendance.location.set', 'notice.create', 'notice.update', 'notice.archive', 'document.create', 'document.update', 'document.archive'].includes(command.type)) return false;
  hrManager(ctx);
  switch (command.type) {
    case 'attendance.location.set': workspace.settings.clockLocation = createHrClockLocation(input, ctx); return true;
    case 'workspace.initialize': keys(input, []); if (workspace.version !== 0) hrFail('이미 시작한 인사관리입니다.', 'HR_ALREADY_INITIALIZED', 409); return true;
    case 'employee.create': {
      if (workspace.employees.length >= 5000) hrFail('구성원은 최대 5,000명까지 등록할 수 있습니다.');
      const employee: HrEmployee = { id: ctx.id(), employeeNumber: hrText(input, 'employeeNumber', 100), name: hrText(input, 'name', 100),
        departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: hrDate(input, 'hireDate'), payType: 'monthly', basePay: 0, history: [] };
      employeeChanges(employee, input); uniqueEmployee(workspace, employee);
      const { history: _history, ...initial } = employee;
      employee.history.push({ at: ctx.now, effectiveDate: employee.hireDate, reason: '구성원 등록', changes: structuredClone(initial) });
      workspace.employees.push(employee); return true;
    }
    case 'employee.update': {
      keys(input, ['id', 'changes', 'effectiveDate', 'reason']);
      const employee = hrEmployee(workspace, hrText(input, 'id', 120));
      const changes = input.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) hrFail('변경할 항목을 입력해 주세요.');
      const effectiveDate = input.effectiveDate ? hrDate(input, 'effectiveDate') : ctx.today;
      if (effectiveDate > ctx.today) hrFail('예약 발령은 아직 지원하지 않습니다. 적용일 당일에 변경해 주세요.');
      const reason = hrText(input, 'reason', 500);
      const { history: _history, ...previousSnapshot } = employee;
      employeeChanges(employee, changes as Record<string, unknown>); uniqueEmployee(workspace, employee);
      employee.history.push({ at: ctx.now, effectiveDate, reason, changes: structuredClone(changes as Record<string, unknown>), previousSnapshot }); return true;
    }
    case 'employee.retire': {
      keys(input, ['id', 'endDate', 'reason']); const employee = hrEmployee(workspace, hrText(input, 'id', 120));
      if (employee.status === 'retired') hrFail('이미 퇴직한 구성원입니다.', 'HR_ALREADY_RETIRED', 409);
      const endDate = hrDate(input, 'endDate'); if (endDate > ctx.today) hrFail('퇴직 예약은 아직 지원하지 않습니다. 퇴직일에 처리해 주세요.');
      const reason = hrText(input, 'reason', 500); employee.status = 'retired'; employee.endDate = endDate; uniqueEmployee(workspace, employee);
      employee.history.push({ at: ctx.now, effectiveDate: endDate, reason, changes: { status: 'retired', endDate } }); return true;
    }
    case 'department.upsert': {
      keys(input, ['id', 'name', 'parentId', 'leaderId']); const id = hrText(input, 'id', 120, true) || ctx.id();
      const existing = workspace.departments.find(row => row.id === id); if (input.id && !existing) hrFail('조직을 찾을 수 없습니다.', 'HR_DEPARTMENT_NOT_FOUND', 404);
      if (existing?.archived) hrFail('보관한 조직은 수정할 수 없습니다.', 'HR_DEPARTMENT_ARCHIVED', 409);
      const name = hrText(input, 'name', 100); if (workspace.departments.some(row => !row.archived && row.id !== id && row.name === name)) hrFail('같은 이름의 조직이 있습니다.', 'HR_DEPARTMENT_EXISTS', 409);
      const row: HrDepartment = { id, name, archived: false }; const parentId = hrText(input, 'parentId', 120, true); const leaderId = hrText(input, 'leaderId', 120, true);
      if (parentId) {
        let ancestor: HrDepartment | undefined = department(workspace, parentId); const visited = new Set([id]);
        while (ancestor) { if (visited.has(ancestor.id)) hrFail('조직의 상하위 관계가 순환할 수 없습니다.'); visited.add(ancestor.id); ancestor = ancestor.parentId ? department(workspace, ancestor.parentId) : undefined; }
        row.parentId = parentId;
      }
      if (leaderId) { hrEmployee(workspace, leaderId, true); row.leaderId = leaderId; }
      if (existing) Object.assign(existing, row); else { if (workspace.departments.length >= 500) hrFail('조직은 최대 500개입니다.'); workspace.departments.push(row); }
      if (!parentId && existing) delete existing.parentId; if (!leaderId && existing) delete existing.leaderId; return true;
    }
    case 'department.archive': {
      keys(input, ['id']); const row = department(workspace, hrText(input, 'id', 120));
      if (workspace.employees.some(employee => employee.departmentId === row.id && employee.status !== 'retired') || workspace.departments.some(child => !child.archived && child.parentId === row.id)) hrFail('소속 구성원과 하위 조직을 먼저 이동해 주세요.', 'HR_DEPARTMENT_IN_USE', 409);
      row.archived = true; return true;
    }
    case 'settings.update': {
      keys(input, ['companyName', 'workdayHours', 'weeklyDays', 'annualLeaveDays', 'approvalEmployeeId', 'timezone', 'reason']);
      if ('companyName' in input) workspace.settings.companyName = hrText(input, 'companyName', 100);
      if ('workdayHours' in input) workspace.settings.workdayHours = hrNumber(input, 'workdayHours', 1, 24);
      if ('weeklyDays' in input) workspace.settings.weeklyDays = hrNumber(input, 'weeklyDays', 1, 7, true);
      if ('annualLeaveDays' in input) workspace.settings.annualLeaveDays = hrNumber(input, 'annualLeaveDays', 0, 366);
      if ('timezone' in input) workspace.settings.timezone = hrEnum(input, 'timezone', ['Asia/Seoul']);
      if ('approvalEmployeeId' in input) { const id = hrText(input, 'approvalEmployeeId', 120, true); if (id) { hrEmployee(workspace, id, true); workspace.settings.approvalEmployeeId = id; } else delete workspace.settings.approvalEmployeeId; }
      return true;
    }
    case 'notice.create': case 'notice.update': {
      keys(input, ['id', 'title', 'body', 'pinned', 'status']);
      const existing = command.type === 'notice.update' ? workspace.notices.find(row => row.id === hrText(input, 'id', 120)) : undefined;
      if (command.type === 'notice.update' && !existing) hrFail('공지를 찾을 수 없습니다.', 'HR_NOTICE_NOT_FOUND', 404);
      if (existing?.status === 'archived') hrFail('보관한 공지는 수정할 수 없습니다.', 'HR_ARCHIVED', 409);
      // Every edit has a distinct revision, including commands received in the same millisecond.
      const updatedAt = existing && Date.parse(existing.updatedAt) >= Date.parse(ctx.now) ? new Date(Date.parse(existing.updatedAt) + 1).toISOString() : ctx.now;
      const fields = { title: hrText(input, 'title', 200), body: hrText(input, 'body', 20000), pinned: bool(input, 'pinned'), status: hrEnum(input, 'status', ['draft', 'published'], 'draft'), updatedAt };
      if (existing) Object.assign(existing, fields); else { if (workspace.notices.length >= 1000) hrFail('공지는 최대 1,000개입니다.'); workspace.notices.push({ id: ctx.id(), ...fields, createdBy: ctx.actorId, createdAt: ctx.now }); } return true;
    }
    case 'notice.archive': {
      keys(input, ['id']); const row = workspace.notices.find(row => row.id === hrText(input, 'id', 120)); if (!row) hrFail('공지를 찾을 수 없습니다.', 'HR_NOTICE_NOT_FOUND', 404);
      row.status = 'archived'; row.updatedAt = ctx.now; return true;
    }
    case 'document.create': case 'document.update': {
      keys(input, ['id', 'title', 'category', 'employeeId', 'body']);
      const existing = command.type === 'document.update' ? workspace.documents.find(row => row.id === hrText(input, 'id', 120)) : undefined;
      if (command.type === 'document.update' && !existing) hrFail('문서를 찾을 수 없습니다.', 'HR_DOCUMENT_NOT_FOUND', 404);
      if (existing?.status === 'archived') hrFail('보관한 문서는 수정할 수 없습니다.', 'HR_ARCHIVED', 409);
      const row: HrDocument = existing ?? { id: ctx.id(), title: '', category: 'other', body: '', status: 'active', createdBy: ctx.actorId, createdAt: ctx.now, updatedAt: ctx.now };
      if (!existing || 'title' in input) row.title = hrText(input, 'title', 200);
      if (!existing || 'body' in input) row.body = hrText(input, 'body', 30000);
      if (!existing || 'category' in input) row.category = hrEnum(input, 'category', ['contract', 'certificate', 'policy', 'other'], 'other');
      if ('employeeId' in input) { const id = hrText(input, 'employeeId', 120, true); if (id) { hrEmployee(workspace, id); row.employeeId = id; } else delete row.employeeId; }
      if (row.category !== 'policy' && !row.employeeId) hrFail('개인 문서는 대상 구성원을 지정해 주세요.');
      row.updatedAt = ctx.now; if (!existing) { if (workspace.documents.length >= 2000) hrFail('문서는 최대 2,000개입니다.'); workspace.documents.push(row); } return true;
    }
    case 'document.archive': {
      keys(input, ['id']); const row = workspace.documents.find(row => row.id === hrText(input, 'id', 120)); if (!row) hrFail('문서를 찾을 수 없습니다.', 'HR_DOCUMENT_NOT_FOUND', 404);
      row.status = 'archived'; row.updatedAt = ctx.now; return true;
    }
    default: return false;
  }
}

/** Mutate only a transaction-owned copy. All changes are committed with one CAS token. */
export function applyHrCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): void {
  assertHrCommandPermission(command.type, ctx);
  const applied = applyHrOperationsCommand(workspace, command, ctx) || coreCommand(workspace, command, ctx) || applyHrAttendanceCommand(workspace, command, ctx)
    || applyHrPayrollCommand(workspace, command, ctx) || applyHrTalentCommand(workspace, command, ctx) || applyHrWorkflowCommand(workspace, command, ctx);
  if (!applied) hrFail('지원하지 않는 인사관리 작업입니다.', 'HR_COMMAND_UNKNOWN', 422);
  // No command inputs or private note content in the shared timeline.
  workspace.history.push({ id: ctx.id(), type: command.type, actorId: ctx.actorId, at: ctx.now, summary: command.type });
  workspace.history = workspace.history.slice(-1000); workspace.version += 1; workspace.updatedAt = ctx.now;
}

export function projectHrWorkspace(workspace: HrWorkspace, ctx: HrContext): HrResponse {
  const result = structuredClone(workspace);
  result.operations = canUseHrOperations(workspace, ctx) ? structuredClone(workspace.operations ?? createHrStoreOperations()) : createHrStoreOperations();
  result.employees = result.employees.filter(row => ctx.manager || ctx.payroll || row.status !== 'retired' || row.id === ctx.employeeId).map(row => {
    if (ctx.manager || row.id === ctx.employeeId) return row;
    const directory: HrEmployee = { id: row.id, employeeNumber: row.employeeNumber, name: row.name, departmentId: row.departmentId, jobTitle: row.jobTitle,
      employmentType: row.employmentType, status: row.status, hireDate: '', payType: 'monthly', basePay: 0, history: [] };
    if (row.actorId) directory.actorId = row.actorId;
    if (ctx.payroll) { directory.payType = row.payType; directory.basePay = row.basePay; directory.hireDate = row.hireDate; if (row.endDate) directory.endDate = row.endDate; }
    return directory;
  });
  result.notices = result.notices.filter(row => ctx.manager || row.status === 'published').map(row => {
    if (!ctx.manager && row.receipts) row.receipts = row.receipts.filter(receipt => receipt.actorId === ctx.actorId);
    return row;
  });
  result.documents = result.documents.filter(row => ctx.manager || (row.status === 'active' && (row.employeeId === ctx.employeeId || (row.category === 'policy' && !row.employeeId))));
  result.history = result.history.filter(row => row.actorId === ctx.actorId || (ctx.manager && !/note/i.test(row.type)));
  result.attendance = projectHrAttendanceState(workspace.attendance, ctx);
  result.payroll = getHrPayrollStateForContext(workspace.payroll, ctx);
  result.talent = projectHrTalentState(workspace.talent, ctx);
  result.workflow = projectHrWorkflowState(workspace.workflow, ctx);
  const storeSchedule: HrStoreScheduleEntry[] = workspace.attendance.shifts.filter(row => row.status === 'published').map(row => ({
    id: row.id, employeeId: row.employeeId, employeeName: workspace.employees.find(employee => employee.id === row.employeeId)?.name ?? '구성원',
    date: row.date, startTime: row.startTime, endTime: row.endTime, breakMinutes: row.breakMinutes, kind: row.kind,
  }));
  return { workspace: result, permissions: { manage: ctx.manager, payroll: ctx.payroll, self: Boolean(ctx.employeeId) }, ...(ctx.employeeId ? { employeeId: ctx.employeeId } : {}), ...(ctx.manager || ctx.employeeId ? { storeSchedule } : {}) };
}
