import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from './errors.ts';
import { applyHrTalentCommand, createHrTalentState, projectHrTalentState } from './oda-hr-talent.ts';
import type { HrContext, HrEmployee, HrWorkspace } from './oda-hr.ts';

function fixture() {
  let sequence = 0;
  const member = (id: string): HrEmployee => ({ id, employeeNumber: id, actorId: `actor-${id}`, name: id,
    departmentId: 'd', jobTitle: '기존 직무', employmentType: 'regular', status: 'active',
    hireDate: '2025-01-01', payType: 'monthly', basePay: 3_000_000, history: [] });
  const workspace = { employees: ['one', 'two', 'manager'].map(member), talent: createHrTalentState() } as HrWorkspace;
  const context = (id: string, manager = false, payroll = false): HrContext => ({ actorId: `actor-${id}`, employeeId: id,
    manager, payroll, today: '2026-09-15', now: '2026-09-15T10:00:00Z', id: () => `item-${++sequence}` });
  const admin = context('manager', true, true), one = context('one'), two = context('two');
  function command(type: string, input: Record<string, unknown>, ctx = admin) {
    return applyHrTalentCommand(workspace, { type, input }, ctx);
  }
  return { workspace, context, admin, one, two, command };
}
const rejected = (action: () => unknown, code: string) => assert.throws(action, error => error instanceof DomainError && error.code === code);

test('goals restrict authors, validate progress, and freeze completed goals until reopened', () => {
  const f = fixture();
  const input = { employeeId: 'one', title: '채용 프로세스 개선', description: '', dueDate: '2026-10-01', visibility: 'private' };
  rejected(() => f.command('goal.create', input, f.two), 'HR_FORBIDDEN');
  f.command('goal.create', input, f.one); const goal = f.workspace.talent.goals[0]!;
  rejected(() => f.command('goal.update', { id: goal.id, progress: 101 }, f.one), 'HR_INVALID');
  rejected(() => f.command('goal.update', { id: goal.id, progress: 50 }, f.two), 'HR_FORBIDDEN');
  f.command('goal.update', { id: goal.id, progress: 80 }, f.one);
  f.command('goal.complete', { id: goal.id }, f.one);
  rejected(() => f.command('goal.update', { id: goal.id, progress: 90 }, f.one), 'HR_LOCKED');
  assert.equal(goal.progress, 80);
  f.command('goal.reopen', { id: goal.id }, f.one); f.command('goal.update', { id: goal.id, progress: 90 }, f.one);
  assert.equal(projectHrTalentState(f.workspace.talent, f.two).goals.length, 0);
  assert.equal(projectHrTalentState(f.workspace.talent, f.admin).goals.length, 1);
  f.command('goal.delete', { id: goal.id }, f.one); assert.equal(f.workspace.talent.goals.length, 0);
});

test('invalid calendar dates return a domain validation error without storing a goal', () => {
  const f = fixture();
  for (const dueDate of ['2026-02-30', '2026-99-99', 'not-a-date']) {
    rejected(() => f.command('goal.create', { employeeId: 'one', title: 'x', description: '', dueDate, visibility: 'company' }), 'HR_INVALID');
  }
  assert.equal(f.workspace.talent.goals.length, 0);
});

test('evaluation submission locks answers, requires all questions, and allows withdrawal only while open', () => {
  const f = fixture();
  f.command('review.create', { title: '분기 평가', employeeIds: ['two'], reviewerEmployeeId: 'one', startDate: '2026-09-01', dueDate: '2026-09-30', questions: ['성과', '협업'] });
  const cycle = f.workspace.talent.reviews[0]!, assignment = cycle.assignments[0]!;
  const ref = { id: cycle.id, assignmentId: assignment.id };
  rejected(() => f.command('review.answer', { ...ref, answers: [] }, f.one), 'HR_LOCKED');
  f.command('review.open', { id: cycle.id });
  rejected(() => f.command('review.answer', { ...ref, answers: [] }, f.two), 'HR_FORBIDDEN');
  rejected(() => f.command('review.answer', { ...ref, answers: [] }), 'HR_FORBIDDEN');
  rejected(() => f.command('review.submit', ref, f.one), 'HR_INVALID');
  f.command('review.answer', { ...ref, answers: [{ question: '성과', score: 4, comment: '완료' }] }, f.one);
  rejected(() => f.command('review.submit', ref, f.one), 'HR_INVALID');
  rejected(() => f.command('review.close', { id: cycle.id }), 'HR_LOCKED');
  f.command('review.answer', { ...ref, answers: [{ question: '성과', score: 4, comment: '완료' }, { question: '협업', score: 5, comment: '좋음' }] }, f.one);
  f.command('review.submit', ref, f.one);
  rejected(() => f.command('review.answer', { ...ref, answers: [] }, f.one), 'HR_LOCKED');
  f.command('review.withdraw', ref, f.one); assert.equal(assignment.status, 'draft');
  f.command('review.submit', ref, f.one); f.command('review.close', { id: cycle.id });
  rejected(() => f.command('review.withdraw', ref, f.one), 'HR_LOCKED');
  assert.equal(cycle.reports[0]!.averageScore, 4.5);
});

test('unpublished/revoked reports are absent from subject responses, while published reports exclude reviewer assignments', () => {
  const f = fixture();
  f.command('review.create', { title: '평가', employeeIds: ['two'], reviewerEmployeeId: 'one', startDate: '2026-09-01', dueDate: '2026-09-30', questions: ['성과'] });
  const cycle = f.workspace.talent.reviews[0]!, assignment = cycle.assignments[0]!;
  f.command('review.open', { id: cycle.id });
  f.command('review.answer', { id: cycle.id, assignmentId: assignment.id, answers: [{ question: '성과', score: 5, comment: '평가 의견' }] }, f.one);
  f.command('review.submit', { id: cycle.id, assignmentId: assignment.id }, f.one);
  f.command('review.close', { id: cycle.id });
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.two).reviews, []);
  rejected(() => f.command('review.publish', { id: cycle.id, employeeId: 'two' }, f.one), 'HR_FORBIDDEN');
  f.command('review.publish', { id: cycle.id, employeeId: 'two' });
  const visible = projectHrTalentState(f.workspace.talent, f.two).reviews[0]!;
  assert.equal(visible.reports.length, 1); assert.deepEqual(visible.assignments, []);
  f.command('review.revoke', { id: cycle.id, employeeId: 'two' });
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.two).reviews, []);
  assert.equal(f.workspace.talent.reviews[0]!.reports.length, 1);
});

test('evaluation dates and question identities prevent answers outside scope', () => {
  const f = fixture();
  f.command('review.create', { title: '평가', employeeIds: ['one'], startDate: '2026-09-01', dueDate: '2026-09-30', questions: ['성과'] });
  const cycle = f.workspace.talent.reviews[0]!, assignment = cycle.assignments[0]!;
  f.command('review.open', { id: cycle.id });
  const ref = { id: cycle.id, assignmentId: assignment.id };
  rejected(() => f.command('review.answer', { ...ref, answers: [{ question: '다른 문항', score: 4, comment: '' }] }, f.one), 'HR_INVALID');
  rejected(() => f.command('review.answer', { ...ref, answers: [{ question: '성과', score: 4.5, comment: '' }] }, f.one), 'HR_INVALID');
  rejected(() => f.command('review.answer', { ...ref, answers: [] }, { ...f.one, today: '2026-10-01' }), 'HR_LOCKED');
  assert.deepEqual(assignment.answers, []);
});

test('review setup can be corrected or deleted only before opening', () => {
  const f = fixture();
  const setup = { title: '초안', employeeIds: ['one'], startDate: '2026-09-01', dueDate: '2026-09-30', questions: ['성과'] };
  f.command('review.create', setup); const cycle = f.workspace.talent.reviews[0]!;
  f.command('review.update', { ...setup, id: cycle.id, title: '수정 평가', employeeIds: ['two'], questions: ['협업'] });
  assert.equal(cycle.title, '수정 평가'); assert.equal(cycle.assignments[0]!.employeeId, 'two');
  assert.deepEqual(cycle.questions, ['협업']);
  f.command('review.open', { id: cycle.id });
  rejected(() => f.command('review.update', { ...setup, id: cycle.id }), 'HR_LOCKED');
  rejected(() => f.command('review.delete', { id: cycle.id }), 'HR_LOCKED');
  f.command('review.create', setup); const draft = f.workspace.talent.reviews[1]!;
  f.command('review.delete', { id: draft.id }); assert.equal(f.workspace.talent.reviews.length, 1);
});

test('meeting private notes are owner-only even for participating administrators, and projection never mutates storage', () => {
  const f = fixture();
  f.command('meeting.create', { title: '팀 미팅', participantEmployeeIds: ['two', 'manager'], scheduledDate: '' }, f.one);
  const meeting = f.workspace.talent.meetings[0]!;
  f.command('meeting.update', { id: meeting.id, notes: '공동 기록' }, f.two);
  f.command('meeting.privateNote', { id: meeting.id, note: 'one secret', actorId: f.two.actorId }, f.one);
  f.command('meeting.privateNote', { id: meeting.id, note: 'two secret' }, f.two);
  f.command('meeting.privateNote', { id: meeting.id, note: 'admin secret' }, f.admin);
  const original = structuredClone(f.workspace.talent);
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.one).meetings[0]!.privateNotes, { 'actor-one': 'one secret' });
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.admin).meetings[0]!.privateNotes, { 'actor-manager': 'admin secret' });
  assert.equal(projectHrTalentState(f.workspace.talent, f.two).meetings[0]!.notes, '공동 기록');
  assert.deepEqual(f.workspace.talent, original);
});

test('nonparticipants cannot access meeting data or mutate notes/tasks even with manager privileges', () => {
  const f = fixture();
  f.command('meeting.create', { title: '원온원', participantEmployeeIds: ['two'] }, f.one);
  const meeting = f.workspace.talent.meetings[0]!;
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.admin).meetings, []);
  rejected(() => f.command('meeting.privateNote', { id: meeting.id, note: 'x' }), 'HR_FORBIDDEN');
  rejected(() => f.command('meeting.update', { id: meeting.id, notes: 'x' }), 'HR_FORBIDDEN');
  rejected(() => f.command('meeting.addTask', { id: meeting.id, title: 'x', assigneeEmployeeId: 'manager' }, f.one), 'HR_INVALID');
  f.command('meeting.addTask', { id: meeting.id, title: '자료 준비', assigneeEmployeeId: 'two' }, f.one);
  f.command('meeting.toggleTask', { id: meeting.id, taskId: meeting.tasks[0]!.id, completed: true }, f.two);
  assert.equal(meeting.tasks[0]!.completed, true);
  rejected(() => f.command('meeting.delete', { id: meeting.id }, f.two), 'HR_FORBIDDEN');
  f.command('meeting.delete', { id: meeting.id }, f.one); assert.equal(f.workspace.talent.meetings.length, 0);
});

test('recruitment preserves terminal transitions, blocks changes under closed jobs, and does not create employees on hire', () => {
  const f = fixture();
  rejected(() => f.command('recruitment.createJob', { title: '담당자', description: '' }, f.one), 'HR_FORBIDDEN');
  f.command('recruitment.createJob', { title: '담당자', description: '' }); const job = f.workspace.talent.jobs[0]!;
  rejected(() => f.command('recruitment.addCandidate', { jobId: job.id, name: '지원자' }), 'HR_LOCKED');
  f.command('recruitment.updateJob', { id: job.id, status: 'open' });
  f.command('recruitment.addCandidate', { jobId: job.id, name: '지원자', email: 'candidate@example.com' });
  const candidate = f.workspace.talent.candidates[0]!;
  f.command('recruitment.moveCandidate', { id: candidate.id, stage: 'interview' });
  f.command('recruitment.moveCandidate', { id: candidate.id, stage: 'rejected' });
  rejected(() => f.command('recruitment.moveCandidate', { id: candidate.id, stage: 'offer' }), 'HR_LOCKED');
  f.command('recruitment.reopenCandidate', { id: candidate.id }); assert.equal(candidate.stage, 'interview');
  f.command('recruitment.moveCandidate', { id: candidate.id, stage: 'hired' });
  assert.equal(f.workspace.employees.length, 3);
  f.command('recruitment.updateJob', { id: job.id, status: 'closed' });
  rejected(() => f.command('recruitment.reopenCandidate', { id: candidate.id }), 'HR_LOCKED');
  rejected(() => f.command('recruitment.deleteJob', { id: job.id }), 'HR_LOCKED');
  assert.equal(candidate.history.length, 5);
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.one).candidates, []);
});

function contractInput() {
  return { employeeId: 'one', title: '임금 변경 계약', body: '외부 체결할 계약 초안', employmentType: 'contract',
    jobTitle: '신규 직무', effectiveDate: '2026-09-15', endDate: '2027-09-14', payType: 'monthly', basePay: 3_500_000 };
}
test('contract completion requires external evidence and never signs or applies HR automatically', () => {
  const f = fixture(); f.command('contract.create', contractInput()); const contract = f.workspace.talent.contracts[0]!;
  rejected(() => f.command('contract.complete', { id: contract.id, completionReference: '근거' }, f.context('manager', true, false)), 'HR_FORBIDDEN');
  rejected(() => f.command('contract.cancel', { id: contract.id }, f.context('manager', true, false)), 'HR_FORBIDDEN');
  rejected(() => f.command('contract.complete', { id: contract.id }), 'HR_INVALID');
  assert.equal(contract.status, 'draft');
  f.command('contract.complete', { id: contract.id, completionReference: '2026-09-15 종이 서명, 인사 문서함 123' });
  assert.equal(contract.status, 'completed'); assert.equal(contract.completionKind, 'external_record');
  assert.equal(contract.appliedAt, null); assert.equal(f.workspace.employees[0]!.basePay, 3_000_000);
  rejected(() => f.command('contract.update', { ...contractInput(), id: contract.id }), 'HR_LOCKED');
  rejected(() => f.command('contract.cancel', { id: contract.id }), 'HR_LOCKED');
});

test('personnel application checks dual permissions, writes history, and rejects duplicate application', () => {
  const f = fixture(); f.command('contract.create', contractInput()); const contract = f.workspace.talent.contracts[0]!;
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }), 'HR_LOCKED');
  f.command('contract.complete', { id: contract.id, completionReference: '외부 서명 원본 보관' });
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }, f.context('manager', true, false)), 'HR_FORBIDDEN');
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }, f.one), 'HR_FORBIDDEN');
  f.command('contract.applyPersonnel', { id: contract.id });
  const employee = f.workspace.employees[0]!;
  assert.equal(employee.basePay, 3_500_000); assert.equal(employee.jobTitle, '신규 직무');
  assert.equal(contract.personnelBefore!.basePay, 3_000_000); assert.equal(employee.history.length, 1);
  assert.equal(employee.history[0]!.changes.contractId, contract.id);
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }), 'HR_LOCKED');
  assert.equal(employee.history.length, 1);
});

test('future or retired contract application is blocked and salary contracts are hidden from nonpayroll third parties', () => {
  const f = fixture();
  rejected(() => f.command('contract.create', contractInput(), f.context('manager', true, false)), 'HR_FORBIDDEN');
  f.command('contract.create', { ...contractInput(), effectiveDate: '2026-10-01' });
  const contract = f.workspace.talent.contracts[0]!;
  f.command('contract.complete', { id: contract.id, completionReference: '외부 서명 완료 원본' });
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }), 'HR_LOCKED');
  assert.deepEqual(projectHrTalentState(f.workspace.talent, f.context('manager', true, false)).contracts, []);
  assert.equal(projectHrTalentState(f.workspace.talent, f.one).contracts.length, 1);
  f.workspace.employees[0]!.status = 'retired';
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }, { ...f.admin, today: '2026-10-01' }), 'HR_INVALID');
  assert.equal(contract.appliedAt, null);
});

test('non-salary contract preserves pay and unknown external integration commands remain unsupported', () => {
  const f = fixture(); const manager = f.context('manager', true, false);
  f.command('contract.create', { ...contractInput(), basePay: null }, manager);
  const contract = f.workspace.talent.contracts[0]!;
  f.command('contract.complete', { id: contract.id, completionReference: '외부 체결 확인' }, manager);
  f.command('contract.applyPersonnel', { id: contract.id }, manager);
  assert.equal(f.workspace.employees[0]!.basePay, 3_000_000);
  for (const type of ['contract.send', 'contract.sign', 'recruitment.sendEmail', 'meeting.transcribe', 'meeting.summarize']) assert.equal(f.command(type, {}), false);
});

test('an older external contract cannot overwrite personnel terms already updated by a native electronic contract', () => {
  const f = fixture();
  f.command('contract.create', contractInput());
  const contract = f.workspace.talent.contracts[0]!;
  f.command('contract.complete', { id: contract.id, completionReference: '기존 서명본' });
  const employee = f.workspace.employees[0]!;
  employee.basePay = 3_800_000;
  employee.history.push({ at: '2026-09-15T11:00:00Z', effectiveDate: '2026-09-15',
    reason: '전자계약 조건 반영', changes: { nativeContractId: 'native-newer', basePay: 3_800_000 } });
  rejected(() => f.command('contract.applyPersonnel', { id: contract.id }), 'HR_CONTRACT_STALE');
  assert.equal(employee.basePay, 3_800_000);
  assert.equal(contract.appliedAt, null);
});
