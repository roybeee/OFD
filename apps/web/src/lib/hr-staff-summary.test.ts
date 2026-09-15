import { describe, expect, it } from 'vitest';
import { createHrWorkspace, type HrResponse, type HrStoreScheduleEntry } from '../../../../packages/domain/src/oda-hr';
import { addStaffDays, staffScheduleIcs, staffWeekSummary } from './hr-staff-summary';

function fixture(): HrResponse {
  const workspace = createHrWorkspace('s1', '테스트', '2026-09-16T00:00:00Z');
  workspace.employees.push({ id: 'e1', name: '직원', employeeNumber: '1', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay: 0, history: [] });
  workspace.attendance.workPolicies.push({ id: 'p1', name: '기준', kind: 'fixed', effectiveFrom: '2026-01-01', cycle: '1w', dailyMinutes: 480, breakMinutes: 60, workdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00', requireApproval: true, coreStart: '', coreEnd: '' });
  workspace.attendance.assignments.push({ id: 'a1', employeeId: 'e1', policyId: 'p1', effectiveFrom: '2026-01-01' });
  return { workspace, permissions: { manage: false, payroll: false, self: true }, employeeId: 'e1' };
}
describe('employee home summaries', () => {
  it('counts only approved work and calculates the assigned week with holidays', () => {
    const response = fixture(); response.workspace.attendance.holidays.push('2026-09-15');
    const entry = { id: 'w1', employeeId: 'e1', date: '2026-09-14', endDate: '2026-09-14', startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480, source: 'manual' as const, policyId: 'p1', note: '', revision: 1, createdAt: '', createdBy: '', reviewedAt: '', reviewedBy: '', rawClockIds: [] };
    response.workspace.attendance.workEntries.push({ ...entry, status: 'approved' }, { ...entry, id: 'w2', date: '2026-09-16', endDate: '2026-09-16', status: 'pending' });
    expect(staffWeekSummary(response, '2026-09-16')).toMatchObject({ start: '2026-09-14', end: '2026-09-20', target: 1920, recognizedMinutes: 480, pendingCount: 1 });
  });
  it('shows unconfigured targets truthfully and uses published overnight shifts', () => {
    const response = fixture(); response.workspace.attendance.assignments = [];
    expect(staffWeekSummary(response, '2026-09-16').target).toBeNull();
    const shift = { id: 'night', employeeId: 'e1', date: '2026-09-16', templateId: '', startTime: '22:00', endTime: '06:00', breakMinutes: 30, kind: 'work' as const, revision: 1, publishedAt: '', note: '' };
    response.workspace.attendance.shifts.push({ ...shift, status: 'published' }, { ...shift, id: 'draft', date: '2026-09-17', status: 'draft' });
    expect(staffWeekSummary(response, '2026-09-16').target).toBe(450);
  });
  it('limits targets to employment dates and resolves weeks across month boundaries', () => {
    const response = fixture(); response.workspace.employees[0]!.hireDate = '2026-09-16';
    expect(staffWeekSummary(response, '2026-09-16').target).toBe(1440);
    expect(staffWeekSummary(response, '2026-10-01')).toMatchObject({ start: '2026-09-28', end: '2026-10-04' });
    expect(addStaffDays('2026-09-30', 1)).toBe('2026-10-01');
  });
  it('exports only selected-month work shifts with correct overnight end date and no names', () => {
    const row: HrStoreScheduleEntry = { id: 's1', employeeId: 'e1', employeeName: '공개하지 않을 이름', date: '2026-09-30', startTime: '22:00', endTime: '06:00', breakMinutes: 30, kind: 'work' };
    const ics = staffScheduleIcs([row, { ...row, id: 'off', kind: 'off' }, { ...row, id: 'next', date: '2026-10-01' }], '2026-09');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('DTSTART;TZID=Asia/Seoul:20260930T220000');
    expect(ics).toContain('DTEND;TZID=Asia/Seoul:20261001T060000');
    expect(ics).not.toContain(row.employeeName);
    expect(ics).toContain('END:VCALENDAR\r\n');
  });
});
