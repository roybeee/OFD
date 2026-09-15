import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOdaMonth, calculateOdaMonth } from '../../../../packages/domain/src/oda-settlement';
import { normalizeBootstrap } from '../api/client';
import { AppShell } from '../components/AppShell';
import { canAccessPath, defaultPathFor } from '../lib/access';
import { OdaMasterPage, OdaStoresPage, odaMasterSettlementPath } from './OdaMasterPage';
import { OdaSettlementPage, odaSettlementLocation } from './OdaSettlementPage';
vi.mock('../lib/brand', () => ({ isOdaBrand: true, workstationName: 'ODA 워크스테이션' }));
const mocks = vi.hoisted(() => ({ get: vi.fn(), overview: vi.fn() }));
vi.mock('../api/oda-client', async original => ({ ...await original<typeof import('../api/oda-client')>(), getOdaMonth: mocks.get, getOdaOverview: mocks.overview }));

const data = () => normalizeBootstrap({ currentActor: { id: 'master-1', name: '황관리', role: 'hq_master' },
  stores: [{ id: 'workspace-1', name: 'ODA 기본 작업공간', business: {} }],
  capabilities: ['oda.master.manage', 'oda.finance.read', 'hq.accounts.manage'],
  meta: { appMode: 'production', odaSettlementOnly: true, operationalDate: '2026-09-15' } });
const emptyBusiness = { businessNumber: '', legalName: '', representativeName: '', address: '', businessType: '', businessCategory: '', email: '' };
const store = { id: 'workspace-1', name: 'ODA 기본 작업공간', code: 'oda-workspace', active: true, version: 1, odaWorkspace: true, business: emptyBusiness };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); mocks.overview.mockResolvedValue({ month: '2026-08', page: 1, pageSize: 20, total: 0, rows: [] }); window.history.replaceState({}, '', '/'); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
async function click(text: string) { await act(async () => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text)); expect(button, text).toBeTruthy(); button!.click();
}); }
async function input(id: string, value: string) { await act(async () => {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)!; expect(element, id).toBeTruthy();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
}); }

describe('ODA master workspace', () => {
  it('lands the ODA master on the dashboard and opens working features without business registration', async () => {
    const navigate = vi.fn(); await act(async () => root.render(<OdaMasterPage data={data()} onNavigate={navigate} />));
    expect(defaultPathFor(data().capabilities)).toBe('/hq/oda-master');
    expect(container.textContent).toContain('황관리님의 작업공간');
    expect(container.querySelector<HTMLSelectElement>('#oda-master-store')!.value).toBe('workspace-1');
    expect(container.textContent).toContain('사업자 정보는 나중에 등록해도 됩니다.');
    await click('이번 달 자료 넣기'); expect(navigate).toHaveBeenLastCalledWith('/hq/oda-settlement?tab=transactions&store=workspace-1');
    for (const [label, target] of [
      ['월 손익계산서', '/hq/oda-settlement?tab=overview&store=workspace-1'],
      ['비용 관리', '/hq/oda-settlement?tab=expenses&store=workspace-1'],
      ['정산서 내려받기', '/hq/oda-settlement?tab=overview&store=workspace-1#oda-exports'],
      ['계약·정산 기준', '/hq/oda-settlement?tab=policy&store=workspace-1'],
      ['정산 확정·지급 기록', '/hq/oda-settlement?tab=overview&store=workspace-1#oda-payment'],
      ['변경 기록', '/hq/oda-settlement?tab=history&store=workspace-1'],
      ['매장·사업자 관리', '/hq/oda-stores'], ['계정 관리', '/hq/accounts'],
    ]) { await click(label); expect(navigate).toHaveBeenLastCalledWith(target); }
  });

  it('hides master navigation from A/B and preserves their settlement landing', async () => {
    expect(canAccessPath('/hq/oda-master', ['oda.finance.read'])).toBe(false);
    expect(canAccessPath('/hq/oda-stores', ['oda.finance.read'])).toBe(false);
    expect(defaultPathFor(['oda.finance.read'])).toBe('/hq/oda-settlement');
    expect(defaultPathFor(['oda.settlement.read'])).toBe('/store/oda-settlement');
    await act(async () => root.render(<AppShell role="hq" path="/hq/oda-settlement" actorName="파트너" actorRole="hq_finance" storeName="매장" deliveryCount={0} capabilities={['oda.finance.read']} onNavigate={vi.fn()} onLogout={vi.fn()}><p>정산</p></AppShell>));
    const nav = container.querySelector('nav')!; expect(nav.textContent).not.toContain('마스터 홈'); expect(nav.textContent).not.toContain('사업자 관리');
  });

  it('excludes inactive stores from dashboard choices and targets an active workspace', async () => {
    const inactiveFirst = normalizeBootstrap({ currentActor: { id: 'master-1', name: '관리자', role: 'hq_master' },
      stores: [{ id: 'closed', name: '종료 매장', active: false }, { id: 'live', name: '운영 매장', active: true }],
      capabilities: ['oda.master.manage', 'oda.finance.read'], meta: { appMode: 'production' } });
    const navigate = vi.fn(); await act(async () => root.render(<OdaMasterPage data={inactiveFirst} onNavigate={navigate} />));
    expect([...container.querySelectorAll('option')].map(option => option.value)).toEqual(['live']);
    await click('이번 달 자료 넣기'); expect(navigate).toHaveBeenLastCalledWith('/hq/oda-settlement?tab=transactions&store=live');
  });

  it('opens the real requested settlement tab and only selects authorized stores', async () => {
    const url = odaMasterSettlementPath('workspace-1', 'policy'); window.history.replaceState({}, '', url);
    expect(odaSettlementLocation('?store=foreign&tab=anything', data().stores)).toEqual({ tab: 'overview', storeId: '' });
    const month = createOdaMonth('workspace-1', '2026-09');
    mocks.get.mockResolvedValue({ data: month, summary: calculateOdaMonth(month), version: 0, evidence: [], history: [], capabilities: { edit: true, confirmParty: null, finalize: true, pay: true, reopen: true } });
    await act(async () => root.render(<OdaSettlementPage data={data()} notify={vi.fn()} />));
    expect(mocks.get).toHaveBeenCalledWith('workspace-1', '2026-09', expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="정산 상세"] [aria-current="page"]')?.textContent).toBe('정산 기준');
    expect(container.textContent).toContain('양측 합의 근거');
    expect(container.textContent).not.toContain('A 정산 기준 확인');
    expect(container.textContent).not.toContain('B 정산 기준 확인');
  });

  it('opens the expense shortcut for the selected authorized store and explicit month', async () => {
    const path = odaMasterSettlementPath('workspace-1', 'expenses', '', '2026-08');
    window.history.replaceState({}, '', path);
    expect(odaSettlementLocation(window.location.search, data().stores)).toEqual({ tab: 'expenses', storeId: 'workspace-1', month: '2026-08' });
    const month = createOdaMonth('workspace-1', '2026-08');
    mocks.get.mockResolvedValue({ data: month, summary: calculateOdaMonth(month), version: 0, evidence: [], history: [], capabilities: { edit: true, confirmParty: null, finalize: true, pay: true, reopen: true } });
    await act(async () => root.render(<OdaSettlementPage data={data()} notify={vi.fn()} />));
    expect(mocks.get).toHaveBeenCalledWith('workspace-1', '2026-08', expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="정산 상세"] [aria-current="page"]')?.textContent).toBe('비용 관리');
    expect(container.querySelector('[aria-label="매장 비용 관리"]')).toBeTruthy();
    expect(container.querySelector('a[href$="/expenses/export.zip"]')?.getAttribute('href')).toBe('/api/v2/oda/workspace-1/2026-08/expenses/export.zip');
  });

  it.each(['oda-exports', 'oda-payment'])('focuses the actual %s section when opened from a shortcut', async anchor => {
    window.history.replaceState({}, '', odaMasterSettlementPath('workspace-1', 'overview', anchor));
    const month = createOdaMonth('workspace-1', '2026-09');
    mocks.get.mockResolvedValue({ data: month, summary: calculateOdaMonth(month), version: 0, evidence: [], history: [], capabilities: { edit: true, confirmParty: null, finalize: true, pay: true, reopen: true } });
    await act(async () => root.render(<OdaSettlementPage data={data()} notify={vi.fn()} />));
    expect(container.querySelector(`#${anchor}`)).toBeTruthy();
    expect(document.activeElement?.id).toBe(anchor);
  });

  it('creates a store with only a name and updates its existing workspace using the expected version', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ store: { ...store, id: 'store-2', name: '외대점', code: 'auto-2' } }, 201);
      if (init?.method === 'PATCH') return json({ store: { ...store, name: '옥수점', version: 2 } });
      return json({ stores: [store] });
    }); vi.stubGlobal('fetch', fetchMock);
    const saved = vi.fn(); await act(async () => root.render(<OdaStoresPage onNavigate={vi.fn()} notify={vi.fn()} onSaved={saved} />));
    await click('매장 추가'); expect(container.querySelector('#oda-business-businessNumber')).toBeNull();
    await input('oda-store-name', '외대점'); await click('매장 저장');
    const created = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(created?.[0]).toBe('/api/v2/oda/admin/stores'); expect(JSON.parse(String(created?.[1]?.body))).toEqual({ name: '외대점' });
    expect((created?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="ODA 기본 작업공간 정보 수정"]')!.click());
    await input('oda-store-name', '옥수점'); await click('매장 저장');
    const updated = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(updated?.[1]?.body))).toEqual({ id: 'workspace-1', expectedVersion: 1, name: '옥수점', code: 'oda-workspace' });
    expect(saved).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('옥수점'); expect(container.textContent).toContain('외대점');
  });

  it('keeps edits and shows a server conflict without claiming a save', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
      ? json({ error: { code: 'VERSION_CONFLICT', message: '다른 변경이 먼저 저장됐습니다.' } }, 409) : json({ stores: [store] }));
    vi.stubGlobal('fetch', fetchMock); const saved = vi.fn();
    await act(async () => root.render(<OdaStoresPage onNavigate={vi.fn()} notify={vi.fn()} onSaved={saved} />));
    await click('정보 수정'); await input('oda-store-name', '새 이름'); await click('매장 저장');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('다른 변경이 먼저 저장');
    expect(container.querySelector<HTMLInputElement>('#oda-store-name')!.value).toBe('새 이름'); expect(saved).not.toHaveBeenCalled();
  });

  it('adds verified business details later to the same workspace instead of creating another store', async () => {
    const business = { businessNumber: '1234567890', legalName: '등록 상호', representativeName: '사업대표', address: '사업장 주소', businessType: '음식점업', businessCategory: '피자', email: 'store@example.test' };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
      ? json({ store: { ...store, odaWorkspace: false, version: 2, business } }) : json({ stores: [store] }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(<OdaStoresPage onNavigate={vi.fn()} notify={vi.fn()} onSaved={vi.fn()} />));
    await click('정보 수정'); await act(async () => container.querySelector<HTMLInputElement>('.oda-master-checkbox input')!.click());
    for (const [key, value] of Object.entries(business)) await input(`oda-business-${key}`, key === 'businessNumber' ? '123-45-67890' : value);
    await click('매장 저장');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ id: store.id, expectedVersion: 1, business });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(container.textContent).toContain('등록 상호');
  });

  it('explicitly clears a saved opening date rather than silently retaining it', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
      ? json({ store: { ...store, openDate: null, version: 2 } }) : json({ stores: [{ ...store, openDate: '2026-09-15' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(<OdaStoresPage onNavigate={vi.fn()} notify={vi.fn()} onSaved={vi.fn()} />));
    await click('정보 수정'); await input('oda-store-open-date', ''); await click('매장 저장');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ id: store.id, expectedVersion: 1, openDate: null });
  });
});
