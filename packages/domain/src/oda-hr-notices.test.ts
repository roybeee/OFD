import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from './errors.ts';
import { applyHrCommand, createHrWorkspace, projectHrWorkspace, type HrContext } from './oda-hr.ts';

function fixture() {
  let sequence = 0;
  const manager: HrContext = { actorId: 'manager', manager: true, payroll: true, today: '2026-09-16', now: '2026-09-16T01:00:00.000Z', id: () => `notice-${++sequence}` };
  const staff: HrContext = { ...manager, actorId: 'staff-a', employeeId: 'a', manager: false, payroll: false };
  const colleague: HrContext = { ...staff, actorId: 'staff-b', employeeId: 'b' };
  const workspace = createHrWorkspace('store-a', '테스트 매장', manager.now);
  workspace.employees = ['a', 'b'].map(id => ({ id, actorId: `staff-${id}`, employeeNumber: id, name: `테스트 ${id}`, departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'hourly', basePay: 0, history: [] }));
  const run = (type: string, input: Record<string, unknown>, context = manager) => applyHrCommand(workspace, { type, input }, context);
  run('notice.create', { title: '매장 안내', body: '새 운영 안내를 확인해 주세요.', status: 'published', pinned: true });
  const notice = workspace.notices[0]!;
  const acknowledge = (context = staff, updatedAt = notice.updatedAt) => run('notice.acknowledge', { id: notice.id, updatedAt }, context);
  return { workspace, manager, staff, colleague, run, notice, acknowledge };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('기존 공지는 미확인 상태이며 확인 기록의 소유자와 시각을 서버 문맥에서 정한다', () => {
  const { workspace, staff, notice, acknowledge } = fixture();
  assert.equal(notice.receipts, undefined);
  const publishedAt = notice.updatedAt;
  acknowledge();
  assert.deepEqual(notice.receipts, [{ actorId: staff.actorId, employeeId: staff.employeeId, noticeUpdatedAt: publishedAt, acknowledgedAt: staff.now }]);
  assert.equal(notice.updatedAt, publishedAt);
  assert.equal(workspace.version, 2);
  assert.equal(projectHrWorkspace(JSON.parse(JSON.stringify(workspace)), staff).workspace.notices[0]!.receipts!.length, 1);
});

test('본문을 열거나 조회해도 확인되지 않고 동일한 판본 재확인은 최초 확인 기록을 보존한다', () => {
  const { workspace, staff, notice, acknowledge } = fixture();
  const before = structuredClone(workspace);
  projectHrWorkspace(workspace, staff);
  assert.deepEqual(workspace, before);
  acknowledge();
  const original = structuredClone(notice.receipts);
  acknowledge({ ...staff, now: '2026-09-16T02:00:00.000Z' });
  assert.deepEqual(notice.receipts, original);
});

test('클라이언트 소유자·직원·확인 시각·목록 주입을 거절하고 상태를 변경하지 않는다', () => {
  const { workspace, staff, notice, run } = fixture();
  for (const field of ['actorId', 'employeeId', 'acknowledgedAt', 'receipts']) {
    const before = structuredClone(workspace);
    assert.throws(() => run('notice.acknowledge', { id: notice.id, updatedAt: notice.updatedAt, [field]: 'forged' }, staff), code('HR_VALIDATION'));
    assert.deepEqual(workspace, before);
  }
  assert.throws(() => run('notice.update', { id: notice.id, title: '변조', body: '변조', status: 'published' }, staff), code('HR_FORBIDDEN'));
});

test('편집은 같은 밀리초에도 새 판본을 만들고 이전 판본 확인 요청은 거절한다', () => {
  const { workspace, staff, manager, notice, run, acknowledge } = fixture();
  acknowledge(); const originalRevision = notice.updatedAt;
  run('notice.update', { id: notice.id, title: notice.title, body: '변경한 공지 본문', pinned: true, status: 'published' });
  assert.notEqual(notice.updatedAt, originalRevision);
  assert.equal(Date.parse(notice.updatedAt), Date.parse(manager.now) + 1);
  assert.equal(notice.receipts?.some(receipt => receipt.noticeUpdatedAt === notice.updatedAt), false);
  const before = structuredClone(workspace);
  assert.throws(() => acknowledge(staff, originalRevision), code('HR_NOTICE_CHANGED'));
  assert.deepEqual(workspace, before);
  acknowledge({ ...staff, now: '2026-09-16T02:00:00.000Z' });
  assert.equal(notice.receipts?.length, 1);
  assert.equal(notice.receipts?.[0]?.noticeUpdatedAt, notice.updatedAt);
  assert.equal(notice.receipts?.[0]?.acknowledgedAt, '2026-09-16T02:00:00.000Z');
});

test('게시 중단·보관·다른 매장·존재하지 않는 공지는 확인할 수 없다', () => {
  const { workspace, staff, notice, run, acknowledge } = fixture();
  acknowledge();
  run('notice.update', { id: notice.id, title: notice.title, body: notice.body, status: 'draft' });
  assert.throws(() => acknowledge(), code('HR_NOTICE_NOT_FOUND'));
  assert.equal(projectHrWorkspace(workspace, staff).workspace.notices.length, 0);
  run('notice.update', { id: notice.id, title: notice.title, body: notice.body, status: 'published' });
  assert.equal(notice.receipts?.some(receipt => receipt.noticeUpdatedAt === notice.updatedAt), false);
  run('notice.archive', { id: notice.id });
  assert.throws(() => acknowledge(), code('HR_NOTICE_NOT_FOUND'));
  assert.throws(() => run('notice.acknowledge', { id: 'missing', updatedAt: notice.updatedAt }, staff), code('HR_NOTICE_NOT_FOUND'));
  const otherStore = createHrWorkspace('store-b', '다른 매장', staff.now);
  assert.throws(() => applyHrCommand(otherStore, { type: 'notice.acknowledge', input: { id: notice.id, updatedAt: notice.updatedAt } }, staff), code('HR_NOTICE_NOT_FOUND'));
  assert.equal(otherStore.version, 0);
});

test('직원·급여 담당자는 본인 확인 기록만 보며 관리자만 매장 확인 내역을 조회한다', () => {
  const { workspace, staff, colleague, manager, notice, acknowledge } = fixture();
  acknowledge(staff); acknowledge(colleague); acknowledge(manager);
  assert.equal(notice.receipts?.length, 3);
  assert.deepEqual(projectHrWorkspace(workspace, staff).workspace.notices[0]?.receipts?.map(row => row.actorId), [staff.actorId]);
  assert.deepEqual(projectHrWorkspace(workspace, colleague).workspace.notices[0]?.receipts?.map(row => row.actorId), [colleague.actorId]);
  const finance = { ...manager, actorId: 'finance', manager: false };
  assert.deepEqual(projectHrWorkspace(workspace, finance).workspace.notices[0]?.receipts, []);
  assert.equal(projectHrWorkspace(workspace, manager).workspace.notices[0]?.receipts?.length, 3);
  assert.equal(notice.receipts?.length, 3);
});

test('직원 연결 없는 계정과 퇴직자는 확인할 수 없고 관리자 대리 확인도 입력으로 허용하지 않는다', () => {
  const { workspace, staff, manager, notice, run, acknowledge } = fixture();
  assert.throws(() => acknowledge({ ...manager, actorId: 'auditor', manager: false, payroll: false }), code('HR_FORBIDDEN'));
  assert.throws(() => acknowledge({ ...manager, actorId: 'finance', manager: false }), code('HR_FORBIDDEN'));
  workspace.employees[0]!.status = 'retired';
  assert.throws(() => acknowledge(staff), code('HR_EMPLOYEE_NOT_FOUND'));
  assert.throws(() => run('notice.acknowledge', { id: notice.id, updatedAt: notice.updatedAt, actorId: staff.actorId }), code('HR_VALIDATION'));
  assert.equal(notice.receipts, undefined);
});
