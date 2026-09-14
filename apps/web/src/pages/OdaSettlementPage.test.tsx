import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateOdaMonth, createOdaMonth, type OdaLine, type OdaSource } from '../../../../packages/domain/src/oda-settlement';
import type { BootstrapData } from '../types';
import type { OdaResponse } from '../api/oda-client';
import { OdaSettlementPage } from './OdaSettlementPage';

const mocks = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn(), prepare: vi.fn(), preview: vi.fn() }));
vi.mock('../api/oda-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/oda-client')>(),
  getOdaMonth: mocks.get, odaMutation: mocks.mutate, prepareOdaFile: mocks.prepare, previewOdaImport: mocks.preview,
}));

const baseData: BootstrapData = {
  actor: { id: 'owner-a', name: '운영자 A', role: 'store_owner' },
  store: { id: 'oda-1', name: 'ODA 외대점', businessName: 'ODA 외대점', billingPolicy: '월 정산', paymentTerm: '익월 10일' },
  stores: [{ id: 'oda-1', name: 'ODA 외대점' }, { id: 'oda-2', name: 'ODA 두 번째 매장' }],
  products: [], orders: [], deliveries: [], bankMatches: [], paymentRequests: [], bankTransactions: [], manualMatchCandidates: [],
  settlements: [], invoices: [], documents: [], drivers: [], generatedAt: '2026-10-02T00:00:00Z', capabilities: [], allowedDeliveryDates: [], routeDates: [],
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false, operationalDate: '2026-09-30' },
};
function source(id: string, kind: OdaSource['kind']): OdaSource {
  return { id, kind, channel: 'pos', fileName: `${id}.csv`, sha256: 'a'.repeat(64), importedAt: '2026-10-02T00:00:00Z', importedBy: 'owner-a', rowCount: 1, sizeBytes: 100, mimeType: 'text/csv' };
}
function line(id: string, kind: OdaLine['kind'], amount: number, overrides: Partial<OdaLine> = {}): OdaLine {
  return { id, kind, amount, date: '2026-09-30', description: id, vat: 0, category: kind === 'revenue' ? 'sales' : kind === 'bank' ? 'bank' : 'ingredients', channel: 'pos', sourceId: kind === 'revenue' ? 'pos' : 'cost', sourceRow: 2, externalId: '', reviewed: true, note: '', ...overrides };
}
function response(): OdaResponse {
  const data = createOdaMonth('oda-1', '2026-09', '2026-10-02T00:00:00Z');
  data.version = 4;
  data.policy = { ...data.policy, vatBasis: 'gross', attributionBasis: 'accrual', posDeliveryScope: 'excluded', bVatPolicy: 'add10', agreementNote: '귀속월 손익과 세금계산서 가산 기준을 양측 확인함', acknowledgements: {
    A: { actorId: 'owner-a', actorName: '운영자 A', at: '2026-10-02T00:00:00Z' },
    B: { actorId: 'partner-b', actorName: '지원자 B', at: '2026-10-02T00:00:00Z' },
  } };
  data.sources = [source('pos', 'pos'), source('cost', 'expense')];
  data.lines = [line('월 마감 매출', 'revenue', 30_000_000), line('식재료 매입', 'expense', 20_000_000)];
  return { data, summary: calculateOdaMonth(data), version: 4, evidence: data.sources, history: [], capabilities: { edit: true, confirmParty: 'A', finalize: true, pay: true, reopen: true } };
}

describe('ODA 월 정산 업무 흐름', () => {
  let container: HTMLDivElement;
  let root: Root;
  const notify = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(data = baseData) { await act(async () => { root.render(<OdaSettlementPage data={data} notify={notify} />); }); }
  function button(text: string, parent: ParentNode = container): HTMLButtonElement {
    const found = [...parent.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
    expect(found, `버튼을 찾을 수 없음: ${text}`).toBeTruthy(); return found!;
  }
  async function click(text: string, parent?: ParentNode) { await act(async () => button(text, parent).click()); }
  async function set(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
  }
  function field(label: string) { const match = [...container.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label)); expect(match, label).toBeTruthy(); return match!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')!; }
  async function chooseFile(filename: string) {
    const input = container.querySelector<HTMLInputElement>('[aria-label="정산 파일 선택"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [new File(['test'], filename)] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
  }

  it('선택된 매장·정산월을 읽고 저이익 배분은 확인 필요로 표시하며 확정을 막는다', async () => {
    const first = response(); first.data.lines[0]!.amount = 22_000_000; first.summary = calculateOdaMonth(first.data);
    mocks.get.mockResolvedValue(first);
    await render();
    expect(mocks.get).toHaveBeenCalledWith('oda-1', '2026-09', expect.any(AbortSignal));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="정산 매장"]')!.value).toBe('oda-1');
    expect(container.querySelector<HTMLInputElement>('[aria-label="정산월"]')!.value).toBe('2026-09');
    expect(container.textContent).toContain('저이익·적자월은 합의 없이 확정하지 않습니다.');
    expect(container.textContent).toContain('확인 필요');
    expect(container.textContent).not.toMatch(/NaN|undefined|Infinity/);
    expect(button('정산서 확정').disabled).toBe(true);
    await set(container.querySelector<HTMLSelectElement>('[aria-label="정산 매장"]')!, 'oda-2');
    expect(mocks.get).toHaveBeenLastCalledWith('oda-2', '2026-09', expect.any(AbortSignal));
  });

  it('감사자는 자료를 열람하되 거래·기준·메모의 변경 기능을 실행할 수 없다', async () => {
    const state = response(); state.capabilities = { edit: false, confirmParty: null, finalize: false, pay: false, reopen: false };
    mocks.get.mockResolvedValue(state);
    await render({ ...baseData, actor: { id: 'auditor', name: '감사자', role: 'auditor' } });
    expect(container.querySelector('[aria-label="정산 자료 업로드"]')).toBeNull();
    expect(button('정산서 확정').disabled).toBe(true);
    await click('거래·증빙'); await click('전체');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="식재료 매입 상세 열기"]')!.click());
    const row = container.querySelector<HTMLButtonElement>('[aria-label="식재료 매입 상세 닫기"]')!.closest('article')!;
    expect(button('수정만 저장', row).disabled).toBe(true);
    expect(button('확인 완료', row).disabled).toBe(true);
    await click('정산 기준');
    expect(button('정산 기준 저장').disabled).toBe(true);
    await click('변경 기록');
    const textarea = container.querySelector<HTMLTextAreaElement>('.oda-comment-form textarea');
    if (textarea && !textarea.disabled) await set(textarea, '감사자 테스트 메모');
    const memo = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('메모 기록'));
    expect(memo === undefined || memo.disabled).toBe(true);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('계좌 출금은 명시적으로 비용 전환하고 원본 계좌행을 유지한다', async () => {
    const state = response(); const bank = line('bank-1', 'bank', -100_000, { description: '월세 출금', sourceId: 'bank', category: 'bank' });
    state.data.sources.push(source('bank', 'bank')); state.data.lines.push(bank); state.summary = calculateOdaMonth(state.data);
    mocks.get.mockResolvedValue(state);
    const changed = structuredClone(state); changed.version = 5; changed.data.version = 5;
    changed.data.lines.push(line('derived-1', 'expense', 100_000, { description: '월세 출금', category: 'rent', sourceId: 'bank', bankLineId: bank.id })); changed.summary = calculateOdaMonth(changed.data);
    mocks.mutate.mockResolvedValue(changed);
    await render(); await click('거래·증빙'); await click('계좌');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="월세 출금 상세 열기"]')!.click());
    await set(field('비용 반영 시 분류'), 'rent');
    await click('출금 100,000원 비용으로 반영');
    expect(mocks.mutate).toHaveBeenCalledWith('oda-1', '2026-09', '/bank-expense', 4, { bankLineId: 'bank-1', category: 'rent', vat: 0, note: '' });
    expect(container.querySelector('.oda-line')?.textContent).toContain('−100,000'.replace('−', '-'));
    expect(container.querySelector('.oda-line')?.textContent).toContain('손익에 합산하지 않음');
    await click('전체');
    expect([...container.querySelectorAll('.oda-line')].filter((item) => item.textContent?.includes('월세 출금'))).toHaveLength(2);
    expect(bank.kind).toBe('bank'); expect(bank.amount).toBe(-100_000);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('원본 계좌 내역은 그대로 보관'), 'success');
  });

  it('파일 선택으로 미리보기를 실행하고 오류가 있으면 원본 반영을 실행하지 않는다', async () => {
    const state = response(); state.data.lines = []; state.data.sources = []; state.summary = calculateOdaMonth(state.data); mocks.get.mockResolvedValue(state);
    mocks.prepare.mockResolvedValue({ filename: '매출.csv', kind: 'pos', channel: 'pos', contentBase64: 'dGVzdA==' });
    mocks.preview.mockRejectedValue(new Error('금액 열을 확인해 주세요.'));
    await render();
    const file = new File(['date,amount\n2026-09-01,bad'], '매출.csv', { type: 'text/csv' });
    const input = container.querySelector<HTMLInputElement>('[aria-label="정산 파일 선택"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(mocks.prepare).toHaveBeenCalledWith(file, 'pos', 'pos');
    expect(mocks.preview).toHaveBeenCalledWith('oda-1', '2026-09', expect.objectContaining({ filename: '매출.csv' }));
    expect(container.textContent).toContain('금액 열을 확인해 주세요.');
    expect(button('1개 자료 반영').disabled).toBe(true);
    await click('1개 자료 반영'); expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('기준 변경 저장에는 서명을 보내지 않고 서버가 해제한 양측 확인을 화면에 반영한다', async () => {
    const state = response(); mocks.get.mockResolvedValue(state);
    const changed = structuredClone(state); changed.version = 5; changed.data.version = 5; changed.data.policy.vatBasis = 'net'; changed.data.policy.acknowledgements = {}; changed.summary = calculateOdaMonth(changed.data);
    mocks.mutate.mockResolvedValue(changed);
    await render(); await click('정산 기준');
    expect(container.textContent).toContain('통상 운영 범위를 벗어나는 100만원 이상 투자');
    expect(container.textContent).not.toMatch(/7[,]?000만원|70[,]?000[,]?000/);
    await set(field('손익의 부가세 기준'), 'net'); await click('정산 기준 저장');
    const call = mocks.mutate.mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual(['oda-1', '2026-09', '/save', 4]);
    expect(call[4].policy.vatBasis).toBe('net'); expect(call[4].policy).not.toHaveProperty('acknowledgements');
    expect(container.querySelector('.oda-approval')?.textContent?.match(/확인 대기/g)).toHaveLength(2);
    await click('월 정산'); expect(button('정산서 확정').disabled).toBe(true);
  });

  it('동시 수정 충돌을 사용자에게 알리고 최신 저장본을 가장하지 않는다', async () => {
    mocks.get.mockResolvedValue(response());
    mocks.mutate.mockRejectedValue(new Error('다른 사용자가 먼저 수정했습니다. 최신 정산을 다시 불러와 주세요.'));
    await render(); await click('정산서 확정');
    expect(mocks.mutate).toHaveBeenCalledWith('oda-1', '2026-09', '/finalize', 4, {});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('다른 사용자가 먼저 수정했습니다.');
    expect(container.textContent).toContain('저장본 v4'); expect(container.textContent).toContain('정산 준비 중');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('다른 사용자가 먼저 수정'), 'warning');
  });

  it('자료 종류 변경·파일 추가·탭 이동 후에도 대기 자료를 유지하고 오류 파일만 제거한다', async () => {
    mocks.get.mockResolvedValue(response());
    mocks.prepare.mockImplementation(async (file: File, kind: string, channel: string) => ({ filename: file.name, kind, channel, contentBase64: 'dGVzdA==' }));
    mocks.preview.mockImplementation(async (_store: string, _month: string, input: { filename: string }) => {
      if (input.filename === '오류.csv') throw new Error('금액 열 확인 필요');
      return { lines: [], errors: [], warnings: [], duplicateCount: 0 };
    });
    await render(); await click('거래·증빙');
    await chooseFile('매출.csv');
    await set(field('어떤 자료인가요?'), 'expense');
    await chooseFile('비용.csv'); await chooseFile('오류.csv');
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(3);
    expect(button('준비된 2개 자료 반영').disabled).toBe(false);
    await click('정산 기준'); await click('거래·증빙');
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(3);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="오류.csv 업로드 목록에서 제거"]')!.click());
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(2);
    expect(button('2개 자료 반영').disabled).toBe(false);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('정상 파일만 먼저 저장해도 오류 파일은 남고 첫 저장으로 업로드 화면이 사라지지 않는다', async () => {
    const empty = response(); empty.data.lines = []; empty.data.sources = []; empty.summary = calculateOdaMonth(empty.data);
    mocks.get.mockResolvedValue(empty);
    mocks.prepare.mockImplementation(async (file: File, kind: string, channel: string) => ({ filename: file.name, kind, channel, contentBase64: 'dGVzdA==' }));
    mocks.preview.mockImplementation(async (_store: string, _month: string, input: { filename: string }) => ({ lines: [], errors: input.filename === '오류.csv' ? [{ row: 2, message: '귀속일 확인 필요' }] : [], warnings: [], duplicateCount: 0 }));
    mocks.mutate.mockResolvedValue(response());
    await render(); await chooseFile('정상.csv'); await chooseFile('오류.csv');
    await click('준비된 1개 자료 반영');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith('oda-1', '2026-09', '/import', 4, expect.objectContaining({ filename: '정상.csv' }));
    expect(container.querySelector('.oda-upload-panel')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(1);
    expect(container.querySelector('.oda-preview-file')?.textContent).toContain('오류.csv');
    expect(button('1개 자료 반영').disabled).toBe(true);
  });

  it('저장한 열 연결은 같은 매장·출처의 열 구성이 일치할 때만 자동 적용한다', async () => {
    const headers = ['사용일', '총결제액'];
    localStorage.setItem('oda:import-profile:v1:oda-1:pos:pos', JSON.stringify({ headerRow: 3, sheetName: '', headers, columnMap: { date: '사용일', amount: '총결제액' } }));
    mocks.get.mockResolvedValue(response());
    mocks.prepare.mockImplementation(async (file: File, kind: string, channel: string) => ({ filename: file.name, kind, channel, contentBase64: 'dGVzdA==' }));
    mocks.preview.mockImplementation(async (_store: string, _month: string, input: { filename: string }) => ({ lines: [], errors: [], warnings: [], duplicateCount: 0, workbook: { sheetNames: ['Sheet1'], sheetName: 'Sheet1', headers: input.filename === '같은양식.xlsx' ? headers : ['입금일', '입금액'] } }));
    await render(); await click('거래·증빙'); await chooseFile('같은양식.xlsx');
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(mocks.preview).toHaveBeenLastCalledWith('oda-1', '2026-09', expect.objectContaining({ headerRow: 3, columnMap: { date: '사용일', amount: '총결제액' } }));
    await chooseFile('다른양식.xlsx');
    expect(mocks.preview).toHaveBeenCalledTimes(3);
    expect(mocks.preview.mock.lastCall?.[2]).not.toHaveProperty('columnMap');
  });

  it('여러 파일을 순서대로 저장하며 첫 반영 후에도 남은 파일과 진행률을 유지한다', async () => {
    const empty = response(); empty.data.lines = []; empty.data.sources = []; empty.summary = calculateOdaMonth(empty.data);
    mocks.get.mockResolvedValue(empty);
    mocks.prepare.mockImplementation(async (file: File, kind: string, channel: string) => ({ filename: file.name, kind, channel, contentBase64: 'dGVzdA==' }));
    mocks.preview.mockResolvedValue({ lines: [], errors: [], warnings: [], duplicateCount: 0 });
    const first = response(); first.version = 5; first.data.version = 5;
    const second = structuredClone(first); second.version = 6; second.data.version = 6;
    let finish!: (state: OdaResponse) => void;
    mocks.mutate.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise<OdaResponse>((resolve) => { finish = resolve; }));
    await render(); await chooseFile('첫파일.csv'); await chooseFile('두번째.csv');
    await click('2개 자료 반영');
    expect(mocks.mutate).toHaveBeenNthCalledWith(2, 'oda-1', '2026-09', '/import', 5, expect.objectContaining({ filename: '두번째.csv' }));
    expect(container.querySelector('[aria-label="자료 저장 진행"]')?.getAttribute('value')).toBe('1');
    expect(container.querySelector('.oda-upload-panel')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(1);
    await act(async () => finish(second));
    expect(container.querySelectorAll('.oda-preview-file')).toHaveLength(0);
    expect(container.textContent).toContain('저장본 v6');
  });

  it('손익 제외한 플랫폼 수수료를 원래 비용 유형과 분류로 복원한다', async () => {
    const state = response();
    state.data.sources.push({ ...source('platform', 'platform'), channel: 'baemin' });
    state.data.lines.push(line('배달 수수료 제외', 'excluded', 100_000, { sourceId: 'platform', category: 'owner_transfer', originalKind: 'expense', originalCategory: 'fees' }));
    state.summary = calculateOdaMonth(state.data); mocks.get.mockResolvedValue(state); mocks.mutate.mockResolvedValue(state);
    await render(); await click('거래·증빙'); await click('제외');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="배달 수수료 제외 상세 열기"]')!.click());
    await set(field('손익 반영'), 'expense');
    expect(field('분류').value).toBe('fees');
    await click('확인 완료', container.querySelector('.oda-line')!);
    expect(mocks.mutate).toHaveBeenCalledWith('oda-1', '2026-09', '/lines/%EB%B0%B0%EB%8B%AC%20%EC%88%98%EC%88%98%EB%A3%8C%20%EC%A0%9C%EC%99%B8', 4, expect.objectContaining({ changes: expect.objectContaining({ kind: 'expense', category: 'fees' }) }));
  });
});
