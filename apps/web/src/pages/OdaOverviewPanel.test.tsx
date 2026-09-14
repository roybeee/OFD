import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OdaOverviewRow } from '../api/oda-client';
import { OdaOverviewPanel, previousOdaMonth } from './OdaOverviewPanel';
import { odaSettlementLocation } from './OdaSettlementPage';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../api/oda-client', async original => ({ ...await original<typeof import('../api/oda-client')>(), getOdaOverview: mocks.get }));
const row: OdaOverviewRow = { amountBasis: '부가세 포함', storeId: 'store-1', storeName: '외대점', month: '2026-08', updatedAt: null, status: 'not_started', revenue: null, expenses: null, profit: null, payableB: null, sourceCount: 0, reviewCount: 0, blockerCount: 0, overdue: false, dueDate: null, nextAction: '자료 넣기', tab: 'transactions', anchor: '' };
const response = (month = '2026-08', rows = [row], page = 1, total = rows.length) => ({ month, page, pageSize: 20, total, rows });
let container: HTMLDivElement; let root: Root;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(label: string) { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label)); expect(button).toBeTruthy(); button!.click(); }); }
async function changeMonth(month: string) { await act(async () => { const input = container.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, month); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
it('opens last month by default, distinguishes missing data from zero sales, and carries the chosen month into settlement', async () => {
  mocks.get.mockResolvedValue(response()); const navigate = vi.fn();
  await act(async () => root.render(<OdaOverviewPanel operationalDate="2026-09-15" onNavigate={navigate} />));
  expect(previousOdaMonth('2026-01-03')).toBe('2025-12');
  expect(mocks.get).toHaveBeenCalledWith('2026-08', 1, expect.any(AbortSignal));
  expect(container.textContent).toContain('자료 미등록'); expect(container.textContent).not.toContain('0원');
  await click('자료 넣기'); expect(navigate).toHaveBeenCalledWith('/hq/oda-settlement?tab=transactions&store=store-1&month=2026-08');
  expect(odaSettlementLocation('?month=2026-08&store=store-1&tab=transactions', [{ id: 'store-1' }])).toEqual({ month: '2026-08', storeId: 'store-1', tab: 'transactions' });
  expect(odaSettlementLocation('?month=2026-99', [])).not.toHaveProperty('month');
});
it('shows confirmed totals and deadline with a direct payment action', async () => {
  mocks.get.mockResolvedValue(response('2026-08', [{ ...row, status: 'finalized', revenue: 30000000, expenses: 10000000, profit: 20000000, payableB: 9350000, dueDate: '2026-09-10', overdue: true, nextAction: '지급 기록하기', tab: 'overview', anchor: 'oda-payment' }]));
  const navigate = vi.fn(); await act(async () => root.render(<OdaOverviewPanel operationalDate="2026-09-15" onNavigate={navigate} />));
  expect(container.textContent).toContain('지급 대기'); expect(container.textContent).toContain('9,350,000원'); expect(container.textContent).toContain('기한 지남');
  await click('지급 기록하기'); expect(navigate).toHaveBeenCalledWith('/hq/oda-settlement?tab=overview&store=store-1&month=2026-08#oda-payment');
});
it('ignores a late previous-month response and clears displayed amounts while loading another month', async () => {
  let finish!: (value: unknown) => void;
  mocks.get.mockImplementation((month: string) => month === '2026-08' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response(month, [{ ...row, storeName: '새 월 자료', month }])));
  await act(async () => root.render(<OdaOverviewPanel operationalDate="2026-09-15" onNavigate={vi.fn()} />));
  const oldSignal = mocks.get.mock.calls[0]![2] as AbortSignal;
  await changeMonth('2026-07'); expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(response('2026-08', [{ ...row, storeName: '이전 요청 응답' }])));
  expect(container.textContent).toContain('새 월 자료'); expect(container.textContent).not.toContain('이전 요청 응답');
});
it('supports retry, paging, and resetting the page when the month changes', async () => {
  mocks.get.mockRejectedValueOnce(new Error('연결을 확인해 주세요.')).mockImplementation((month: string, page: number) => Promise.resolve(response(month, [row], page, 25)));
  await act(async () => root.render(<OdaOverviewPanel operationalDate="2026-09-15" onNavigate={vi.fn()} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('연결을 확인');
  await click('현황 다시 불러오기'); await click('다음 매장');
  expect(mocks.get).toHaveBeenLastCalledWith('2026-08', 2, expect.any(AbortSignal));
  await changeMonth('2026-07'); expect(mocks.get).toHaveBeenLastCalledWith('2026-07', 1, expect.any(AbortSignal));
});
