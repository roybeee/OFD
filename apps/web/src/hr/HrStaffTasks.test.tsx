import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace, type HrResponse } from '../../../../packages/domain/src/oda-hr';
import type { HrWorkflowRequest } from '../../../../packages/domain/src/oda-hr-workflow';
import type { HrLeaveRequest, HrWorkEntry } from '../../../../packages/domain/src/oda-hr-attendance';
import { deriveStaffTasks, HrStaffTasks } from './HrStaffTasks';

const today = '2026-09-16';
const now = `${today}T01:00:00Z`;
function fixture(): HrResponse {
  return { workspace: createHrWorkspace('store', '매장', now), employeeId: 'me', permissions: { manage: false, payroll: false, self: true } };
}
function request(id: string, changes: Partial<HrWorkflowRequest> = {}): HrWorkflowRequest {
  return { id, title: `결재 ${id}`, category: '업무', body: '결재 본문', amount: 1000, authorId: 'other',
    templateId: 'template', steps: [{ approverIds: ['self'], mode: 'all' }], currentStep: 0,
    status: 'pending', decisions: [], createdAt: now, ...changes };
}
function work(id: string, employeeId: string, source: HrWorkEntry['source'] = 'manual'): HrWorkEntry {
  return { id, employeeId, date: today, endDate: today, startTime: '09:00', endTime: '18:00', breakMinutes: 60, recognizedMinutes: 480,
    status: 'pending', source, policyId: '', note: '민감한 근무 사유', revision: 1, createdAt: now, createdBy: 'self', reviewedAt: '', reviewedBy: '', rawClockIds: [] };
}
function leave(id: string, employeeId: string): HrLeaveRequest {
  return { id, employeeId, typeId: 'annual', startDate: today, endDate: today, slots: [], minutes: 480, paid: true, note: '민감한 휴가 사유',
    status: 'pending', revision: 1, createdAt: now, createdBy: 'self', reviewedAt: '', reviewedBy: '' };
}

describe('staff task groups follow assignments, ownership and visibility', () => {
  it('requires the current pending step and excludes already cast votes, future steps and drafts', () => {
    const response = fixture();
    response.workspace.workflow.requests = [request('current'), request('future', { steps: [{ approverIds: ['first'], mode: 'all' }, { approverIds: ['self'], mode: 'all' }] }),
      request('voted', { steps: [{ approverIds: ['self', 'other'], mode: 'all' }], decisions: [{ actorId: 'self', approverId: 'self', step: 0, decision: 'approved', at: now, comment: '' }] }),
      request('draft', { status: 'draft' }), request('done', { status: 'approved', currentStep: 1 }), request('unrelated', { steps: [{ approverIds: ['stranger'], mode: 'all' }] })];
    const groups = deriveStaffTasks(response, 'self', today);
    expect(groups.todo.map(row => row.id)).toEqual(['workflow:current']);
    expect(groups.reference.map(row => row.id).sort()).toEqual(['workflow:done', 'workflow:future', 'workflow:voted']);
    expect(groups.requested).toEqual([]);
  });

  it('uses active delegation dates and does not give a second approval vote or action to read-only accounts', () => {
    const response = fixture();
    response.workspace.workflow.requests = [request('delegated', { steps: [{ approverIds: ['boss'], mode: 'all' }] })];
    response.workspace.workflow.delegations = [{ id: 'd', fromActorId: 'boss', toActorId: 'self', startDate: today, endDate: today, active: true }];
    expect(deriveStaffTasks(response, 'self', today).todo).toHaveLength(1);
    expect(deriveStaffTasks(response, 'self', '2026-09-17').todo).toHaveLength(0);
    response.workspace.workflow.requests[0]!.decisions = [{ actorId: 'self', approverId: 'boss', step: 0, decision: 'approved', at: now, comment: '' }];
    expect(deriveStaffTasks(response, 'self', today).todo).toHaveLength(0);
    response.workspace.workflow.requests = [request('direct')]; response.permissions.self = false;
    expect(deriveStaffTasks(response, 'self', today).todo).toHaveLength(0);
  });

  it('keeps requests scoped to author or employee and includes pending manual records without exposing their private notes', () => {
    const response = fixture();
    response.workspace.workflow.requests = [request('mine', { authorId: 'self' }), request('coworker')];
    response.workspace.workflow.expenses = [{ id: 'mine', authorId: 'self', date: today, title: '비품 구매', amount: 1200, category: '비품', evidenceNote: 'private receipt', status: 'submitted' },
      { id: 'other', authorId: 'other', date: today, title: '다른 직원 비용', amount: 5000, category: '식대', evidenceNote: '', status: 'submitted' }];
    response.workspace.attendance.workEntries = [work('mine', 'me'), work('clock', 'me', 'clock'), work('other', 'coworker')];
    response.workspace.attendance.leaveRequests = [leave('mine', 'me'), leave('other', 'coworker')];
    const groups = deriveStaffTasks(response, 'self', today);
    expect(groups.requested.map(row => row.id).sort()).toEqual(['expense:mine', 'leave:mine', 'work:mine', 'workflow:mine']);
    expect(JSON.stringify(groups)).not.toContain('민감한'); expect(JSON.stringify(groups)).not.toContain('private receipt');
    expect(groups.reference.some(row => row.id === 'workflow:mine')).toBe(false);
    delete response.employeeId;
    expect(deriveStaffTasks(response, 'self', today).requested.map(row => row.id).sort()).toEqual(['expense:mine', 'workflow:mine']);
  });

  it('includes only my unfinished meeting tasks and draft evaluations inside their open writing window', () => {
    const response = fixture();
    response.workspace.talent.meetings = [{ id: 'meeting', title: '매장 미팅', hostActorId: 'other', participantEmployeeIds: ['me', 'coworker'],
      scheduledDate: today, notes: '', privateNotes: { self: '비공개 메모' }, createdAt: now, updatedAt: now,
      tasks: [{ id: 'mine', title: '재고 확인', assigneeEmployeeId: 'me', completed: false }, { id: 'done', title: '완료 업무', assigneeEmployeeId: 'me', completed: true },
        { id: 'other', title: '다른 직원 업무', assigneeEmployeeId: 'coworker', completed: false }] }];
    response.workspace.talent.reviews = [{ id: 'review', title: '9월 평가', status: 'open', startDate: today, dueDate: '2026-09-30', questions: ['질문'], createdAt: now, reports: [],
      assignments: [{ id: 'mine', employeeId: 'me', reviewerEmployeeId: 'me', status: 'draft', answers: [], submittedAt: null },
        { id: 'other', employeeId: 'me', reviewerEmployeeId: 'coworker', status: 'draft', answers: [], submittedAt: null }] }];
    expect(deriveStaffTasks(response, 'self', today).todo.map(row => row.id)).toEqual(['meeting:meeting:mine', 'review:review:mine']);
    expect(deriveStaffTasks(response, 'self', '2026-10-01').todo.map(row => row.id)).toEqual(['meeting:meeting:mine']);
    response.workspace.talent.meetings[0]!.participantEmployeeIds = ['coworker'];
    response.workspace.talent.reviews[0]!.assignments[0]!.status = 'submitted';
    expect(deriveStaffTasks(response, 'self', today).todo).toEqual([]);
    expect(deriveStaffTasks(null, 'self', today)).toEqual({ todo: [], requested: [], reference: [] });
  });
});

let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (label: string) => [...container.querySelectorAll('button')].find(row => row.getAttribute('aria-label') === label || row.textContent?.trim() === label);
async function click(label: string) { const node = button(label); expect(node).toBeTruthy(); await act(async () => node!.click()); }

describe('staff task mobile interface', () => {
  it('shows the real empty state and opens the existing request panel from compose', async () => {
    const onOpenPersonal = vi.fn();
    await act(async () => root.render(<HrStaffTasks response={fixture()} actorId="self" busy={false} onOpenPersonal={onOpenPersonal} />));
    expect(container.textContent).toContain('아직 요청받은 할 일이 없어요.');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(container.querySelector('.staff-task-count')).toBeNull();
    await click('새 결재 요청'); expect(onOpenPersonal).toHaveBeenCalledWith('approvals');
    await click('참조'); expect(container.textContent).toContain('참고할 결재 문서가 없어요.');
  });

  it('searches the selected group, clears search when closed, and opens each real target panel', async () => {
    const response = fixture(); const onOpenPersonal = vi.fn();
    response.workspace.attendance.leaveRequests = [leave('mine', 'me')];
    response.workspace.workflow.expenses = [{ id: 'e', authorId: 'self', date: today, title: '장갑 구매', amount: 3000, category: '비품', evidenceNote: '', status: 'draft' }];
    await act(async () => root.render(<HrStaffTasks response={response} actorId="self" busy={false} onOpenPersonal={onOpenPersonal} />));
    const requestedTab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
    await act(async () => requestedTab.click());
    expect(container.querySelectorAll('.staff-task-row')).toHaveLength(2);
    await click('할 일 검색');
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '장갑'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.querySelectorAll('.staff-task-row')).toHaveLength(1);
    await act(async () => (container.querySelector('.staff-task-row') as HTMLButtonElement).click());
    expect(onOpenPersonal).toHaveBeenLastCalledWith('expenses');
    await click('할 일 검색 닫기'); expect(container.querySelectorAll('.staff-task-row')).toHaveLength(2);
    await act(async () => { requestedTab.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })); });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('참조');
  });

  it('does not present missing response as an empty inbox and disables navigation while busy', async () => {
    const onOpenPersonal = vi.fn();
    await act(async () => root.render(<HrStaffTasks response={null} actorId="self" busy onOpenPersonal={onOpenPersonal} />));
    expect(container.textContent).toContain('할 일을 불러오고 있어요.');
    expect(container.textContent).not.toContain('아직 요청받은');
    expect(button('새 결재 요청')?.disabled).toBe(true);
    const response = fixture(); response.workspace.workflow.requests = [request('mine')];
    await act(async () => root.render(<HrStaffTasks response={response} actorId="self" busy onOpenPersonal={onOpenPersonal} />));
    const row = container.querySelector<HTMLButtonElement>('.staff-task-row')!;
    expect(row.disabled).toBe(true);
    await act(async () => row.click()); expect(onOpenPersonal).not.toHaveBeenCalled();
  });
});
