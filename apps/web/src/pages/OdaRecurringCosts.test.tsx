import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OdaRecurringCosts } from './OdaRecurringCosts';
import type { OdaRecurringPreview } from '../api/oda-client';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../api/oda-client', () => ({ getOdaRecurringPreview: mocks.get }));
let container: HTMLDivElement; let root: Root;
const save = vi.fn();
const row = (lineId: string, status: 'available' | 'similar' | 'already_added') => ({ lineId, status, description: lineId,
  category: 'rent', amount: 1100000, vat: 100000, previousDate: '2026-08-01', matchCount: status === 'similar' ? 1 : 0,
  matches: status === 'similar' ? [{ lineId: 'current', date: '2026-09-01', description: '당월 월세', amount: 1100000 }] : [] });
const preview = (): OdaRecurringPreview => ({ month: '2026-09', previousMonth: '2026-08', previousVersion: 8, targetVersion: 3,
  status: 'available', rows: [row('임차료', 'available'), row('관리비', 'similar'), row('급여', 'already_added')] });
beforeEach(() => { mocks.get.mockReset().mockResolvedValue(preview()); save.mockReset().mockResolvedValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(storeId = 'oda-1', version = 3) { await act(async () => root.render(<OdaRecurringCosts key={storeId} storeId={storeId} month="2026-09" version={version} disabled={false} onImport={save} />)); }
function button(text: string) { const value = [...container.querySelectorAll('button')].find(item => item.textContent === text); expect(value, text).toBeTruthy(); return value!; }
async function click(text: string) { await act(async () => button(text).click()); }
it('loads only on demand, selects missing costs, and sends both captured versions with explicit similar-cost acknowledgement', async () => {
  await render(); expect(mocks.get).not.toHaveBeenCalled();
  await click('지난달 비용 미리보기');
  expect(save).not.toHaveBeenCalled();
  const checks = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  expect(checks.map(input => input.checked)).toEqual([true, false, false]); expect(checks[2]!.disabled).toBe(true);
  expect(container.textContent).toContain('당월 월세'); expect(container.textContent).toContain('손익에 포함하지 않습니다');
  await act(async () => checks[1]!.click());
  await click('선택한 2건 확인 대기로 가져오기');
  expect(save).toHaveBeenCalledWith({ expectedVersion: 3, previousVersion: 8, lineIds: ['임차료', '관리비'], confirmedSimilarLineIds: ['관리비'] });
  expect(container.querySelector('[aria-label="지난달 반복 비용 선택"]')).toBeNull();
});
it('does not treat missing or unfinalized prior months as zero-valued costs', async () => {
  mocks.get.mockResolvedValue({ ...preview(), status: 'missing', previousVersion: null, rows: [] });
  await render(); await click('지난달 비용 미리보기');
  expect(container.textContent).toContain('2026-08 정산이 아직 등록되지 않았습니다.');
  expect(container.querySelector('input[type=checkbox]')).toBeNull(); expect(save).not.toHaveBeenCalled();
  mocks.get.mockResolvedValue({ ...preview(), status: 'unfinalized', rows: [] });
  await click('비용 목록 다시 불러오기'); expect(container.textContent).toContain('아직 확정되지 않았습니다.');
});
it('keeps a failed save visible and requires refreshing stale candidates before retry', async () => {
  save.mockResolvedValue(false); await render(); await click('지난달 비용 미리보기');
  await click('선택한 1건 확인 대기로 가져오기');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('최신 비용 목록');
  expect(button('선택한 1건 확인 대기로 가져오기').disabled).toBe(true);
  mocks.get.mockResolvedValue({ ...preview(), targetVersion: 4 });
  await click('비용 목록 다시 불러오기'); expect(button('선택한 1건 확인 대기로 가져오기').disabled).toBe(false);
});
it('discards delayed replies for another store and reloads when the current month version changes', async () => {
  let finish!: (value: OdaRecurringPreview) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await click('지난달 비용 미리보기'); const signal = mocks.get.mock.calls[0]![2] as AbortSignal;
  await render('oda-2'); expect(signal.aborted).toBe(true);
  await act(async () => finish(preview())); expect(container.textContent).not.toContain('임차료');
  await click('지난달 비용 미리보기'); await render('oda-2', 4);
  expect(mocks.get).toHaveBeenCalledTimes(3);
});
it('keeps selection across pages and offers one action to deselect all costs', async () => {
  mocks.get.mockResolvedValue({ ...preview(), rows: Array.from({ length: 21 }, (_, i) => row(`비용${i}`, 'available')) });
  await render(); await click('지난달 비용 미리보기'); expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(20);
  await click('다음 비용'); expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
  expect(container.textContent).toContain('선택 21건'); await click('선택 해제');
  expect(button('선택한 0건 확인 대기로 가져오기').disabled).toBe(true);
});
