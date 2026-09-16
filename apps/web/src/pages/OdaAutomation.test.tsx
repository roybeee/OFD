import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OdaAutomation } from './OdaAutomation';
let container: HTMLDivElement; let root: Root;
const fetched = vi.fn(); const onApplied = vi.fn();
const row = { externalRef: 'sale-1', date: '2026-08-31', kind: 'revenue', channel: 'baemin', category: 'sales', description: '배달 매출', amountKrw: 11000, vatKrw: 1000, status: 'new' };
const batch = { id: 'batch-1', digest: 'a'.repeat(64), status: 'awaiting_approval', createdAt: '2026-09-16T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  input: { source: { system: 'ASIDE', accountRef: 'synthetic', url: 'https://example.com', capturedAt: '2026-09-16T00:00:00Z' }, lines: [row] },
  preview: { added: 1, duplicates: 0, conflicts: [], revenueKrw: 11000, expenseKrw: 0, rows: [row] } };
beforeEach(() => { fetched.mockReset(); onApplied.mockReset(); vi.stubGlobal('fetch', fetched); fetched.mockImplementation(async (path: string) => ({ ok: true, json: async () =>
  path.includes('/tokens?') ? { tokens: [] } : path.includes('/batches?') ? { batches: [batch] } : path.endsWith('/approve') ? { ...batch, status: 'committed', result: { added: 1, duplicates: 0 } } : batch }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(canManage = true) { await act(async () => root.render(<OdaAutomation storeId="store-1" month="2026-08" canManage={canManage} onApplied={onApplied} />)); }
function button(text: string) { const found = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(found, text).toBeTruthy(); return found!; }
it('shows exact rows before approval and sends immutable digest in one approve-and-commit action', async () => {
  await render(); expect(onApplied).not.toHaveBeenCalled();
  await act(async () => button('내역 확인').click()); expect(container.textContent).toContain('sale-1'); expect(container.textContent).toContain('11,000원');
  await act(async () => button('승인 후 반영').click());
  const call = fetched.mock.calls.find(([path]) => path.endsWith('/approve'))!;
  expect(JSON.parse(call[1].body)).toEqual({ digest: batch.digest, commit: true }); expect(onApplied).toHaveBeenCalledOnce();
});
it('blocks conflicting previews and hides token management for finance reviewers', async () => {
  fetched.mockImplementation(async (path: string) => ({ ok: true, json: async () => path.includes('/batches?') ? { batches: [batch] } : { ...batch, preview: { ...batch.preview, conflicts: ['sale-1'] } } }));
  await render(false); expect(container.textContent).not.toContain('연결 암호 발급');
  await act(async () => button('내역 확인').click()); expect(button('승인 후 반영').disabled).toBe(true); expect(container.textContent).toContain('기존 자료와 다른 거래');
});
it('keeps server rejection visible without reporting success', async () => {
  await render(); await act(async () => button('내역 확인').click());
  fetched.mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'ODA_MONTH_LOCKED', message: '확정된 정산월입니다.' } }) }));
  await act(async () => button('승인 후 반영').click()); expect(container.querySelector('[role=alert]')?.textContent).toContain('확정된 정산월입니다.'); expect(onApplied).not.toHaveBeenCalled();
});
