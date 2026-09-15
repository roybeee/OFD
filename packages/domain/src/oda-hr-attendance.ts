import { DomainError } from "./errors.js";
import type { HrCommand, HrContext, HrWorkspace } from "./oda-hr.js";
import { verifyHrClockLocation, type HrClockLocationEvidence } from "./oda-hr-location.ts";

export interface HrWorkPolicy {
  id: string; name: string; kind: "fixed" | "staggered" | "selective" | "shift";
  effectiveFrom: string; cycle: "1w" | "2w" | "3w" | "4w" | "1m";
  dailyMinutes: number; breakMinutes: number; workdays: number[];
  startTime: string; endTime: string; requireApproval: boolean;
  coreStart: string; coreEnd: string;
}
export interface HrWorkAssignment { id: string; employeeId: string; policyId: string; effectiveFrom: string }
export interface HrWorkEntry {
  id: string; employeeId: string; date: string; endDate: string; startTime: string; endTime: string;
  breakMinutes: number; recognizedMinutes: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  source: "manual" | "clock" | "shift"; policyId: string; note: string;
  revision: number; createdAt: string; createdBy: string; reviewedAt: string; reviewedBy: string;
  rawClockIds: string[];
}
/** Raw clock events are append-only and always use the authenticated server time. */
export interface HrClockEvent { id: string; employeeId: string; kind: "in" | "out"; at: string; actorId: string; workEntryId: string; correction?: boolean; note?: string; location?: HrClockLocationEvidence }
export interface HrLeaveType { id: string; name: string; paid: boolean; deductBalance: boolean; unitMinutes: number; requireApproval: boolean }
export interface HrLeaveSlot { date: string; startTime: string; endTime: string; minutes: number }
export interface HrLeaveRequest {
  id: string; employeeId: string; typeId: string; startDate: string; endDate: string;
  slots: HrLeaveSlot[]; minutes: number; paid: boolean; note: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  revision: number; createdAt: string; createdBy: string; reviewedAt: string; reviewedBy: string;
}
/** A use reserves a particular grant lot; cancellation restores precisely that lot, including its expiry. */
export interface HrLeaveLedgerEntry {
  id: string; employeeId: string; typeId: string; lotId: string; requestId: string;
  kind: "grant" | "use" | "restore"; minutes: number; effectiveFrom: string; expiresOn: string;
  sourceEntryId: string; note: string; at: string; actorId: string;
}
export interface HrShiftTemplate { id: string; name: string; startTime: string; endTime: string; breakMinutes: number; kind: "work" | "off" }
export interface HrShift {
  id: string; employeeId: string; date: string; templateId: string; startTime: string; endTime: string;
  breakMinutes: number; kind: "work" | "off"; status: "draft" | "published" | "cancelled";
  revision: number; publishedAt: string; note: string;
}
export interface HrAttendanceLock {
  id: string; startDate: string; endDate: string; employeeIds: string[];
  status: "locked" | "reopened"; revision: number; at: string; actorId: string; reason: string;
}
export interface HrAttendanceState {
  workPolicies: HrWorkPolicy[]; assignments: HrWorkAssignment[]; workEntries: HrWorkEntry[];
  clockEvents: HrClockEvent[]; leaveTypes: HrLeaveType[]; leaveRequests: HrLeaveRequest[];
  leaveLedger: HrLeaveLedgerEntry[]; shiftTemplates: HrShiftTemplate[]; shifts: HrShift[];
  locks: HrAttendanceLock[]; holidays: string[];
}

export function createHrAttendanceState(): HrAttendanceState {
  return { workPolicies: [], assignments: [], workEntries: [], clockEvents: [], leaveRequests: [], leaveLedger: [],
    leaveTypes: [
      { id: "annual", name: "연차", paid: true, deductBalance: true, unitMinutes: 30, requireApproval: true },
      { id: "paid", name: "기타 유급휴가", paid: true, deductBalance: false, unitMinutes: 30, requireApproval: true },
      { id: "unpaid", name: "무급휴가", paid: false, deductBalance: false, unitMinutes: 30, requireApproval: true },
    ], shiftTemplates: [], shifts: [], locks: [], holidays: [] };
}

function fail(message: string, code = "hr_attendance_invalid", status = 400): never { throw new DomainError(code, message, status); }
function txt(value: unknown, name: string, required = true): string {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > 2000) return fail(`${name}을(를) 확인해 주세요.`);
  return value.trim();
}
function num(value: unknown, name: string, min = 0, max = 1440): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) return fail(`${name}은(는) ${min}~${max} 사이의 정수여야 합니다.`);
  return n;
}
function date(value: unknown, name = "날짜"): string {
  const s = txt(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) return fail(`${name}이 올바르지 않습니다.`);
  return s;
}
function time(value: unknown, name = "시간"): string { const s = txt(value, name); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return fail(`${name}이 올바르지 않습니다.`); return s; }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (!values.includes(value as T)) return fail(`${name}을(를) 선택해 주세요.`); return value as T; }
function bool(value: unknown, fallback: boolean): boolean { if (value === undefined) return fallback; if (value !== true && value !== false) return fail("설정 값은 참 또는 거짓이어야 합니다."); return value; }
function manager(ctx: HrContext): void { if (!ctx.manager) fail("관리자 권한이 필요합니다.", "hr_forbidden", 403); }
function employee(w: HrWorkspace, id: unknown, ctx: HrContext, onDate?: string) {
  const employeeId = txt(id, "구성원");
  const e = w.employees.find((row) => row.id === employeeId);
  if (!e) return fail("구성원을 찾을 수 없습니다.", "hr_not_found", 404);
  if (!ctx.manager && ctx.employeeId !== e.id) return fail("본인의 근태만 변경할 수 있습니다.", "hr_forbidden", 403);
  if (onDate && (e.hireDate > onDate || (e.endDate && e.endDate < onDate))) return fail("재직 기간에 속하는 날짜만 등록할 수 있습니다.");
  return e;
}
function revision(row: { revision: number }, value: unknown): void { if (num(value, "버전", 0, 1_000_000_000) !== row.revision) fail("다른 작업에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.", "hr_conflict", 409); }
const addDay = (d: string, n = 1): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const stamp = (d: string, t: string): number => Date.parse(`${d}T${t}:00Z`) / 60000;
const timeMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
function period(start: unknown, end: unknown): [string, string] { const a = date(start); const b = date(end); if (b < a || Date.parse(b) - Date.parse(a) > 366 * 86400000) return fail("기간은 시작일 이후 최대 366일까지 지정할 수 있습니다."); return [a, b]; }
function range(d: string, start: string, end: string, endDate?: string): [number, number] {
  const a = stamp(d, start); const b = stamp(endDate ?? (end <= start ? addDay(d) : d), end);
  if (b <= a || b - a > 1440) return fail("한 근무는 0분 초과, 24시간 이내여야 합니다.");
  return [a, b];
}
const overlap = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1];
function datesIn(start: string, end: string): string[] { const out: string[] = []; for (let d = start; d <= end; d = addDay(d)) out.push(d); return out; }
export function isHrAttendanceLocked(state: HrAttendanceState, employeeId: string, d: string): boolean {
  return state.locks.some((l) => l.status === "locked" && l.startDate <= d && d <= l.endDate && (!l.employeeIds.length || l.employeeIds.includes(employeeId)));
}
function unlocked(state: HrAttendanceState, employeeId: string, start: string, end = start): void {
  if (datesIn(start, end).some((d) => isHrAttendanceLocked(state, employeeId, d))) fail("마감된 근태 기간입니다. 관리자가 마감을 해제해야 변경할 수 있습니다.", "hr_attendance_locked", 409);
}
export function getHrWorkPolicy(state: HrAttendanceState, employeeId: string, d: string): HrWorkPolicy | undefined {
  const assignment = state.assignments.filter((a) => a.employeeId === employeeId && a.effectiveFrom <= d).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return assignment ? state.workPolicies.find((p) => p.id === assignment.policyId) : undefined;
}
function noOverlap(state: HrAttendanceState, employeeId: string, interval: [number, number], ignoreId = ""): void {
  if (state.workEntries.some((e) => e.id !== ignoreId && e.employeeId === employeeId && ["pending", "approved"].includes(e.status) && overlap(interval, range(e.date, e.startTime, e.endTime, e.endDate)))) fail("기존 근무와 시간이 겹칩니다.", "hr_overlap", 409);
  if (state.leaveRequests.some((e) => e.id !== ignoreId && e.employeeId === employeeId && ["pending", "approved"].includes(e.status) && e.slots.some((s) => overlap(interval, [stamp(s.date, s.startTime), stamp(s.date, s.endTime)])))) fail("신청되거나 승인된 휴가와 시간이 겹칩니다.", "hr_overlap", 409);
}

export function getHrLeaveBalance(state: HrAttendanceState, employeeId: string, typeId: string, asOf: string): { availableMinutes: number; reservedMinutes: number } {
  const entries = state.leaveLedger.filter((e) => e.employeeId === employeeId && e.typeId === typeId && e.effectiveFrom <= asOf && asOf <= e.expiresOn);
  const pending = new Set(state.leaveRequests.filter((r) => r.status === "pending").map((r) => r.id));
  return { availableMinutes: entries.reduce((sum, e) => sum + e.minutes, 0), reservedMinutes: -entries.filter((e) => e.kind === "use" && pending.has(e.requestId)).reduce((sum, e) => sum + e.minutes, 0) };
}

export function getHrAttendanceTotals(w: HrWorkspace, employeeId: string, startDate: string, endDate: string): { recognizedMinutes: number; paidLeaveMinutes: number; unpaidLeaveMinutes: number; pendingCount: number; locked: boolean } {
  const [start, end] = period(startDate, endDate); const state = w.attendance;
  const works = state.workEntries.filter((e) => e.employeeId === employeeId && start <= e.date && e.date <= end);
  const leaves = state.leaveRequests.filter((e) => e.employeeId === employeeId && e.slots.some((s) => start <= s.date && s.date <= end));
  const leaveMinutes = (paid: boolean) => leaves.filter((e) => e.status === "approved" && e.paid === paid).reduce((sum, e) => sum + e.slots.filter((s) => start <= s.date && s.date <= end).reduce((s, slot) => s + slot.minutes, 0), 0);
  return { recognizedMinutes: works.filter((e) => e.status === "approved").reduce((sum, e) => sum + e.recognizedMinutes, 0), paidLeaveMinutes: leaveMinutes(true), unpaidLeaveMinutes: leaveMinutes(false), pendingCount: works.filter((e) => e.status === "pending").length + leaves.filter((e) => e.status === "pending").length, locked: datesIn(start, end).every((d) => isHrAttendanceLocked(state, employeeId, d)) };
}

export function projectHrAttendanceState(state: HrAttendanceState, ctx: HrContext): HrAttendanceState {
  const copy = structuredClone(state);
  if (ctx.manager) return copy;
  const own = (row: { employeeId: string }) => !!ctx.employeeId && row.employeeId === ctx.employeeId;
  copy.assignments = copy.assignments.filter(own); copy.workEntries = copy.workEntries.filter(own);
  copy.clockEvents = copy.clockEvents.filter(own); copy.leaveRequests = copy.leaveRequests.filter(own);
  copy.leaveLedger = copy.leaveLedger.filter(own); copy.shifts = copy.shifts.filter((row) => own(row) && row.status === "published");
  copy.locks = ctx.employeeId ? copy.locks.filter((l) => !l.employeeIds.length || l.employeeIds.includes(ctx.employeeId!)).map((l) => ({ ...l, employeeIds: [ctx.employeeId!] })) : [];
  return copy;
}

function restoreLeave(state: HrAttendanceState, request: HrLeaveRequest, ctx: HrContext): void {
  const uses = state.leaveLedger.filter((e) => e.requestId === request.id && e.kind === "use");
  for (const use of uses) {
    if (state.leaveLedger.some((e) => e.kind === "restore" && e.sourceEntryId === use.id)) continue;
    state.leaveLedger.push({ ...use, id: ctx.id(), kind: "restore", minutes: -use.minutes, sourceEntryId: use.id, at: ctx.now, actorId: ctx.actorId, note: "휴가 취소·반려에 따른 원래 부여분 복원" });
  }
}

function makeWork(w: HrWorkspace, input: Record<string, unknown>, ctx: HrContext, source: HrWorkEntry["source"], old?: HrWorkEntry): HrWorkEntry {
  const state = w.attendance; const d = date(input.date); const e = employee(w, input.employeeId, ctx, d);
  if (d > ctx.today) fail("미래 근무는 교대 일정에 등록해 주세요.");
  const start = time(input.startTime, "시작 시간"); const end = time(input.endTime, "종료 시간");
  const endDate = input.endDate ? date(input.endDate) : end <= start ? addDay(d) : d;
  employee(w, e.id, ctx, endDate); const interval = range(d, start, end, endDate); unlocked(state, e.id, d, endDate);
  const policy = getHrWorkPolicy(state, e.id, d);
  const defaultRest = (policy?.breakMinutes ?? 0) < interval[1] - interval[0] ? policy?.breakMinutes ?? 0 : 0;
  const rest = num(input.breakMinutes ?? defaultRest, "휴게 분", 0, interval[1] - interval[0]);
  let recognized = interval[1] - interval[0] - rest;
  if (policy?.kind === "fixed") {
    const scheduled = range(d, policy.startTime, policy.endTime);
    recognized = Math.max(0, Math.min(interval[1], scheduled[1]) - Math.max(interval[0], scheduled[0]) - rest);
  }
  if (input.recognizedMinutes !== undefined) { manager(ctx); recognized = num(input.recognizedMinutes, "인정 근무 분", 0, interval[1] - interval[0] - rest); }
  noOverlap(state, e.id, interval, old?.id);
  return { id: old?.id ?? ctx.id(), employeeId: e.id, date: d, endDate, startTime: start, endTime: end,
    breakMinutes: rest, recognizedMinutes: recognized, status: !ctx.manager && (source === "manual" || old) ? "pending" : policy?.requireApproval === false ? "approved" : "pending",
    source, policyId: policy?.id ?? "", note: input.note === undefined ? "" : txt(input.note, "사유", false),
    revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? ctx.now, createdBy: old?.createdBy ?? ctx.actorId,
    reviewedAt: "", reviewedBy: "", rawClockIds: old?.rawClockIds ?? [] };
}

function runAttendance(w: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  const s = w.attendance; const i = command.input;
  switch (command.type) {
    case "work.policy.create": {
      manager(ctx);
      if (!Array.isArray(i.workdays) || !i.workdays.length) fail("근무 요일을 선택해 주세요.");
      const workdays = [...new Set(i.workdays.map((v) => num(v, "근무 요일", 1, 7)))];
      const startTime = time(i.startTime); const endTime = time(i.endTime); const scheduled = range(ctx.today, startTime, endTime);
      const breakMinutes = num(i.breakMinutes, "휴게 분", 0, scheduled[1] - scheduled[0]);
      const dailyMinutes = num(i.dailyMinutes, "일 소정근로 분", 1, 1440);
      const coreStart = i.coreStart ? time(i.coreStart) : ""; const coreEnd = i.coreEnd ? time(i.coreEnd) : "";
      if (!!coreStart !== !!coreEnd || (coreStart && coreEnd <= coreStart)) fail("코어타임 시작과 종료를 확인해 주세요.");
      s.workPolicies.push({ id: ctx.id(), name: txt(i.name, "근무유형 이름"), kind: choice(i.kind, ["fixed", "staggered", "selective", "shift"], "근무유형"),
        effectiveFrom: date(i.effectiveFrom), cycle: choice(i.cycle ?? "1w", ["1w", "2w", "3w", "4w", "1m"], "근무 주기"), dailyMinutes, breakMinutes, workdays, startTime, endTime, requireApproval: bool(i.requireApproval, true), coreStart, coreEnd });
      return true;
    }
    case "work.policy.assign": {
      manager(ctx); const e = employee(w, i.employeeId, ctx); const policy = s.workPolicies.find((p) => p.id === i.policyId);
      if (!policy) fail("근무유형을 찾을 수 없습니다."); const from = date(i.effectiveFrom);
      if (from < policy.effectiveFrom) fail("근무유형 시행일 이전에 배정할 수 없습니다.");
      if (s.locks.some((l) => l.status === "locked" && l.endDate >= from && (!l.employeeIds.length || l.employeeIds.includes(e.id)))) fail("마감 기간에 영향을 주는 근무유형 배정은 변경할 수 없습니다.", "hr_attendance_locked", 409);
      if (s.assignments.some((a) => a.employeeId === e.id && a.effectiveFrom === from)) fail("같은 시행일의 근무유형 배정이 이미 있습니다.", "hr_conflict", 409);
      s.assignments.push({ id: ctx.id(), employeeId: e.id, policyId: policy.id, effectiveFrom: from }); return true;
    }
    case "work.create": { s.workEntries.push(makeWork(w, i, ctx, "manual")); return true; }
    case "work.update": {
      const old = s.workEntries.find((e) => e.id === i.id); if (!old) fail("근무 기록을 찾을 수 없습니다.");
      employee(w, old.employeeId, ctx); revision(old, i.expectedRevision); unlocked(s, old.employeeId, old.date, old.endDate);
      if (!["pending", "approved"].includes(old.status)) fail("종료된 기록은 수정할 수 없습니다.");
      if (i.employeeId !== old.employeeId) fail("기록의 구성원은 변경할 수 없습니다.");
      Object.assign(old, makeWork(w, i, ctx, old.source, old)); return true;
    }
    case "work.approve": case "work.reject": case "work.cancel": {
      const row = s.workEntries.find((e) => e.id === i.id); if (!row) fail("근무 기록을 찾을 수 없습니다.");
      employee(w, row.employeeId, ctx); revision(row, i.expectedRevision); unlocked(s, row.employeeId, row.date, row.endDate);
      if (command.type !== "work.cancel") manager(ctx);
      if (command.type === "work.cancel" ? !["pending", "approved"].includes(row.status) : row.status !== "pending") fail("현재 상태에서는 처리할 수 없습니다.", "hr_conflict", 409);
      if (command.type === "work.approve") noOverlap(s, row.employeeId, range(row.date, row.startTime, row.endTime, row.endDate), row.id);
      row.status = command.type === "work.approve" ? "approved" : command.type === "work.reject" ? "rejected" : "cancelled";
      row.revision++; row.reviewedAt = ctx.now; row.reviewedBy = ctx.actorId; return true;
    }
    case "clock.resolve": {
      manager(ctx); const e = employee(w, i.employeeId, ctx); const last = s.clockEvents.filter((r) => r.employeeId === e.id).at(-1);
      if (!last || last.kind !== "in") fail("정리할 미퇴근 기록이 없습니다.", "hr_conflict", 409);
      const d = new Date(Date.parse(last.at) + 9 * 3600000).toISOString().slice(0, 10);
      unlocked(s, e.id, d, ctx.today);
      s.clockEvents.push({ id: ctx.id(), employeeId: e.id, kind: "out", at: ctx.now, actorId: ctx.actorId, workEntryId: "", correction: true, note: txt(i.note, "미퇴근 정리 사유") });
      return true;
    }
    case "clock.in": case "clock.out": {
      const at = new Date(ctx.now); if (!Number.isFinite(at.getTime())) fail("서버 시간이 올바르지 않습니다.");
      const local = new Date(at.getTime() + 9 * 3600000).toISOString(); const d = local.slice(0, 10); const t = local.slice(11, 16);
      const e = employee(w, i.employeeId, ctx, d); unlocked(s, e.id, d);
      const location = ctx.manager ? undefined : verifyHrClockLocation(w.settings.clockLocation, i.location, ctx.now);
      const last = s.clockEvents.filter((r) => r.employeeId === e.id).at(-1);
      if (command.type === "clock.in") {
        if (last?.kind === "in") fail("이미 출근 상태입니다.", "hr_conflict", 409);
        if (s.leaveRequests.some((r) => r.employeeId === e.id && ["pending", "approved"].includes(r.status) && r.slots.some((slot) => slot.date === d && slot.startTime <= t && t < slot.endTime))) fail("휴가 시간에는 출근할 수 없습니다.", "hr_overlap", 409);
        s.clockEvents.push({ id: ctx.id(), employeeId: e.id, kind: "in", at: ctx.now, actorId: ctx.actorId, workEntryId: "", ...(location ? { location } : {}) }); return true;
      }
      if (!last || last.kind !== "in") fail("출근 기록이 없습니다.", "hr_conflict", 409);
      const beginning = new Date(Date.parse(last.at) + 9 * 3600000).toISOString();
      const elapsed = Math.floor((at.getTime() - Date.parse(last.at)) / 60000);
      if (elapsed < 0) fail("퇴근 시각이 출근 시각보다 빠릅니다.");
      if (beginning.slice(0, 16) === local.slice(0, 16)) {
        s.clockEvents.push({ id: ctx.id(), employeeId: e.id, kind: "out", at: ctx.now, actorId: ctx.actorId, workEntryId: "", ...(location ? { location } : {}) }); return true;
      }
      const work = makeWork(w, { employeeId: e.id, date: beginning.slice(0, 10), startTime: beginning.slice(11, 16), endDate: d, endTime: t }, ctx, "clock");
      work.recognizedMinutes = Math.min(work.recognizedMinutes, Math.max(0, elapsed - work.breakMinutes));
      const out: HrClockEvent = { id: ctx.id(), employeeId: e.id, kind: "out", at: ctx.now, actorId: ctx.actorId, workEntryId: work.id, ...(location ? { location } : {}) };
      work.rawClockIds = [last.id, out.id]; s.clockEvents.push(out); s.workEntries.push(work); return true;
    }
    case "leave.type.create": {
      manager(ctx); s.leaveTypes.push({ id: ctx.id(), name: txt(i.name, "휴가 이름"), paid: bool(i.paid, true), deductBalance: bool(i.deductBalance, true), unitMinutes: num(i.unitMinutes, "사용 단위 분", 1, 480), requireApproval: bool(i.requireApproval, true) }); return true;
    }
    case "leave.grant": {
      manager(ctx); const e = employee(w, i.employeeId, ctx); const type = s.leaveTypes.find((t) => t.id === i.typeId);
      if (!type || !type.deductBalance) fail("잔액을 관리하는 휴가 종류를 선택해 주세요.");
      const from = date(i.effectiveFrom); const expiry = date(i.expiresOn); if (expiry < from) fail("만료일은 부여일 이후여야 합니다.");
      unlocked(s, e.id, from); const minutes = num(i.minutes, "부여 분", 1, 1_000_000); const id = ctx.id();
      s.leaveLedger.push({ id, employeeId: e.id, typeId: type.id, lotId: id, requestId: "", kind: "grant", minutes, effectiveFrom: from, expiresOn: expiry, sourceEntryId: "", note: txt(i.note ?? "", "부여 사유", false), at: ctx.now, actorId: ctx.actorId }); return true;
    }
    case "leave.request": {
      const [start, end] = period(i.startDate, i.endDate); const e = employee(w, i.employeeId, ctx, start); employee(w, e.id, ctx, end); unlocked(s, e.id, start, end);
      const type = s.leaveTypes.find((t) => t.id === i.typeId); if (!type) fail("휴가 종류를 찾을 수 없습니다.");
      const startTime = time(i.startTime ?? "09:00"); const endTime = time(i.endTime ?? "18:00");
      if (endTime <= startTime) fail("휴가는 같은 날의 시작·종료 시간을 지정해 주세요.");
      const minutes = num(i.minutesPerDay, "하루 사용 분", 1, timeMinutes(endTime) - timeMinutes(startTime));
      if (minutes % type.unitMinutes !== 0) fail(`휴가는 ${type.unitMinutes}분 단위로 사용할 수 있습니다.`);
      const slots: HrLeaveSlot[] = [];
      for (const d of datesIn(start, end)) {
        const policy = getHrWorkPolicy(s, e.id, d); const weekday = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
        const shift = s.shifts.find((row) => row.employeeId === e.id && row.date === d && row.status === "published");
        if (s.holidays.includes(d) || (shift ? shift.kind === "off" : !(policy?.workdays ?? [1, 2, 3, 4, 5]).includes(weekday))) continue;
        if (minutes > (policy?.dailyMinutes ?? 480)) fail("하루 휴가 사용량은 적용 근무유형의 소정근로시간을 초과할 수 없습니다.");
        const span = timeMinutes(endTime) - timeMinutes(startTime);
        if (minutes < span - (shift?.breakMinutes ?? policy?.breakMinutes ?? 60)) fail("휴가 시간에서 휴게시간을 제외한 사용 분을 입력해 주세요.");
        const scheduledStart = shift?.startTime ?? policy?.startTime ?? "09:00";
        const scheduledEnd = shift?.endTime ?? policy?.endTime ?? "18:00";
        if (scheduledStart < scheduledEnd && (startTime < scheduledStart || endTime > scheduledEnd)) fail("휴가 시간은 적용 근무일의 근무 시간 안에서 지정해 주세요.");
        const existingLeave = s.leaveRequests.filter((r) => r.employeeId === e.id && ["pending", "approved"].includes(r.status)).flatMap((r) => r.slots).filter((slot) => slot.date === d).reduce((sum, slot) => sum + slot.minutes, 0);
        if (existingLeave + minutes > (policy?.dailyMinutes ?? 480)) fail("같은 날 신청한 휴가를 합하면 소정근로시간을 초과합니다.");
        noOverlap(s, e.id, [stamp(d, startTime), stamp(d, endTime)]);
        slots.push({ date: d, startTime, endTime, minutes });
      }
      if (!slots.length) fail("선택한 기간에 휴가를 사용할 근무일이 없습니다.");
      const request: HrLeaveRequest = { id: ctx.id(), employeeId: e.id, typeId: type.id, startDate: start, endDate: end, slots, minutes: minutes * slots.length, paid: type.paid, note: txt(i.note ?? "", "휴가 사유", false), status: type.requireApproval ? "pending" : "approved", revision: 1, createdAt: ctx.now, createdBy: ctx.actorId, reviewedAt: "", reviewedBy: "" };
      if (type.deductBalance) {
        for (const slot of slots) {
          let remaining = slot.minutes;
          const grants = s.leaveLedger.filter((l) => l.employeeId === e.id && l.typeId === type.id && l.kind === "grant" && l.effectiveFrom <= slot.date && slot.date <= l.expiresOn).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.effectiveFrom.localeCompare(b.effectiveFrom) || a.id.localeCompare(b.id));
          for (const grant of grants) {
            const balance = s.leaveLedger.filter((l) => l.lotId === grant.lotId).reduce((sum, l) => sum + l.minutes, 0);
            const used = Math.min(remaining, Math.max(0, balance)); if (!used) continue;
            s.leaveLedger.push({ ...grant, id: ctx.id(), requestId: request.id, kind: "use", minutes: -used, sourceEntryId: grant.id, note: `${slot.date} 휴가 예약`, at: ctx.now, actorId: ctx.actorId }); remaining -= used;
            if (!remaining) break;
          }
          if (remaining) fail(`${slot.date}에 사용할 휴가 잔액이 부족합니다. 대기 중인 신청도 잔액을 예약합니다.`, "hr_leave_balance", 409);
        }
      }
      s.leaveRequests.push(request); return true;
    }
    case "leave.approve": case "leave.reject": case "leave.cancel": {
      const row = s.leaveRequests.find((r) => r.id === i.id); if (!row) fail("휴가 신청을 찾을 수 없습니다."); employee(w, row.employeeId, ctx);
      revision(row, i.expectedRevision); unlocked(s, row.employeeId, row.startDate, row.endDate);
      if (command.type !== "leave.cancel") manager(ctx);
      if (command.type === "leave.cancel" ? !["pending", "approved"].includes(row.status) : row.status !== "pending") fail("현재 상태에서는 처리할 수 없습니다.", "hr_conflict", 409);
      if (command.type === "leave.approve") for (const slot of row.slots) noOverlap(s, row.employeeId, [stamp(slot.date, slot.startTime), stamp(slot.date, slot.endTime)], row.id);
      else restoreLeave(s, row, ctx);
      row.status = command.type === "leave.approve" ? "approved" : command.type === "leave.reject" ? "rejected" : "cancelled";
      row.revision++; row.reviewedAt = ctx.now; row.reviewedBy = ctx.actorId; return true;
    }
    case "shift.template.create": {
      manager(ctx); const kind = choice(i.kind, ["work", "off"], "교대 구분"); const startTime = time(i.startTime ?? "09:00"); const endTime = time(i.endTime ?? "18:00");
      const duration = range(ctx.today, startTime, endTime); const breakMinutes = num(i.breakMinutes ?? 0, "휴게 분", 0, duration[1] - duration[0]);
      s.shiftTemplates.push({ id: ctx.id(), name: txt(i.name, "교대 이름"), startTime, endTime, breakMinutes, kind }); return true;
    }
    case "shift.save": {
      manager(ctx); const d = date(i.date); const e = employee(w, i.employeeId, ctx, d); unlocked(s, e.id, d);
      const template = s.shiftTemplates.find((t) => t.id === i.templateId); if (!template) fail("교대 템플릿을 선택해 주세요.");
      const endDate = template.kind === "work" && template.endTime <= template.startTime ? addDay(d) : d;
      unlocked(s, e.id, d, endDate); employee(w, e.id, ctx, endDate);
      const old = i.id ? s.shifts.find((row) => row.id === i.id) : undefined;
      if (i.id && !old) fail("교대 일정을 찾을 수 없습니다.");
      if (old) { revision(old, i.expectedRevision); unlocked(s, old.employeeId, old.date, old.kind === "work" && old.endTime <= old.startTime ? addDay(old.date) : old.date); if (old.status !== "draft") fail("발행된 일정은 취소 후 새로 배정해 주세요."); }
      if (s.shifts.some((row) => row.id !== old?.id && row.employeeId === e.id && row.date === d && row.status !== "cancelled")) fail("같은 날짜에 교대 일정이 이미 있습니다.", "hr_overlap", 409);
      const row: HrShift = { id: old?.id ?? ctx.id(), employeeId: e.id, date: d, templateId: template.id, startTime: template.startTime, endTime: template.endTime, breakMinutes: template.breakMinutes, kind: template.kind, status: "draft", revision: (old?.revision ?? 0) + 1, publishedAt: "", note: txt(i.note ?? "", "메모", false) };
      if (old) Object.assign(old, row); else s.shifts.push(row); return true;
    }
    case "shift.publish": {
      manager(ctx); if (!Array.isArray(i.ids) || !i.ids.length || i.ids.length > 500) fail("발행할 교대 일정을 선택해 주세요.");
      const ids = [...new Set(i.ids.map((id) => txt(id, "일정")))]; const revisions = i.revisions as Record<string, unknown> | undefined;
      if (!revisions || typeof revisions !== "object") fail("일정 버전 정보가 필요합니다.");
      const rows = ids.map((id) => { const row = s.shifts.find((r) => r.id === id); if (!row) return fail("교대 일정을 찾을 수 없습니다."); revision(row, revisions[id]); if (row.status !== "draft") fail("초안 일정만 발행할 수 있습니다.", "hr_conflict", 409); employee(w, row.employeeId, ctx, row.date); unlocked(s, row.employeeId, row.date, row.kind === "work" && row.endTime <= row.startTime ? addDay(row.date) : row.date); return row; });
      for (const row of rows) {
        if (row.kind === "work") {
          const interval = range(row.date, row.startTime, row.endTime);
          if (s.shifts.some((other) => other.id !== row.id && other.employeeId === row.employeeId && other.kind === "work" && (other.status === "published" || ids.includes(other.id)) && overlap(interval, range(other.date, other.startTime, other.endTime)))) fail("다른 교대 일정과 시간이 겹칩니다.", "hr_overlap", 409);
        }
      }
      for (const row of rows) { row.status = "published"; row.revision++; row.publishedAt = ctx.now; } return true;
    }
    case "shift.cancel": {
      manager(ctx); const row = s.shifts.find((r) => r.id === i.id); if (!row) fail("교대 일정을 찾을 수 없습니다."); revision(row, i.expectedRevision); unlocked(s, row.employeeId, row.date, row.kind === "work" && row.endTime <= row.startTime ? addDay(row.date) : row.date);
      if (row.status === "cancelled") fail("이미 취소된 교대 일정입니다.", "hr_conflict", 409); row.status = "cancelled"; row.revision++; return true;
    }
    case "attendance.lock": {
      manager(ctx); const [start, end] = period(i.startDate, i.endDate); if (end > ctx.today) fail("미래 근태는 마감할 수 없습니다.");
      if (!Array.isArray(i.employeeIds)) fail("마감 대상을 확인해 주세요."); const ids = [...new Set(i.employeeIds.map((id) => employee(w, id, ctx).id))];
      const targets = ids.length ? ids : w.employees.map((e) => e.id);
      for (const employeeId of targets) {
        if (s.workEntries.some((r) => r.employeeId === employeeId && r.date <= end && r.endDate >= start && r.status === "pending") || s.leaveRequests.some((r) => r.employeeId === employeeId && r.status === "pending" && r.slots.some((slot) => start <= slot.date && slot.date <= end))) fail("대기 중인 근무·휴가를 처리한 후 마감해 주세요.", "hr_pending", 409);
        const clock = s.clockEvents.filter((r) => r.employeeId === employeeId).at(-1);
        if (clock?.kind === "in" && new Date(Date.parse(clock.at) + 9 * 3600000).toISOString().slice(0, 10) <= end) fail("퇴근하지 않은 출근 기록을 처리한 후 마감해 주세요.", "hr_pending", 409);
        if (s.locks.some((l) => l.status === "locked" && l.startDate <= end && start <= l.endDate && (!l.employeeIds.length || l.employeeIds.includes(employeeId)))) fail("이미 마감된 기간과 겹칩니다.", "hr_attendance_locked", 409);
      }
      s.locks.push({ id: ctx.id(), startDate: start, endDate: end, employeeIds: ids, status: "locked", revision: 1, at: ctx.now, actorId: ctx.actorId, reason: txt(i.reason, "마감 사유") }); return true;
    }
    case "attendance.unlock": {
      manager(ctx); const row = s.locks.find((l) => l.id === i.id); if (!row) fail("마감 기록을 찾을 수 없습니다."); revision(row, i.expectedRevision); if (row.status !== "locked") fail("이미 해제된 마감입니다.", "hr_conflict", 409);
      // A finalized payroll snapshot must be reopened by the payroll workflow first.
      if (w.payroll.runs.some((run) => ["locked", "published"].includes(run.status) && run.month >= row.startDate.slice(0, 7) && run.month <= row.endDate.slice(0, 7) && run.rows.some((e) => !row.employeeIds.length || row.employeeIds.includes(e.employeeId)))) fail("확정된 급여 기간입니다. 급여 확정을 먼저 해제해 주세요.", "hr_payroll_locked", 409);
      row.reason = txt(i.reason, "마감 해제 사유"); row.status = "reopened"; row.revision++; row.at = ctx.now; row.actorId = ctx.actorId; return true;
    }
    case "attendance.holidays.set": {
      manager(ctx); if (!Array.isArray(i.dates) || i.dates.length > 730) fail("휴일 목록을 확인해 주세요.");
      const holidays = [...new Set(i.dates.map((d) => date(d)))].sort(); const changed = [...holidays.filter((d) => !s.holidays.includes(d)), ...s.holidays.filter((d) => !holidays.includes(d))];
      if (changed.some((d) => s.locks.some((l) => l.status === "locked" && l.startDate <= d && d <= l.endDate))) fail("마감 기간의 휴일은 변경할 수 없습니다.", "hr_attendance_locked", 409);
      s.holidays = holidays; return true;
    }
    default: return false;
  }
}

/** Mutations commit atomically: multi-day reservation and bulk publishing never leave partial rows on failure. */
export function applyHrAttendanceCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  if (!/^(work|clock|shift|leave|attendance)\./.test(command.type)) return false;
  const draft = { ...workspace, attendance: structuredClone(workspace.attendance) };
  const handled = runAttendance(draft, command, ctx);
  if (handled) workspace.attendance = draft.attendance;
  return handled;
}
