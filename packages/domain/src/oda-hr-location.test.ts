import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from './errors.ts';
import { applyHrCommand, createHrWorkspace, projectHrWorkspace, type HrContext } from './oda-hr.ts';
import { createHrClockLocation, hrHaversineDistanceMeters, verifyHrClockLocation } from './oda-hr-location.ts';

function fixture() {
  let n = 0;
  const manager: HrContext = { actorId: 'owner', manager: true, payroll: true, today: '2026-09-15', now: '2026-09-15T00:00:00.000Z', id: () => `geo-${++n}` };
  const staff: HrContext = { ...manager, actorId: 'staff-a', employeeId: 'a', manager: false, payroll: false };
  const workspace = createHrWorkspace('store-a', '테스트 매장', manager.now);
  workspace.employees = ['a', 'b'].map(id => ({ id, actorId: `staff-${id}`, employeeNumber: id, name: `직원 ${id}`, departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'hourly', basePay: 12000, history: [] }));
  const input = { address: '테스트 매장 주소', latitude: 0, longitude: 0 };
  const position = { latitude: 0, longitude: 0, accuracy: 20, timestamp: Date.parse(manager.now) };
  const run = (type: string, data: Record<string, unknown>, ctx = manager) => applyHrCommand(workspace, { type, input: data }, ctx);
  const setLocation = () => run('attendance.location.set', input);
  const policy = () => {
    run('work.policy.create', { name: '자동 승인 근무', kind: 'fixed', cycle: '1w', effectiveFrom: '2026-01-01', dailyMinutes: 480, breakMinutes: 60, workdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00', requireApproval: false });
    run('work.policy.assign', { employeeId: 'a', policyId: workspace.attendance.workPolicies[0]!.id, effectiveFrom: '2026-01-01' });
  };
  return { workspace, manager, staff, input, position, run, setLocation, policy };
}
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;

test('매장 위치는 관리자만 설정하고 반경과 기록자는 서버가 고정한다', () => {
  const { workspace, manager, staff, input, run } = fixture();
  assert.throws(() => run('attendance.location.set', input, staff), code('HR_FORBIDDEN'));
  assert.throws(() => run('attendance.location.set', { ...input, radiusMeters: 5000 }), code('HR_CLOCK_LOCATION_INVALID'));
  assert.throws(() => run('settings.update', { clockLocation: { ...input, radiusMeters: 5000 } }));
  assert.equal(workspace.version, 0); assert.equal(workspace.settings.clockLocation, undefined);
  run('attendance.location.set', input);
  assert.deepEqual(workspace.settings.clockLocation, { ...input, radiusMeters: 200, updatedAt: manager.now, updatedBy: manager.actorId });
  assert.equal(workspace.version, 1);
});

test('NaN·무한대·문자 좌표·범위 밖 좌표와 빈 매장 주소를 거절한다', () => {
  const { manager, input, position } = fixture(); const setting = createHrClockLocation(input, manager);
  for (const value of [NaN, Infinity, -Infinity, '0', null, 90.1, -90.1]) {
    assert.throws(() => createHrClockLocation({ ...input, latitude: value }, manager), code('HR_CLOCK_LOCATION_INVALID'));
    assert.throws(() => verifyHrClockLocation(setting, { ...position, latitude: value }, manager.now), code('HR_CLOCK_LOCATION_INVALID'));
  }
  for (const longitude of [180.1, -180.1]) assert.throws(() => verifyHrClockLocation(setting, { ...position, longitude }, manager.now), code('HR_CLOCK_LOCATION_INVALID'));
  assert.throws(() => createHrClockLocation({ ...input, address: '   ' }, manager), code('HR_CLOCK_LOCATION_INVALID'));
  assert.throws(() => verifyHrClockLocation(setting, { ...position, radiusMeters: 10000 }, manager.now), code('HR_CLOCK_LOCATION_INVALID'));
});

test('현재 위치 시각은 60초 과거·10초 미래까지 허용하고 경계 초과는 거절한다', () => {
  const { manager, input, position } = fixture(); const setting = createHrClockLocation(input, manager);
  for (const offset of [-60_000, 10_000]) assert.equal(verifyHrClockLocation(setting, { ...position, timestamp: position.timestamp + offset }, manager.now).verifiedAt, manager.now);
  for (const offset of [-60_001, 10_001]) assert.throws(() => verifyHrClockLocation(setting, { ...position, timestamp: position.timestamp + offset }, manager.now), code('HR_CLOCK_LOCATION_STALE'));
  for (const timestamp of [NaN, Infinity, '2026-09-15', -1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => verifyHrClockLocation(setting, { ...position, timestamp }, manager.now), code('HR_CLOCK_LOCATION_INVALID'));
});

test('오차 0~50m 경계와 거리+오차 200m를 검증하여 반경 경계의 불확실성을 차단한다', () => {
  const { manager, input, position } = fixture(); const setting = createHrClockLocation(input, manager);
  for (const accuracy of [0, -1, 50.01, NaN, Infinity, '20']) assert.throws(() => verifyHrClockLocation(setting, { ...position, accuracy }, manager.now), code('HR_CLOCK_LOCATION_ACCURACY'));
  const north = (meters: number) => ({ ...position, latitude: meters / 6_371_000 * 180 / Math.PI });
  const edge = verifyHrClockLocation(setting, { ...north(150), accuracy: 50 }, manager.now);
  assert.ok(Math.abs(edge.distanceMeters - 150) < 0.000001);
  assert.throws(() => verifyHrClockLocation(setting, { ...north(150.01), accuracy: 50 }, manager.now), code('HR_CLOCK_LOCATION_OUTSIDE'));
  assert.throws(() => verifyHrClockLocation(setting, { ...north(189), accuracy: 20 }, manager.now), code('HR_CLOCK_LOCATION_OUTSIDE'));
  assert.ok(verifyHrClockLocation(setting, { ...north(149), accuracy: 50 }, manager.now).distanceMeters < 150);
});

test('구면 거리는 날짜변경선·반대편 좌표에서도 유한하고 최단 호를 계산한다', () => {
  assert.ok(Math.abs(hrHaversineDistanceMeters({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 }) - 222.38985) < 0.01);
  assert.ok(Number.isFinite(hrHaversineDistanceMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 180 })));
  assert.equal(hrHaversineDistanceMeters({ latitude: 37, longitude: 127 }, { latitude: 37, longitude: 127 }), 0);
});

test('일반 직원 출근과 퇴근에 모두 위치를 요구하고 실패 시 원장·버전은 변하지 않는다', () => {
  const { workspace, staff, position, run, setLocation } = fixture();
  assert.throws(() => run('clock.in', { employeeId: 'a', location: position }, staff), code('HR_CLOCK_LOCATION_NOT_CONFIGURED'));
  setLocation(); const before = structuredClone(workspace);
  assert.throws(() => run('clock.in', { employeeId: 'a' }, staff), code('HR_CLOCK_LOCATION_REQUIRED')); assert.deepEqual(workspace, before);
  run('clock.in', { employeeId: 'a', location: position }, staff);
  const afterIn = structuredClone(workspace); const later = { ...staff, now: '2026-09-15T09:00:00.000Z' };
  assert.throws(() => run('clock.out', { employeeId: 'a' }, later), code('HR_CLOCK_LOCATION_REQUIRED')); assert.deepEqual(workspace, afterIn);
  assert.throws(() => run('clock.out', { employeeId: 'a', location: position }, later), code('HR_CLOCK_LOCATION_STALE')); assert.deepEqual(workspace, afterIn);
  run('clock.out', { employeeId: 'a', location: { ...position, timestamp: Date.parse(later.now) } }, later);
  assert.equal(workspace.attendance.clockEvents.length, 2); assert.equal(workspace.attendance.workEntries.length, 1);
});

test('타각에는 직원 좌표 대신 검증 증빙만 보존하고 매장 기준 변경 후에도 과거 증빙을 유지한다', () => {
  const { workspace, staff, manager, input, position, run, setLocation } = fixture(); setLocation();
  run('clock.in', { employeeId: 'a', location: { ...position, latitude: 0.000123 } }, staff);
  const original = structuredClone(workspace.attendance.clockEvents[0]!);
  assert.deepEqual(Object.keys(original.location!).sort(), ['accuracyMeters', 'distanceMeters', 'locationUpdatedAt', 'radiusMeters', 'verifiedAt'].sort());
  assert.equal(original.location!.locationUpdatedAt, manager.now);
  assert.equal(JSON.stringify(workspace.attendance.clockEvents).includes('latitude'), false);
  assert.equal(JSON.stringify(workspace.attendance.clockEvents).includes('longitude'), false);
  assert.equal(JSON.stringify(workspace.history).includes('0.000123'), false);
  run('attendance.location.set', { ...input, longitude: 1 }, { ...manager, now: '2026-09-15T01:00:00.000Z' });
  assert.deepEqual(workspace.attendance.clockEvents[0], original);
  assert.throws(() => run('clock.out', { employeeId: 'a', location: { ...position, timestamp: Date.parse('2026-09-15T01:00:00.000Z') } }, { ...staff, now: '2026-09-15T01:00:00.000Z' }), code('HR_CLOCK_LOCATION_OUTSIDE'));
});

test('1분 미만 출퇴근에서도 양쪽 검증 증빙을 보존한다', () => {
  const { workspace, staff, position, run, setLocation } = fixture(); setLocation();
  run('clock.in', { employeeId: 'a', location: position }, staff);
  const later = { ...staff, now: '2026-09-15T00:00:20.000Z' };
  run('clock.out', { employeeId: 'a', location: { ...position, timestamp: Date.parse(later.now) } }, later);
  assert.equal(workspace.attendance.workEntries.length, 0); assert.equal(workspace.attendance.clockEvents.filter(row => !!row.location).length, 2);
});

test('직원 수동 근무와 기존 타각의 수정은 자동 승인 정책에서도 관리자 승인 대기다', () => {
  const { workspace, staff, position, run, setLocation, policy } = fixture(); policy(); setLocation();
  run('work.create', { employeeId: 'a', date: '2026-09-14', startTime: '09:00', endTime: '18:00', breakMinutes: 60 }, staff);
  let manual = workspace.attendance.workEntries[0]!; assert.equal(manual.status, 'pending');
  run('work.approve', { id: manual.id, expectedRevision: manual.revision }); manual = workspace.attendance.workEntries[0]!;
  run('work.update', { id: manual.id, expectedRevision: manual.revision, employeeId: 'a', date: '2026-09-14', startTime: '10:00', endTime: '18:00', breakMinutes: 60 }, staff);
  assert.equal(workspace.attendance.workEntries[0]!.status, 'pending');
  run('clock.in', { employeeId: 'a', location: position }, staff);
  const later = { ...staff, now: '2026-09-15T09:00:00.000Z' };
  run('clock.out', { employeeId: 'a', location: { ...position, timestamp: Date.parse(later.now) } }, later);
  const clock = workspace.attendance.workEntries[1]!; assert.equal(clock.status, 'approved'); const raw = structuredClone(workspace.attendance.clockEvents);
  run('work.update', { id: clock.id, expectedRevision: clock.revision, employeeId: 'a', date: clock.date, startTime: '09:00', endTime: '17:00', breakMinutes: 60 }, later);
  assert.equal(workspace.attendance.workEntries[1]!.status, 'pending'); assert.deepEqual(workspace.attendance.clockEvents, raw);
});

test('관리자 수동 타각·미퇴근 정리 예외와 직원의 타인 기록 접근 차단을 유지한다', () => {
  const { workspace, manager, staff, position, run, setLocation } = fixture();
  run('clock.in', { employeeId: 'a' }, manager);
  run('clock.resolve', { employeeId: 'a', note: '퇴근 누락 확인' }, manager);
  assert.equal(workspace.attendance.clockEvents[1]!.correction, true); assert.equal(workspace.attendance.clockEvents[0]!.location, undefined);
  setLocation(); assert.throws(() => run('clock.in', { employeeId: 'b', location: position }, staff), code('hr_forbidden'));
});

test('직원 팀 근무표는 게시된 일정의 허용 필드만 제공하고 본인 상세 투영은 유지한다', () => {
  const { workspace, manager, staff } = fixture();
  for (const [id, employeeId, status] of [['own', 'a', 'published'], ['team', 'b', 'published'], ['draft', 'b', 'draft'], ['cancelled', 'b', 'cancelled']] as const) {
    workspace.attendance.shifts.push({ id, employeeId, status, date: '2026-09-15', templateId: 'private-template', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work', revision: 1, publishedAt: manager.now, note: `${id} 내부 메모` });
  }
  const projected = projectHrWorkspace(workspace, staff);
  assert.deepEqual(projected.storeSchedule!.map(row => row.id), ['own', 'team']);
  assert.deepEqual(projected.storeSchedule!.map(row => row.employeeName), ['직원 a', '직원 b']);
  for (const row of projected.storeSchedule!) assert.deepEqual(Object.keys(row).sort(), ['id', 'employeeId', 'employeeName', 'date', 'startTime', 'endTime', 'breakMinutes', 'kind'].sort());
  assert.deepEqual(projected.workspace.attendance.shifts.map(row => row.id), ['own']);
  assert.equal(JSON.stringify(projected).includes('team 내부 메모'), false);
  assert.equal(JSON.stringify(projected).includes('draft 내부 메모'), false);
  assert.equal(projectHrWorkspace(workspace, { ...manager, manager: false, payroll: false }).storeSchedule, undefined);
});
