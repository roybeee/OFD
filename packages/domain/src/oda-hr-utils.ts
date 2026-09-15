import { DomainError } from './errors.ts';
import type { HrContext, HrEmployee, HrWorkspace } from './oda-hr.ts';

const fieldLabels: Record<string, string> = { id: '대상', name: '이름', title: '제목', body: '내용', category: '분류',
  employeeNumber: '사번', actorId: '로그인 계정', departmentId: '조직', jobTitle: '직책', hireDate: '입사일', endDate: '종료일',
  employmentType: '고용형태', status: '상태', payType: '급여 기준', basePay: '기본급', email: '이메일', phone: '연락처',
  effectiveDate: '적용일', reason: '사유', companyName: '회사 이름', workdayHours: '하루 기준시간', weeklyDays: '주 근무일수',
  annualLeaveDays: '기본 연차 일수', approvalEmployeeId: '담당자', employeeId: '구성원', amount: '금액', comment: '처리 의견',
  templateId: '결재 양식', workflowId: '결재 문서', fromActorId: '원결재자', toActorId: '대결자', startDate: '시작일',
  date: '날짜', evidenceNote: '증빙 정보', decision: '처리 결과', approverIds: '결재자', mode: '승인 조건', timezone: '시간대' };
const fieldName = (key: string) => fieldLabels[key] ?? '입력값';

export function hrFail(message: string, code = 'HR_VALIDATION', status = 422): never { throw new DomainError(code, message, status); }
export function hrText(input: Record<string, unknown>, key: string, max = 500, optional = false): string {
  const value = input[key];
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) hrFail(`${fieldName(key)}: 1~${max}자 이내로 입력해 주세요.`);
  return value.trim();
}
export function hrNumber(input: Record<string, unknown>, key: string, min = 0, max = 1_000_000_000, integer = false): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) hrFail(`${fieldName(key)}: ${min}~${max} 범위의 ${integer ? '정수' : '숫자'}를 입력해 주세요.`);
  return value;
}
export function hrDate(input: Record<string, unknown>, key: string): string {
  const value = hrText(input, key, 10);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) hrFail(`${fieldName(key)}: 실제 날짜를 입력해 주세요.`);
  return value;
}
export function hrEnum<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[], fallback?: T): T {
  if (input[key] === undefined && fallback !== undefined) return fallback;
  if (typeof input[key] !== 'string' || !values.includes(input[key] as T)) hrFail(`${fieldName(key)}: 유효한 항목을 선택해 주세요.`);
  return input[key] as T;
}
export function hrEmployee(workspace: HrWorkspace, id: string, active = false): HrEmployee {
  const employee = workspace.employees.find(row => row.id === id);
  if (!employee || (active && employee.status !== 'active')) hrFail('해당 매장의 재직 구성원을 찾을 수 없습니다.', 'HR_EMPLOYEE_NOT_FOUND', 404);
  return employee;
}
export function hrManager(ctx: HrContext): void { if (!ctx.manager) hrFail('인사관리 권한이 필요합니다.', 'HR_FORBIDDEN', 403); }
export function hrOwnOrManager(ctx: HrContext, employeeId: string): void { if (!ctx.manager && ctx.employeeId !== employeeId) hrFail('본인의 내역만 처리할 수 있습니다.', 'HR_FORBIDDEN', 403); }
export function hrStringArray(input: Record<string, unknown>, key: string, max = 100): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 120)) hrFail(`${fieldName(key)}: 올바른 목록을 입력해 주세요.`);
  return [...new Set(value as string[])];
}
