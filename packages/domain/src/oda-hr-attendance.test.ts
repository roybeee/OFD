import assert from "node:assert/strict";
import test from "node:test";
import { createHrWorkspace, type HrContext, type HrWorkspace } from "./oda-hr.ts";
import { applyHrAttendanceCommand, getHrAttendanceTotals, getHrLeaveBalance, isHrAttendanceLocked, projectHrAttendanceState } from "./oda-hr-attendance.ts";
import { DomainError } from "./errors.ts";

function fixture() {
  let seq = 0;
  const ctx: HrContext = { actorId: "admin", employeeId: "a", manager: true, payroll: true, today: "2026-09-30", now: "2026-09-30T09:00:00.000Z", id: () => `id-${++seq}` };
  const w = createHrWorkspace("store-test", "테스트 회사", ctx.now);
  w.employees.push(...["a", "b"].map((id) => ({ id, employeeNumber: id, name: id, actorId: id, departmentId: "", jobTitle: "", employmentType: "regular" as const, status: "active" as const, hireDate: "2026-01-01", payType: "hourly" as const, basePay: 12000, history: [] })));
  const run = (type: string, input: Record<string, unknown>, context = ctx) => applyHrAttendanceCommand(w, { type, input }, context);
  const grant = (minutes: number, effectiveFrom = "2026-01-01", expiresOn = "2026-12-31") => run("leave.grant", { employeeId: "a", typeId: "annual", minutes, effectiveFrom, expiresOn, note: "테스트 부여" });
  const leave = (startDate = "2026-09-14", endDate = startDate, more: Record<string, unknown> = {}) => run("leave.request", { employeeId: "a", typeId: "annual", startDate, endDate, startTime: "09:00", endTime: "18:00", minutesPerDay: 480, ...more });
  const work = (d = "2026-09-14", more: Record<string, unknown> = {}) => run("work.create", { employeeId: "a", date: d, startTime: "09:00", endTime: "18:00", breakMinutes: 60, ...more });
  return { w, ctx, run, grant, leave, work };
}
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;

test("초기 워크스페이스에는 가짜 근무·타각·휴가 원장·교대 데이터가 없다", () => {
  const w = createHrWorkspace("empty", "회사", "2026-09-30T00:00:00Z");
  assert.equal(w.employees.length, 0);
  for (const key of ["workEntries", "clockEvents", "leaveLedger", "leaveRequests", "shifts", "locks"] as const) assert.equal(w.attendance[key].length, 0);
});

test("고정근무 일정 밖 원시 타각을 보존하고 인정 분만 제한·수정한다", () => {
  const { w, ctx, run } = fixture();
  run("work.policy.create", { name: "고정", kind: "fixed", effectiveFrom: "2026-01-01", dailyMinutes: 480, breakMinutes: 60, workdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00", requireApproval: true });
  run("work.policy.assign", { employeeId: "a", policyId: w.attendance.workPolicies[0]!.id, effectiveFrom: "2026-01-01" });
  run("clock.in", { employeeId: "a", at: "2099-01-01" }, { ...ctx, today: "2026-09-14", now: "2026-09-13T23:00:00Z" });
  run("clock.out", { employeeId: "a" }, { ...ctx, today: "2026-09-14", now: "2026-09-14T11:00:00Z" });
  const raw = structuredClone(w.attendance.clockEvents); const row = w.attendance.workEntries[0]!;
  assert.equal(row.startTime, "08:00"); assert.equal(row.endTime, "20:00"); assert.equal(row.recognizedMinutes, 480); assert.equal(row.status, "pending");
  run("work.update", { id: row.id, expectedRevision: 1, employeeId: "a", date: row.date, startTime: "08:00", endTime: "20:00", breakMinutes: 60, recognizedMinutes: 420, note: "확인 후 정정" });
  assert.deepEqual(w.attendance.clockEvents, raw); assert.equal(w.attendance.workEntries[0]!.recognizedMinutes, 420);
  assert.deepEqual(w.attendance.workEntries[0]!.rawClockIds, raw.map((r) => r.id));
});

test("휴가 대기 신청은 즉시 잔액을 예약하여 연속 요청의 이중 사용을 차단한다", () => {
  const { w, grant, leave } = fixture(); grant(480); leave();
  assert.deepEqual(getHrLeaveBalance(w.attendance, "a", "annual", "2026-09-14"), { availableMinutes: 0, reservedMinutes: 480 });
  const snapshot = structuredClone(w.attendance);
  assert.throws(() => leave("2026-09-15"), code("hr_leave_balance"));
  assert.deepEqual(w.attendance, snapshot);
});

test("여러 날 신청 중 마지막 날 잔액 부족은 이전 날 차감까지 전부 롤백한다", () => {
  const { w, grant, leave } = fixture(); grant(480); const before = structuredClone(w.attendance);
  assert.throws(() => leave("2026-09-14", "2026-09-15"), code("hr_leave_balance"));
  assert.deepEqual(w.attendance, before);
});

test("취소는 만료가 빠른 순서로 사용한 정확한 부여 건과 만료일을 복원한다", () => {
  const { w, grant, leave, run } = fixture(); grant(240, "2026-01-01", "2026-09-14"); grant(480); leave();
  const uses = w.attendance.leaveLedger.filter((r) => r.kind === "use"); assert.deepEqual(uses.map((r) => r.minutes), [-240, -240]);
  const request = w.attendance.leaveRequests[0]!;
  run("leave.cancel", { id: request.id, expectedRevision: 1 });
  const restores = w.attendance.leaveLedger.filter((r) => r.kind === "restore");
  for (const use of uses) { const restore = restores.find((r) => r.sourceEntryId === use.id)!; assert.equal(restore.lotId, use.lotId); assert.equal(restore.expiresOn, use.expiresOn); assert.equal(restore.minutes, -use.minutes); }
  assert.equal(getHrLeaveBalance(w.attendance, "a", "annual", "2026-09-30").availableMinutes, 480);
  const before = structuredClone(w.attendance); assert.throws(() => run("leave.cancel", { id: request.id, expectedRevision: 1 }), code("hr_conflict")); assert.deepEqual(w.attendance, before);
});

test("휴가 승인과 취소의 버전 경쟁은 뒤늦은 승인을 거부한다", () => {
  const { w, grant, leave, run } = fixture(); grant(480); leave(); const id = w.attendance.leaveRequests[0]!.id;
  run("leave.cancel", { id, expectedRevision: 1 });
  assert.throws(() => run("leave.approve", { id, expectedRevision: 1 }), code("hr_conflict"));
  assert.equal(w.attendance.leaveRequests[0]!.status, "cancelled"); assert.equal(w.attendance.leaveLedger.filter((r) => r.kind === "restore").length, 1);
});

test("휴가/근무 겹침은 차단하고 맞닿은 반개구간은 허용한다", () => {
  const { w, grant, leave, work } = fixture(); grant(480); work("2026-09-14", { startTime: "09:00", endTime: "12:00", breakMinutes: 0 });
  assert.throws(() => leave("2026-09-14", "2026-09-14", { startTime: "11:00", endTime: "13:00", minutesPerDay: 120 }), code("hr_overlap"));
  leave("2026-09-14", "2026-09-14", { startTime: "12:00", endTime: "16:00", minutesPerDay: 240 }); assert.equal(w.attendance.leaveRequests.length, 1);
  assert.throws(() => work("2026-09-14", { startTime: "15:00", endTime: "17:00", breakMinutes: 0 }), code("hr_overlap"));
});

test("근무일·휴일과 부여 유효기간은 각 휴가 사용일에 적용한다", () => {
  const { w, grant, leave, run } = fixture(); grant(480, "2026-09-14", "2026-09-14");
  run("attendance.holidays.set", { dates: ["2026-09-15"] });
  leave("2026-09-12", "2026-09-15"); assert.deepEqual(w.attendance.leaveRequests[0]!.slots.map((r) => r.date), ["2026-09-14"]);
  assert.throws(() => leave("2026-09-16"), code("hr_leave_balance"));
});

test("대기 건과 미퇴근은 마감을 차단하고 마감 후 수정·취소·배정은 거부한다", () => {
  const { w, work, run, grant, leave } = fixture(); work();
  const lock = { startDate: "2026-09-14", endDate: "2026-09-15", employeeIds: ["a"], reason: "급여 자료 확정" };
  assert.throws(() => run("attendance.lock", lock), code("hr_pending"));
  run("work.approve", { id: w.attendance.workEntries[0]!.id, expectedRevision: 1 }); grant(480); leave("2026-09-15");
  assert.throws(() => run("attendance.lock", lock), code("hr_pending"));
  run("leave.approve", { id: w.attendance.leaveRequests[0]!.id, expectedRevision: 1 }); run("attendance.lock", lock);
  assert.equal(isHrAttendanceLocked(w.attendance, "a", "2026-09-15"), true); assert.equal(isHrAttendanceLocked(w.attendance, "b", "2026-09-15"), false);
  assert.throws(() => run("leave.cancel", { id: w.attendance.leaveRequests[0]!.id, expectedRevision: 2 }), code("hr_attendance_locked"));
  assert.throws(() => work("2026-09-15"), code("hr_attendance_locked"));
  assert.throws(() => run("attendance.holidays.set", { dates: ["2026-09-15"] }), code("hr_attendance_locked"));
  const closed = w.attendance.locks[0]!; run("attendance.unlock", { id: closed.id, expectedRevision: 1, reason: "정정 필요" });
  assert.throws(() => run("attendance.unlock", { id: closed.id, expectedRevision: 1, reason: "재시도" }), code("hr_conflict"));
});

test("마감은 이전 날에 시작하여 다음 날까지 이어지는 미승인 근무도 발견한다", () => {
  const { run, work } = fixture(); work("2026-09-14", { startTime: "22:00", endTime: "06:00" });
  assert.throws(() => run("attendance.lock", { startDate: "2026-09-15", endDate: "2026-09-15", employeeIds: ["a"], reason: "야간 확인" }), code("hr_pending"));
});

test("교대 일괄 발행의 야간 겹침은 원자적으로 거부하며 일정은 근무 실적이 아니다", () => {
  const { w, run } = fixture();
  run("shift.template.create", { name: "야간", kind: "work", startTime: "22:00", endTime: "06:00", breakMinutes: 60 });
  run("shift.template.create", { name: "이른 오전", kind: "work", startTime: "05:00", endTime: "13:00", breakMinutes: 60 });
  run("shift.save", { employeeId: "a", date: "2026-09-14", templateId: w.attendance.shiftTemplates[0]!.id });
  run("shift.save", { employeeId: "a", date: "2026-09-15", templateId: w.attendance.shiftTemplates[1]!.id });
  const [a, b] = w.attendance.shifts; const publish = { ids: [a!.id, b!.id], revisions: { [a!.id]: 1, [b!.id]: 1 } };
  const before = structuredClone(w.attendance); assert.throws(() => run("shift.publish", publish), code("hr_overlap")); assert.deepEqual(w.attendance, before);
  run("shift.publish", { ids: [a!.id], revisions: { [a!.id]: 1 } });
  assert.equal(w.attendance.shifts[0]!.status, "published"); assert.equal(w.attendance.workEntries.length, 0);
  assert.equal(getHrAttendanceTotals(w, "a", "2026-09-01", "2026-09-30").recognizedMinutes, 0);
});

test("OFF 교대도 출퇴근 시간 설정을 보존하지만 근무 시간으로 계산하지 않는다", () => {
  const { w, run } = fixture(); run("shift.template.create", { name: "OFF", kind: "off", startTime: "09:00", endTime: "18:00", breakMinutes: 60 });
  run("shift.save", { employeeId: "a", date: "2026-09-14", templateId: w.attendance.shiftTemplates[0]!.id }); const row = w.attendance.shifts[0]!;
  run("shift.publish", { ids: [row.id], revisions: { [row.id]: 1 } });
  assert.equal(w.attendance.shifts[0]!.startTime, "09:00"); assert.equal(w.attendance.workEntries.length, 0);
});

test("급여 집계는 승인된 실근무와 유급·무급 휴가를 별도로 합산한다", () => {
  const { w, run, work, leave } = fixture(); work(); run("work.approve", { id: w.attendance.workEntries[0]!.id, expectedRevision: 1 });
  work("2026-09-15"); leave("2026-09-16", "2026-09-16", { typeId: "paid" }); run("leave.approve", { id: w.attendance.leaveRequests[0]!.id, expectedRevision: 1 });
  leave("2026-09-17", "2026-09-17", { typeId: "unpaid" }); run("leave.approve", { id: w.attendance.leaveRequests[1]!.id, expectedRevision: 1 });
  assert.deepEqual(getHrAttendanceTotals(w, "a", "2026-09-01", "2026-09-30"), { recognizedMinutes: 480, paidLeaveMinutes: 480, unpaidLeaveMinutes: 480, pendingCount: 1, locked: false });
});

test("직원 권한은 본인 신청만 허용하고 타인 승인·부여·조회 결과를 차단한다", () => {
  const { w, run, ctx, grant, leave, work } = fixture(); grant(480); leave(); work("2026-09-15", { employeeId: "b" });
  const self = { ...ctx, actorId: "a", manager: false, payroll: false };
  assert.throws(() => run("leave.approve", { id: w.attendance.leaveRequests[0]!.id, expectedRevision: 1 }, self), code("hr_forbidden"));
  assert.throws(() => run("work.cancel", { id: w.attendance.workEntries[0]!.id, expectedRevision: 1 }, self), code("hr_forbidden"));
  assert.throws(() => run("leave.grant", { employeeId: "a", typeId: "annual", minutes: 480, effectiveFrom: "2026-01-01", expiresOn: "2026-12-31" }, self), code("hr_forbidden"));
  const projected = projectHrAttendanceState(w.attendance, self); assert.equal(projected.workEntries.length, 0); assert.equal(projected.leaveRequests.length, 1);
  const anonymous = { actorId: "auditor", manager: false, payroll: false, today: ctx.today, now: ctx.now, id: ctx.id };
  assert.equal(projectHrAttendanceState(w.attendance, anonymous).leaveLedger.length, 0);
});

test("지원 근무 주기는 실측한 5개로 제한하고 재직 기간 밖 실적을 거부한다", () => {
  const { w, run, work } = fixture();
  assert.throws(() => run("work.policy.create", { name: "잘못된 선택적근무", kind: "selective", cycle: "3m", effectiveFrom: "2026-01-01", dailyMinutes: 480, breakMinutes: 60, workdays: [1], startTime: "09:00", endTime: "18:00" }));
  w.employees[0]!.endDate = "2026-09-14"; w.employees[0]!.status = "retired";
  work("2026-09-14"); assert.throws(() => work("2026-09-15")); assert.throws(() => work("2025-12-31"));
});

test("급여 확정 기간의 근태는 급여를 다시 열기 전 해제할 수 없다", () => {
  const { w, run } = fixture(); run("attendance.lock", { startDate: "2026-09-01", endDate: "2026-09-30", employeeIds: ["a"], reason: "급여 확정" });
  w.payroll.runs.push({ status: "locked", month: "2026-09", rows: [{ employeeId: "a" }] } as unknown as HrWorkspace["payroll"]["runs"][number]);
  assert.throws(() => run("attendance.unlock", { id: w.attendance.locks[0]!.id, expectedRevision: 1, reason: "정정" }), code("hr_payroll_locked"));
});

test("미퇴근 정리는 원시 출근을 보존하며 근무 실적을 만들어 내지 않는다", () => {
  const { w, ctx, run } = fixture(); const before = { ...ctx, today: "2026-09-14", now: "2026-09-14T00:00:00Z" };
  run("clock.in", { employeeId: "a" }, before); const original = structuredClone(w.attendance.clockEvents[0]);
  assert.throws(() => run("clock.out", { employeeId: "a" }));
  assert.throws(() => run("attendance.lock", { startDate: "2026-09-14", endDate: "2026-09-14", employeeIds: ["a"], reason: "마감" }), code("hr_pending"));
  run("clock.resolve", { employeeId: "a", note: "퇴근 누락 확인; 실제 근무 별도 입력" });
  assert.deepEqual(w.attendance.clockEvents[0], original); assert.equal(w.attendance.clockEvents[1]!.correction, true); assert.equal(w.attendance.workEntries.length, 0);
  run("clock.in", { employeeId: "a" }); assert.equal(w.attendance.clockEvents.at(-1)!.kind, "in");
});

test("1분 미만의 출퇴근은 종료할 수 있으며 인정 시간이 부풀려지지 않는다", () => {
  const { w, ctx, run } = fixture();
  run("clock.in", { employeeId: "a" }, { ...ctx, now: "2026-09-30T00:00:10Z" });
  run("clock.out", { employeeId: "a" }, { ...ctx, now: "2026-09-30T00:00:40Z" });
  assert.equal(w.attendance.clockEvents.length, 2); assert.equal(w.attendance.workEntries.length, 0);
  run("clock.in", { employeeId: "a" }, { ...ctx, now: "2026-09-30T00:00:50Z" });
  run("clock.out", { employeeId: "a" }, { ...ctx, now: "2026-09-30T00:01:20Z" });
  assert.equal(w.attendance.workEntries[0]!.recognizedMinutes, 0);
});

test("종일 휴가 구간을 작은 사용량으로 예약하거나 근무시간 밖 유급휴가를 부풀릴 수 없다", () => {
  const { w, leave, grant } = fixture(); grant(480); const original = structuredClone(w.attendance);
  assert.throws(() => leave("2026-09-14", "2026-09-14", { minutesPerDay: 30 }));
  assert.throws(() => leave("2026-09-14", "2026-09-14", { startTime: "00:00", endTime: "08:00", minutesPerDay: 480 }));
  assert.deepEqual(w.attendance, original);
});

test("직원 조회는 관리자 교대 초안과 취소된 미게시 일정을 공개하지 않는다", () => {
  const { w, ctx, run } = fixture(); run("shift.template.create", { name: "주간", kind: "work", startTime: "09:00", endTime: "18:00", breakMinutes: 60 });
  run("shift.save", { employeeId: "a", date: "2026-09-14", templateId: w.attendance.shiftTemplates[0]!.id });
  const self = { ...ctx, manager: false, payroll: false };
  assert.equal(projectHrAttendanceState(w.attendance, self).shifts.length, 0);
  const row = w.attendance.shifts[0]!; run("shift.publish", { ids: [row.id], revisions: { [row.id]: 1 } });
  assert.equal(projectHrAttendanceState(w.attendance, self).shifts.length, 1);
});
