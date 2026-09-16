import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import type { HrMeeting, HrReviewCycle } from '../../../../packages/domain/src/oda-hr-talent';
import { HrTalent } from './HrTalent';
import type { HrPanelProps } from './shared';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function fixture(): HrPanelProps {
  const workspace = createHrWorkspace('s1', '테스트 매장', new Date().toISOString());
  workspace.employees.push({ id: 'e1', employeeNumber: 'E1', name: '직원', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay: 0, history: [] });
  return { workspace, actorId: 'staff', employeeId: 'e1', permissions: { manage: false, payroll: false, self: true }, busy: false, mutate: vi.fn(async () => {}) };
}
function meeting(id: string, participant = 'e1'): HrMeeting {
  return { id, title: `미팅 ${id}`, hostActorId: 'host', participantEmployeeIds: [participant], scheduledDate: '2026-09-17', notes: `공동 노트 ${id}`, privateNotes: { staff: '내 메모', other: '타인 비공개 메모' }, tasks: [{ id: 'task', title: '재고 확인', assigneeEmployeeId: participant, completed: false }], createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z' };
}

it('opens the requested meeting and never auto saves or reopens after close and refresh', async () => {
  const props = fixture(); props.workspace.talent.meetings = [meeting('one'), meeting('two')];
  const entryIntent = { nonce: 1, recordId: 'two', childId: 'task' };
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={entryIntent} />));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('미팅 two 미팅');
  expect((dialog.querySelector('[name="notes"]') as HTMLTextAreaElement).value).toBe('공동 노트 two');
  expect(dialog.textContent).toContain('재고 확인');
  expect(host.textContent).not.toContain('타인 비공개 메모');
  await act(async () => (dialog.querySelector('[aria-label="미팅 two 미팅 닫기"]') as HTMLButtonElement).click());
  await act(async () => root.render(<HrTalent {...props} workspace={{ ...props.workspace, version: 1 }} tab="meetings" entryIntent={{ ...entryIntent }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(props.mutate).not.toHaveBeenCalled();
});

it('rejects unrelated meetings and stale child IDs with no disclosure', async () => {
  const props = fixture(); props.workspace.talent.meetings = [meeting('private', 'other'), meeting('mine')];
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={{ nonce: 1, recordId: 'private' }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain('조회 권한이 없습니다');
  expect(host.textContent).not.toContain('공동 노트 private');
  expect(host.textContent).not.toContain('미팅 private');
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={{ nonce: 2, recordId: 'mine', childId: 'absent' }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(props.mutate).not.toHaveBeenCalled();
});

it('opens the meeting creation form directly, keeps it closed after save, and permits a fresh action', async () => {
  const props = fixture(); const intent = { nonce: 1, action: 'create' as const };
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={intent} />));
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('미팅 작성');
  expect(props.mutate).not.toHaveBeenCalled();
  const dialog = host.querySelector('[role="dialog"]')!;
  (dialog.querySelector('[name="title"]') as HTMLInputElement).value = '주간 미팅';
  await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(props.mutate).toHaveBeenCalledExactlyOnceWith('meeting.create', { title: '주간 미팅', scheduledDate: '', participantEmployeeIds: ['e1'] });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={{ ...intent }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.render(<HrTalent {...props} tab="meetings" entryIntent={{ ...intent, nonce: 2 }} />));
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('미팅 작성');
});

it('opens only the requested visible review assignment, and conceals another reviewers private answers', async () => {
  const props = fixture();
  const cycle: HrReviewCycle = { id: 'cycle', title: '평가', status: 'open', startDate: '2026-01-01', dueDate: '2099-01-01', questions: ['협업'], createdAt: '2026-09-16T00:00:00Z', reports: [], assignments: [
    { id: 'mine', employeeId: 'e1', reviewerEmployeeId: 'e1', status: 'draft', answers: [{ question: '협업', score: 4, comment: '나의 답변' }], submittedAt: null },
    { id: 'private', employeeId: 'e1', reviewerEmployeeId: 'e2', status: 'draft', answers: [{ question: '협업', score: 3, comment: '타인 비공개 답변' }], submittedAt: null },
  ] };
  props.workspace.talent.reviews = [cycle];
  await act(async () => root.render(<HrTalent {...props} tab="reviews" entryIntent={{ nonce: 1, recordId: 'cycle', childId: 'mine' }} />));
  expect((host.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement).value).toBe('나의 답변');
  expect(host.innerHTML).not.toContain('타인 비공개 답변');
  await act(async () => root.render(<HrTalent {...props} tab="reviews" entryIntent={{ nonce: 2, recordId: 'cycle', childId: 'private' }} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(props.mutate).not.toHaveBeenCalled();
});
