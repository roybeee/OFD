import type { HrResponse, HrStoreScheduleEntry } from '../../../../packages/domain/src/oda-hr';
import { getHrAttendanceTotals, getHrWorkPolicy } from '../../../../packages/domain/src/oda-hr-attendance';

export function addStaffDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function staffDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
}
export function shiftMinutes(row: HrStoreScheduleEntry): number {
  if (row.kind === 'off') return 0;
  const time = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  let difference = time(row.endTime) - time(row.startTime); if (difference <= 0) difference += 1440;
  return Math.max(0, difference - row.breakMinutes);
}
export function staffWeekSummary(response: HrResponse | null, today: string) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = addStaffDays(today, -(weekday === 0 ? 6 : weekday - 1)); const end = addStaffDays(start, 6);
  let target = 0, configured = false;
  const w = response?.workspace; const id = response?.employeeId;
  if (w && id) for (let index = 0; index < 7; index++) {
    const date = addStaffDays(start, index);
    const employee = w.employees.find(row => row.id === id);
    if (!employee || date < employee.hireDate || employee.endDate && date > employee.endDate) continue;
    const shifts = w.attendance.shifts.filter(row => row.employeeId === id && row.date === date && row.status === 'published');
    const policy = getHrWorkPolicy(w.attendance, id, date);
    if (shifts.length) { configured = true; target += shifts.reduce((sum, row) => sum + shiftMinutes({ ...row, employeeName: employee.name }), 0); }
    else if (policy) { configured = true; const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; if (policy.kind !== 'shift' && policy.workdays.includes(day) && !w.attendance.holidays.includes(date)) target += policy.dailyMinutes; }
  }
  const totals = w && id ? getHrAttendanceTotals(w, id, start, end) : { recognizedMinutes: 0, paidLeaveMinutes: 0, unpaidLeaveMinutes: 0, pendingCount: 0 };
  return { start, end, target: configured ? target : null, ...totals };
}

/** An explicit export of the employee's published shifts, never an external sync. */
export function staffScheduleIcs(rows: HrStoreScheduleEntry[], month: string): string {
  const escape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;').replaceAll('\r', '');
  const stamp = (date: string, time: string) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
  const now = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}/, '');
  const events = rows.filter(row => row.kind === 'work' && row.date.startsWith(`${month}-`)).flatMap(row => [
    'BEGIN:VEVENT', `UID:oda-shift-${encodeURIComponent(row.id)}@oda-workstation`, `DTSTAMP:${now}`,
    `DTSTART;TZID=Asia/Seoul:${stamp(row.date, row.startTime)}`,
    `DTEND;TZID=Asia/Seoul:${stamp(row.endTime <= row.startTime ? addStaffDays(row.date, 1) : row.date, row.endTime)}`,
    `SUMMARY:${escape('매장 근무')}`, `DESCRIPTION:${escape(`휴게 ${row.breakMinutes}분. 일정 변경 시 다시 내보내세요.`)}`, 'END:VEVENT',
  ]);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ODA//Staff schedule//KO', 'CALSCALE:GREGORIAN', 'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD', 'END:VTIMEZONE', ...events, 'END:VCALENDAR', ''].join('\r\n');
}
