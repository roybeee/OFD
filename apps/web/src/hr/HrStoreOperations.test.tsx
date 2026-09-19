import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace, HR_STORE_CHECKLIST } from '../../../../packages/domain/src/oda-hr';
import { HrStoreOperations, storeHandoverPhotoUrl } from './HrStoreOperations';
import { hrToday, type HrPanelProps } from './shared';

let root: Root; let container: HTMLDivElement;
const today = hrToday();
function fixture(manage = true): HrPanelProps {
  const workspace = createHrWorkspace('store-a', '테스트 매장', `${today}T00:00:00Z`);
  return { workspace, permissions: { manage, payroll: manage, self: true }, actorId: 'owner', employeeId: 'employee', busy: false, mutate: vi.fn().mockResolvedValue(undefined) };
}
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
async function click(text: string) { const target = button(text); expect(target, text).toBeTruthy(); await act(async () => target!.click()); }
async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name=${name}]`)!;
  expect(input).toBeTruthy(); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
async function render(props: HrPanelProps) { await act(async () => root.render(<HrStoreOperations {...props} />)); }

describe('매장 점검과 사진 인수인계', () => {
  it('sends one explicit checklist mutation without optimistic completion and shows authoritative completion actor', async () => {
    const props = fixture(); let finish!: () => void;
    props.mutate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render(props);
    const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => { checkbox.click(); checkbox.click(); });
    expect(props.mutate).toHaveBeenCalledExactlyOnceWith('operations.check', { date: today, phase: 'open', taskKey: HR_STORE_CHECKLIST[0]!.taskKey, done: true });
    expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(true);
    await act(async () => finish());
    props.workspace.operations.checks.push({ id: 'check', date: today, ...HR_STORE_CHECKLIST[0]!, done: true, completedBy: 'owner', completedAt: `${today}T00:00:00Z` });
    await render(props); expect(checkbox.checked).toBe(true); expect(container.textContent).toContain('나 완료');
  });

  it('keeps a failed handover draft and retries the same input deliberately', async () => {
    const props = fixture(); props.mutate = vi.fn().mockRejectedValueOnce(new Error('네트워크 응답 없음')).mockResolvedValue(undefined);
    await render(props); await click('인수인계'); await click('인수인계 작성'); await fill('category', 'facility'); await fill('body', '냉장고 온도를 확인해 주세요.'); await click('인수인계 등록');
    expect(container.textContent).toContain('네트워크 응답 없음'); expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('냉장고 온도를 확인해 주세요.');
    await click('인수인계 등록'); expect(props.mutate).toHaveBeenNthCalledWith(2, 'operations.handover.create', { date: today, body: '냉장고 온도를 확인해 주세요.', category: 'facility' });
    expect(container.querySelector('form')).toBeNull();
  });

  it('shows unresolved earlier handovers and reserves resolving and reopening for managers', async () => {
    const props = fixture(false);
    props.workspace.operations.handovers.push({ id: 'h1', date: '2020-01-01', body: '남아 있는 설비 점검', category: 'facility', authorId: 'staff', authorName: '직원', createdAt: '2020-01-01T00:00:00Z', resolved: false, hasPhoto: true });
    await render(props); await click('인수인계'); expect(container.textContent).toContain('이전 날짜에 해결되지 않은 인수인계 1건');
    await click('미해결 전체 1'); expect(container.textContent).toContain('남아 있는 설비 점검'); expect(button('해결 완료로 표시')).toBeUndefined();
    expect(container.querySelector('img')!.src).toContain('/api/v2/oda/store-a/hr/handovers/h1/photo');
    props.permissions.manage = true; await render(props); await click('해결 완료로 표시'); expect(props.mutate).toHaveBeenCalledWith('operations.handover.resolve', { id: 'h1', resolved: true });
    props.workspace.operations.handovers[0]!.resolved = true; props.workspace.operations.handovers[0]!.date = today;
    await render(props); await click('선택일 전체'); await click('다시 열기'); expect(props.mutate).toHaveBeenCalledWith('operations.handover.resolve', { id: 'h1', resolved: false });
  });

  it('reads an optional image, submits plain base64, and rejects unsupported uploads', async () => {
    const props = fixture(); await render(props); await click('인수인계'); await click('인수인계 작성'); await fill('body', '상품 사진');
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['not-image'], 'invoice.pdf', { type: 'application/pdf' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.textContent).toContain('2MB 이하로 선택'); expect(button('인수인계 등록')!.disabled).toBe(true); await click('사진 제거');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image-bytes'], 'photo.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(container.querySelector('img')).toBeTruthy(); });
    await click('인수인계 등록'); expect(props.mutate).toHaveBeenCalledWith('operations.handover.create', { date: today, body: '상품 사진', category: 'general', photo: { base64: btoa('image-bytes'), mimeType: 'image/png' } });
  });

  it('does not disclose content to non-managers without an active employee link', async () => {
    const props = fixture(false); props.permissions.self = false;
    props.workspace.operations.handovers.push({ id: 'private', date: today, body: '매장만 볼 내용', category: 'cash', authorId: 'staff', authorName: '직원', createdAt: `${today}T00:00:00Z`, resolved: false, hasPhoto: false });
    await render(props); expect(container.textContent).toContain('매장 업무 권한이 없습니다'); expect(container.textContent).not.toContain('매장만 볼 내용'); expect(container.querySelectorAll('input, button')).toHaveLength(0);
  });

  it('clears old store drafts and ignores an old request failure after scope changes', async () => {
    const props = fixture(); let reject!: (error: Error) => void; props.mutate = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    await render(props); await click('인수인계'); await click('인수인계 작성'); await fill('body', '이전 매장 내용'); await click('인수인계 등록');
    const next = fixture(); next.workspace.storeId = 'store-b'; await render(next);
    await act(async () => reject(new Error('이전 매장 오류')));
    expect(container.textContent).not.toContain('이전 매장 오류'); expect(container.querySelector('textarea')).toBeNull();
    await click('인수인계'); await click('인수인계 작성'); expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
  });

  it('encodes both photo path identifiers', () => {
    expect(storeHandoverPhotoUrl('store/one', 'photo/two')).toBe('/api/v2/oda/store%2Fone/hr/handovers/photo%2Ftwo/photo');
  });
});
