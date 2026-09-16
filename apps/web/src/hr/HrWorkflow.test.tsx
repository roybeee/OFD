import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import type { HrWorkflowRequest } from '../../../../packages/domain/src/oda-hr-workflow';
import { HrWorkflow } from './HrWorkflow';
import type { HrPanelProps } from './shared';

let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function fixture(): HrPanelProps {
  return { workspace: createHrWorkspace('s', '매장', '2026-09-15T00:00:00Z'), actorId: 'self', employeeId: 'e', permissions: { manage: false, payroll: false, self: true }, busy: false, mutate: vi.fn(async () => {}) };
}
function request(status: HrWorkflowRequest['status']): HrWorkflowRequest {
  return { id: 'r', title: '비품 결재', category: '비용', body: '기존 본문', amount: 30000, authorId: 'self', employeeId: 'e', templateId: 't',
    steps: [{ approverIds: ['self', 'other'], mode: 'all' }], currentStep: 0, status, decisions: [], createdAt: '2026-09-15T00:00:00Z' };
}
const button = (title: string) => [...container.querySelectorAll('button')].find(row => row.textContent?.trim() === title);
async function click(title: string) { expect(button(title)).toBeTruthy(); await act(async () => button(title)!.click()); }

describe('HR workflow controls follow server state and authority', () => {
  it('does not save a filled template when adding a step or cancelling its dialog', async () => {
    const props = fixture(); props.permissions = { manage: true, payroll: true, self: true };
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" />)); await click('결재 양식 만들기');
    for (const name of ['title', 'category']) (container.querySelector(`[name="${name}"]`) as HTMLInputElement).value = '입력 완료';
    await click('단계 추가'); expect(container.querySelectorAll('fieldset')).toHaveLength(2); expect(props.mutate).not.toHaveBeenCalled();
    await click('취소'); expect(props.mutate).not.toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('keeps final expense review disabled until the linked request is approved', async () => {
    const props = fixture(); props.permissions = { manage: false, payroll: true, self: false }; props.workspace.workflow.requests = [request('pending')];
    props.workspace.workflow.expenses = [{ id: 'x', authorId: 'other', date: '2026-09-15', title: '의자', category: '비품', amount: 30000, evidenceNote: 'R-1', status: 'submitted', workflowId: 'r' }];
    await act(async () => root.render(<HrWorkflow {...props} tab="expenses" />));
    expect(button('검토 완료')?.disabled).toBe(true); expect(container.textContent).toContain('연결 결재: 결재 진행');
    await click('반려'); expect(props.mutate).toHaveBeenCalledWith('expense.review', { id: 'x', decision: 'rejected' });
  });

  it('shows no mutation actions for read-only actors even if they authored an existing draft', async () => {
    const props = fixture(); props.permissions = { manage: false, payroll: false, self: false }; props.workspace.workflow.requests = [request('draft')];
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" />)); await click('열기');
    expect(button('결재 제출')).toBeUndefined(); expect(button('수정')).toBeUndefined(); expect(button('회수')).toBeUndefined(); expect(button('처리하기')).toBeUndefined();
    expect(props.mutate).not.toHaveBeenCalled();
  });

  it('submits an edited draft as a versioned command rather than creating a second request', async () => {
    const props = fixture(); props.workspace.workflow.requests = [request('draft')];
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" />)); await click('열기'); await click('수정');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const field = container.querySelector<HTMLInputElement>('[name="title"]')!; expect(field.value).toBe('비품 결재');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '수정 결재'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(props.mutate).toHaveBeenCalledWith('workflow.update', { id: 'r', title: '수정 결재', body: '기존 본문', amount: 30000 });
  });

  it('lets the author reopen a withdrawn expense and hides a second delegated vote', async () => {
    const props = fixture(); props.workspace.workflow.expenses = [{ id: 'x', authorId: 'self', date: '2026-09-15', title: '의자', category: '비품', amount: 30000, evidenceNote: 'R-1', status: 'withdrawn' }];
    await act(async () => root.render(<HrWorkflow {...props} tab="expenses" />)); await click('다시 작성');
    expect(props.mutate).toHaveBeenCalledWith('expense.reopen', { id: 'x' });
    const row = request('pending'); row.decisions = [{ step: 0, actorId: 'self', approverId: 'self', decision: 'approved', comment: '', at: '2026-09-15T00:00:00Z' }];
    props.workspace.workflow.requests = [row]; props.workspace.workflow.delegations = [{ id: 'd', fromActorId: 'other', toActorId: 'self', startDate: '2020-01-01', endDate: '2099-01-01', active: true }];
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" />)); await click('열기'); expect(button('처리하기')).toBeUndefined();
  });
});


describe('staff workflow destination intents', () => {
  it('opens the exact visible request once, keeps a closed dialog closed on refresh, and accepts a new intent', async () => {
    const props = fixture();
    props.workspace.workflow.requests = [request('pending'), { ...request('approved'), id: 'other', title: '다른 요청', body: '다른 본문' }];
    const intent = { nonce: 1, recordId: 'r' };
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" entryIntent={intent} />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('기존 본문');
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('다른 본문');
    expect(props.mutate).not.toHaveBeenCalled();
    await click('닫기');
    await act(async () => root.render(<HrWorkflow {...props} workspace={{ ...props.workspace, version: 1 }} tab="approvals" entryIntent={{ ...intent }} />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" entryIntent={{ nonce: 2, recordId: 'other' }} />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('다른 본문');
  });
  it('opens compose without a write and never discloses another author private draft through an ID', async () => {
    const props = fixture();
    props.workspace.workflow.requests = [{ ...request('draft'), authorId: 'stranger', title: '타인 비공개 초안', body: '비밀 본문' }];
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" entryIntent={{ nonce: 1, recordId: 'r' }} />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('조회 권한이 없습니다');
    expect(container.textContent).not.toContain('비밀 본문');
    expect(container.textContent).not.toContain('타인 비공개 초안');
    await act(async () => root.render(<HrWorkflow {...props} tab="approvals" entryIntent={{ nonce: 2, action: 'create' }} />));
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('결재 요청 작성');
    expect(props.mutate).not.toHaveBeenCalled();
  });
  it('opens exact expense evidence and drops stale detail when the store changes', async () => {
    const props = fixture();
    props.workspace.workflow.expenses = [{ id: 'x', authorId: 'self', date: '2026-09-15', title: '의자', category: '비품', amount: 30000, evidenceNote: 'R-1', status: 'draft' }];
    await act(async () => root.render(<HrWorkflow {...props} tab="expenses" entryIntent={{ nonce: 1, recordId: 'x' }} />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('R-1');
    await act(async () => root.render(<HrWorkflow {...props} workspace={createHrWorkspace('other-store', '다른 매장', '2026-09-15T00:00:00Z')} tab="expenses" entryIntent={{ nonce: 1, recordId: 'x' }} />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('R-1');
    expect(props.mutate).not.toHaveBeenCalled();
  });
});
