import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { calculateOdaMonth, createOdaMonth, type OdaLine, type OdaSource } from '../../../../packages/domain/src/oda-settlement';
import type { OdaResponse } from '../api/oda-client';
import { OdaExpenses } from './OdaExpenses';

const ruleMocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn() }));
vi.mock('../api/oda-client', async original => ({ ...await original<typeof import('../api/oda-client')>(), getOdaExpenseRules: ruleMocks.get, removeOdaExpenseRule: ruleMocks.remove }));
const batch = vi.fn(); const add = vi.fn(); const upload = vi.fn();
let container: HTMLDivElement; let root: Root;
function source(id = 'cost', kind: OdaSource['kind'] = 'expense'): OdaSource {
  return { id, kind, fileName: `${id}.pdf`, channel: 'manual', sha256: 'a'.repeat(64), importedAt: '2026-09-30T00:00:00Z', importedBy: 'owner', rowCount: 1, sizeBytes: 100, mimeType: 'application/pdf' };
}
function line(id: string, overrides: Partial<OdaLine> = {}): OdaLine {
  return { id, description: id, kind: 'expense', date: '2026-09-10', amount: 11000, vat: 1000, category: 'supplies', channel: 'manual', sourceId: 'cost', sourceRow: 0, externalId: '', reviewed: false, note: '', ...overrides };
}
function state(lines: OdaLine[] = [line('소모품')], sources = [source()]): OdaResponse {
  const data = createOdaMonth('oda-1', '2026-09', '2026-09-30T00:00:00Z');
  data.version = 7; data.policy.vatBasis = 'net'; data.lines = lines; data.sources = sources;
  return { data, version: 7, summary: calculateOdaMonth(data), evidence: sources, history: [], capabilities: { edit: true, confirmParty: 'A', finalize: true, pay: true, reopen: true } };
}
beforeEach(() => { vi.clearAllMocks(); ruleMocks.get.mockReset().mockResolvedValue({ version: 0, rules: [] }); ruleMocks.remove.mockReset(); batch.mockReset().mockResolvedValue(true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(value = state(), extra: Partial<ComponentProps<typeof OdaExpenses>> = {}) {
  await act(async () => root.render(<OdaExpenses state={value} storeId="oda-1" month="2026-09" editable busy={false} onBatch={batch} onAdd={add} onUpload={upload} renderLine={item => <article data-line-id={item.id}>{item.description}</article>} manual={null} recurring={null} {...extra} />));
}
function button(text: string, parent: ParentNode = container) { const found = [...parent.querySelectorAll('button')].find(item => item.textContent?.trim() === text); expect(found, text).toBeTruthy(); return found!; }
async function click(text: string, parent?: ParentNode) { await act(async () => button(text, parent).click()); }
async function selectLine(description: string) { await act(async () => container.querySelector<HTMLInputElement>(`input[aria-label="${description} 선택"]`)!.click()); }
async function set(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
function field(label: string) { const found = [...container.querySelectorAll('label')].find(item => item.textContent?.startsWith(label)); expect(found, label).toBeTruthy(); return found!.querySelector<HTMLSelectElement>('select')!; }
function rows() { return [...container.querySelectorAll<HTMLElement>('[data-line-id]')].map(item => item.dataset.lineId); }

it('shows only expenses and lets the store isolate evidence, classification, VAT, and excluded records', async () => {
  await render(state([
    line('정상 비용', { reviewed: true }), line('증빙 없는 비용', { sourceId: '' }),
    line('미분류 비용', { category: 'uncategorized' }), line('부가세 모름', { vat: null }),
    line('매장 매출', { kind: 'revenue', category: 'sales' }), line('계좌 출금', { kind: 'bank', category: 'bank', amount: -11000 }),
    line('설비 투자', { kind: 'excluded', category: 'capex' }),
  ]));
  expect(rows()).toEqual(['정상 비용', '증빙 없는 비용', '미분류 비용', '부가세 모름']);
  await click('증빙 미연결 1'); expect(rows()).toEqual(['증빙 없는 비용']);
  await click('분류 필요 1'); expect(rows()).toEqual(['미분류 비용']);
  await click('부가세 미입력 1'); expect(rows()).toEqual(['부가세 모름']);
  await click('손익 제외 1'); expect(rows()).toEqual(['설비 투자']);
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  await click('전체 비용 4'); await set(container.querySelector<HTMLInputElement>('[aria-label="비용 검색"]')!, 'cost.pdf');
  expect(rows()).toEqual(['정상 비용', '미분류 비용', '부가세 모름']);
  await set(container.querySelector<HTMLSelectElement>('[aria-label="비용 분류 필터"]')!, 'supplies');
  expect(rows()).toEqual(['정상 비용', '부가세 모름']);
});

it('uses the server P&L total and distinguishes pending recurring amounts from recognized expenses', async () => {
  const value = state([line('확인한 소모품', { reviewed: true }), line('임차료 제안', { amount: 1100000, vat: 100000, category: 'rent', sourceId: '', externalId: 'repeat:2026-08:rent' })]);
  expect(value.summary.expenses).toBe(10000); await render(value);
  expect(container.querySelector('[aria-label="비용 준비 현황"] strong')?.textContent).toBe('10,000원');
  expect(container.textContent).toContain('지난달에서 가져온 미확인 비용 1건 · 1,100,000원은 확인 전까지 손익에서 제외됩니다.');
  expect(container.textContent).toContain('잠정 금액');
});

it('sends selected IDs and the current version in one batch and clears selection only after success', async () => {
  await render(state([line('종이컵'), line('세제')])); await selectLine('세제');
  await set(field('선택 비용 분류'), 'ingredients'); await click('분류 일괄 적용');
  expect(batch).toHaveBeenCalledWith(['세제'], { category: 'ingredients' }, 7);
  expect(container.querySelector<HTMLInputElement>('[aria-label="세제 선택"]')!.checked).toBe(false);
  await selectLine('종이컵'); await click('선택 1건 확인 완료');
  expect(batch).toHaveBeenLastCalledWith(['종이컵'], { reviewed: true }, 7);
});

it('keeps selection across pages while filter, store, month, and version changes clear it', async () => {
  const value = state(Array.from({ length: 51 }, (_, index) => line(`비용 ${index}`)));
  await render(value); await click('현재 페이지 선택'); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(50);
  await click('다음 비용'); await selectLine('비용 50'); expect(container.textContent).toContain('선택 51건');
  await click('이전 비용'); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(50);
  await click('확인 필요 51'); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(0);
  await selectLine('비용 0'); await render({ ...value, version: 8 }); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(0);
  await selectLine('비용 0'); await render({ ...value, version: 8 }, { storeId: 'oda-2' }); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(0);
  await selectLine('비용 0'); await render({ ...value, version: 8 }, { storeId: 'oda-2', month: '2026-10' }); expect(container.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(0);
});

it('never confirms a selected row without evidence, classification, or required VAT', async () => {
  await render(state([line('증빙 필요', { sourceId: '' }), line('분류 필요', { category: 'uncategorized' }), line('부가세 필요', { vat: null }), line('준비 완료')]));
  for (const description of ['증빙 필요', '분류 필요', '부가세 필요']) {
    await selectLine(description); expect(button('선택 1건 확인 완료').disabled).toBe(true); await click('선택 1건 확인 완료'); await click('선택 해제');
  }
  expect(batch).not.toHaveBeenCalled(); await selectLine('준비 완료'); expect(button('선택 1건 확인 완료').disabled).toBe(false);
  const gross = state([line('부가세 선택', { vat: null })]); gross.data.policy.vatBasis = 'gross'; gross.summary = calculateOdaMonth(gross.data);
  await render({ ...gross, version: 8 }); await selectLine('부가세 선택'); expect(button('선택 1건 확인 완료').disabled).toBe(false);
});

it('connects one current proof to unlinked costs and prevents replacing an existing original', async () => {
  await render(state([line('영수증 대기', { sourceId: '' }), line('원본 보관')], [source(), source('receipt', 'evidence'), source('bank', 'bank')]));
  await selectLine('영수증 대기');
  expect([...field('선택 비용에 연결할 증빙').options].map(option => option.value)).toEqual(['', 'cost', 'receipt']);
  await set(field('선택 비용에 연결할 증빙'), 'receipt'); await click('증빙 일괄 연결');
  expect(batch).toHaveBeenCalledWith(['영수증 대기'], { sourceId: 'receipt' }, 7);
  await selectLine('원본 보관'); await set(field('선택 비용에 연결할 증빙'), 'receipt');
  expect(button('증빙 일괄 연결').disabled).toBe(true);
});

it('locks a failed stale batch until refreshed data arrives and does not silently retry', async () => {
  batch.mockResolvedValue(false); const value = state(); await render(value); await selectLine('소모품'); await click('선택 1건 확인 완료');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('정산 새로고침');
  expect(button('선택 1건 확인 완료').disabled).toBe(true); await click('선택 1건 확인 완료'); expect(batch).toHaveBeenCalledTimes(1);
  await render(structuredClone(value)); expect(container.querySelector('[role=alert]')).toBeNull();
  await selectLine('소모품'); expect(button('선택 1건 확인 완료').disabled).toBe(false);
});

it('offers first-cost creation and preselects an unattached proof without creating duplicate records automatically', async () => {
  await render(state([], [source('new-receipt', 'evidence'), source('bank-only', 'bank')]));
  expect(container.textContent).toContain('첫 비용을 추가해 보세요');
  expect(container.querySelector('[aria-label="비용 준비 현황"] strong')?.textContent).toBe('—');
  expect(batch).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
  await click('비용 직접 추가'); expect(add).toHaveBeenLastCalledWith();
  await click('파일·영수증 넣기'); expect(upload).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('.oda-evidence')).toHaveLength(1);
  await click('비용 추가', container.querySelector('.oda-evidence')!); expect(add).toHaveBeenLastCalledWith('new-receipt');
});

it('keeps read-only and finalized costs viewable and limits exports to the displayed store and month', async () => {
  const value = state(); value.data.status = 'finalized';
  await render(value, { editable: false, storeId: 'oda/2', month: '2026-08' });
  expect(rows()).toEqual(['소모품']); expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect([...container.querySelectorAll('button')].some(item => /비용 직접 추가|파일·영수증 넣기|확인 완료|일괄/.test(item.textContent ?? ''))).toBe(false);
  const bundle = [...container.querySelectorAll('a')].find(item => item.textContent?.includes('비용·증빙 묶음 받기'))!;
  expect(bundle.getAttribute('href')).toBe('/api/v2/oda/oda%2F2/2026-08/expenses/export.zip');
  expect(container.textContent).toContain('확정 금액'); expect(batch).not.toHaveBeenCalled();
});


it('remembers a category only when explicitly selected and sends the loaded rule version with the monthly version', async () => {
  ruleMocks.get.mockResolvedValue({ version: 3, rules: [] }); await render(); await selectLine('소모품');
  await set(field('선택 비용 분류'), 'ingredients');
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('다음에도 같은 거래 내용'))!.querySelector<HTMLInputElement>('input')!;
  expect(checkbox.checked).toBe(false); await act(async () => checkbox.click()); await click('분류 일괄 적용');
  expect(batch).toHaveBeenCalledWith(['소모품'], { category: 'ingredients' }, 7, { rememberCategory: true, expectedExpenseRulesVersion: 3 });
});
it('shows stored classifications, removes future matching only, and reloads after a rule conflict', async () => {
  const remembered = { version: 3, rules: [{ id: 'rule-1', description: 'ABC 매장', category: 'supplies', updatedAt: '2026-09-01T00:00:00Z' }] };
  ruleMocks.get.mockResolvedValue(remembered); ruleMocks.remove.mockRejectedValueOnce(new Error('분류가 변경되었습니다'));
  await render(); expect(container.textContent).toContain('기억한 분류 1개 관리'); expect(container.textContent).toContain('ABC 매장');
  await click('기억 해제'); expect(ruleMocks.remove).toHaveBeenCalledWith('oda-1', 'rule-1', 3); expect(container.querySelector('[role=alert]')?.textContent).toContain('분류가 변경');
  await click('분류 목록 새로고침'); ruleMocks.remove.mockResolvedValue({ version: 4, rules: [] }); await click('기억 해제');
  expect(rows()).toEqual(['소모품']); expect(batch).not.toHaveBeenCalled(); expect(container.textContent).toContain('아직 기억한 분류가 없습니다');
});
it('keeps ordinary editing available after rule retrieval fails and ignores a late reply for a different store', async () => {
  ruleMocks.get.mockRejectedValueOnce(new Error('분류 연결 오류')); await render(); await selectLine('소모품');
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('다음에도 같은 거래 내용'))!.querySelector<HTMLInputElement>('input')!;
  expect(checkbox.disabled).toBe(true); await set(field('선택 비용 분류'), 'labor'); await click('분류 일괄 적용'); expect(batch).toHaveBeenCalledWith(['소모품'], { category: 'labor' }, 7);
  let resolve!: (value: unknown) => void; ruleMocks.get.mockImplementationOnce(() => new Promise(finish => { resolve = finish; }));
  await click('분류 목록 새로고침'); const signal = ruleMocks.get.mock.calls.at(-1)![1] as AbortSignal;
  await render(state(), { storeId: 'oda-2' }); expect(signal.aborted).toBe(true);
  await act(async () => resolve({ version: 10, rules: [{ id: 'foreign', description: '다른 매장 거래', category: 'labor' }] }));
  expect(container.textContent).not.toContain('다른 매장 거래');
});
it('keeps the applied rule visible after manual corrections for later evidence review', async () => {
  await render(state([line('ABC 매장', { category: 'labor', categoryRule: { id: 'rule-1', version: 2, description: 'ABC 매장', category: 'supplies' } })]));
  expect(container.textContent).toContain('기억한 분류 적용 후 수정');
});

it('reloads rules when the same monthly version is refreshed after another user changes only the rules', async () => {
  ruleMocks.get.mockResolvedValueOnce({ version: 1, rules: [] }).mockResolvedValueOnce({ version: 2, rules: [] });
  const value = state(); await render(value); await render({ ...value }); await selectLine('소모품');
  await set(field('선택 비용 분류'), 'labor');
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('다음에도 같은 거래 내용'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => checkbox.click()); await click('분류 일괄 적용');
  expect(batch).toHaveBeenCalledWith(['소모품'], { category: 'labor' }, 7, { rememberCategory: true, expectedExpenseRulesVersion: 2 });
});

it('does not replace refreshed rules with a late removal response', async () => {
  const original = { version: 3, rules: [{ id: 'old', description: '이전 분류', category: 'supplies' }] };
  const refreshed = { version: 5, rules: [{ id: 'current', description: '새로 기억한 분류', category: 'labor' }] };
  ruleMocks.get.mockResolvedValueOnce(original).mockResolvedValueOnce(refreshed);
  let finish!: (value: unknown) => void;
  ruleMocks.remove.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const value = state(); await render(value); await click('기억 해제');
  await render({ ...value });
  await act(async () => finish({ version: 4, rules: [] }));
  expect(container.textContent).toContain('새로 기억한 분류');
  await selectLine('소모품'); await set(field('선택 비용 분류'), 'labor');
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('다음에도 같은 거래 내용'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => checkbox.click()); await click('분류 일괄 적용');
  expect(batch).toHaveBeenCalledWith(['소모품'], { category: 'labor' }, 7, { rememberCategory: true, expectedExpenseRulesVersion: 5 });
});

it('ignores a previous store removal failure without unlocking the current store removal', async () => {
  ruleMocks.get.mockResolvedValue({ version: 3, rules: [{ id: 'rule', description: '매장 분류', category: 'supplies' }] });
  let failPrevious!: (error: Error) => void;
  let finishCurrent!: (value: unknown) => void;
  ruleMocks.remove.mockImplementationOnce(() => new Promise((_resolve, reject) => { failPrevious = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishCurrent = resolve; }));
  await render(); await click('기억 해제');
  await render(state(), { storeId: 'oda-2' });
  expect(button('기억 해제').disabled).toBe(false);
  await click('기억 해제');
  await act(async () => failPrevious(new Error('이전 매장 삭제 오류')));
  expect(container.textContent).not.toContain('이전 매장 삭제 오류');
  expect(button('기억 해제').disabled).toBe(true);
  await act(async () => finishCurrent({ version: 4, rules: [] }));
  expect(container.textContent).toContain('아직 기억한 분류가 없습니다');
});
