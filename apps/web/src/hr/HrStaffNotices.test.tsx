import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace, type HrNotice, type HrResponse } from '../../../../packages/domain/src/oda-hr';
import { countStaffUnreadNotices, HrStaffNotices, isStaffNoticeAcknowledged } from './HrStaffNotices';

const now = '2026-09-16T01:00:00.000Z';
const actorId = 'staff-a';
function notice(id: string, changes: Partial<HrNotice> = {}): HrNotice {
  return { id, title: `공지 ${id}`, body: `${id} 본문`, pinned: false, status: 'published', createdBy: 'owner', createdAt: now, updatedAt: now, ...changes };
}
function fixture(): HrResponse {
  const workspace = createHrWorkspace('store-a', '테스트 매장', now);
  workspace.notices = [notice('first'), notice('important', { pinned: true }), notice('draft', { status: 'draft' }), notice('archived', { status: 'archived' })];
  return { workspace, employeeId: 'employee-a', permissions: { manage: false, payroll: false, self: true } };
}
const confirmed = (noticeUpdatedAt = now, owner = actorId) => ({ actorId: owner, employeeId: 'employee-a', noticeUpdatedAt, acknowledgedAt: now });
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const findButton = (text: string) => [...container.querySelectorAll('button')].find(row => row.textContent?.trim() === text || row.getAttribute('aria-label') === text);
async function click(text: string) { const button = findButton(text); expect(button).toBeTruthy(); await act(async () => button!.click()); }
async function setSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('staff notice confirmation', () => {
  it('counts only current actor and exact published revision; old JSON rows remain unread', () => {
    const response = fixture();
    expect(countStaffUnreadNotices(response, actorId)).toBe(2);
    response.workspace.notices[0]!.receipts = [confirmed(now, 'colleague')];
    expect(countStaffUnreadNotices(response, actorId)).toBe(2);
    response.workspace.notices[0]!.receipts!.push(confirmed());
    expect(countStaffUnreadNotices(response, actorId)).toBe(1);
    response.workspace.notices[0]!.updatedAt = '2026-09-16T02:00:00.000Z';
    expect(isStaffNoticeAcknowledged(response.workspace.notices[0]!, actorId)).toBe(false);
    expect(countStaffUnreadNotices(response, actorId)).toBe(2);
    expect(countStaffUnreadNotices(null, actorId)).toBe(0);
  });

  it('sorts pinned notices, hides unpublished notices, and never saves by opening/searching', async () => {
    const response = fixture(); const onAcknowledge = vi.fn();
    await act(async () => root.render(<HrStaffNotices response={response} actorId={actorId} busy={false} onAcknowledge={onAcknowledge} />));
    const toggles = container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]');
    expect(toggles).toHaveLength(2); expect(toggles[0]?.textContent).toContain('important');
    expect(container.textContent).not.toContain('draft'); expect(container.textContent).not.toContain('archived');
    await act(async () => toggles[0]!.click());
    expect(container.textContent).toContain('important 본문');
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
    await setSearch('FIRST'); expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1);
    expect(container.textContent).toContain('공지 first');
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('submits the displayed revision once, then shows confirmation only from returned server state', async () => {
    const response = fixture(); let finish!: () => void;
    const onAcknowledge = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const render = () => root.render(<HrStaffNotices response={response} actorId={actorId} busy={false} onAcknowledge={onAcknowledge} initialNoticeId="first" />);
    await act(async () => render());
    const button = findButton('확인했어요')!;
    await act(async () => { button.click(); button.click(); });
    expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('first', now);
    expect(findButton('확인 저장 중…')?.disabled).toBe(true);
    expect(container.querySelector('.staff-notice-confirmed')).toBeNull();
    await act(async () => finish());
    expect(container.querySelector('.staff-notice-confirmed')).toBeNull();
    response.workspace.notices[0]!.receipts = [confirmed()];
    await act(async () => render());
    expect(container.querySelector('.staff-notice-confirmed')?.textContent).toContain('확인했어요');
    expect(container.querySelector('.staff-notice-count')?.textContent).toBe('미확인 1개');
    await click('미확인 1');
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1);
    expect(container.textContent).not.toContain('공지 first');
  });

  it('retains unread state and permits a deliberate retry after a rejected save', async () => {
    const response = fixture(); const onAcknowledge = vi.fn().mockRejectedValue(new Error('공지 내용이 변경되었습니다. 다시 읽어 주세요.'));
    await act(async () => root.render(<HrStaffNotices response={response} actorId={actorId} busy={false} onAcknowledge={onAcknowledge} initialNoticeId="first" />));
    await click('확인했어요');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('공지 내용이 변경되었습니다');
    expect(findButton('확인했어요')?.disabled).toBe(false);
    expect(container.querySelector('.staff-notice-count')?.textContent).toBe('미확인 2개');
    expect(container.querySelector('.staff-notice-confirmed')).toBeNull();
  });

  it('clears scope state and ignores a save failure from a previous store', async () => {
    const response = fixture(); let fail!: (reason: Error) => void;
    const onAcknowledge = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    await act(async () => root.render(<HrStaffNotices response={response} actorId={actorId} busy={false} onAcknowledge={onAcknowledge} initialNoticeId="first" />));
    await click('확인했어요');
    const next = fixture(); next.workspace.storeId = 'store-b'; next.workspace.notices = [notice('next')];
    await act(async () => root.render(<HrStaffNotices response={next} actorId="staff-b" busy={false} onAcknowledge={onAcknowledge} />));
    await act(async () => fail(new Error('이전 매장 저장 실패')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('first'); expect(container.textContent).toContain('next');
    expect(container.querySelector('input')?.value).toBe('');
  });

  it('does not present unavailable data as an empty inbox and disables writes for loading/unlinked accounts', async () => {
    const onAcknowledge = vi.fn();
    await act(async () => root.render(<HrStaffNotices response={null} actorId={actorId} busy onAcknowledge={onAcknowledge} />));
    expect(container.textContent).toContain('공지를 불러오고 있어요.'); expect(container.textContent).not.toContain('게시된 매장 공지가 없습니다.');
    const response = fixture(); response.permissions.self = false;
    await act(async () => root.render(<HrStaffNotices response={response} actorId={actorId} busy={false} onAcknowledge={onAcknowledge} initialNoticeId="first" />));
    expect(findButton('확인했어요')?.disabled).toBe(true);
    await click('확인했어요'); expect(onAcknowledge).not.toHaveBeenCalled();
  });
});
