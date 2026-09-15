import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HqAccountsPage } from './HqAccountsPage';
import { normalizeBootstrap } from '../api/client';
import type { BootstrapData } from '../types';

vi.mock('../lib/brand', () => ({ isOdaBrand: true }));

it('creates an ODA support partner B only after selecting an explicit store', async () => {
  const data = {
    actor: { id: 'master', name: '관리자', role: 'hq_master' },
    store: { id: 'oda-1', name: '외대점', businessName: '외대점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
    stores: [{ id: 'oda-1', name: '외대점' }, { id: 'oda-2', name: '다른 매장' }],
    products: [], orders: [], deliveries: [], bankMatches: [], paymentRequests: [], bankTransactions: [], manualMatchCandidates: [],
    settlements: [], invoices: [], documents: [], drivers: [], generatedAt: '', capabilities: ['hq.accounts.manage'], allowedDeliveryDates: [], routeDates: [],
    meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'mock', externalIssueEnabled: false },
  } satisfies BootstrapData;
  const respond = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/admin/access-policy')) return respond({ pages: [], roleDefaults: {}, rolePages: {}, actorPages: {}, actorEffectivePages: {} });
    if (init?.method === 'POST') return respond({ actor: { id: 'partner-b', name: '지원 파트너', role: 'hq_finance', storeIds: ['oda-1'],
      email: 'partner@oda.local', active: true, version: 1 } });
    return respond({ actors: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<HqAccountsPage data={data} notify={vi.fn()} />); });
    async function set(selector: string, value: string) {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    }
    await set('#account-role', 'hq_finance');
    expect(container.textContent).toContain('지원 파트너 B (재무)');
    expect(container.querySelector('#account-store-oda-1')).toBeTruthy();
    await set('#account-name', '지원 파트너');
    await set('#account-email', 'partner@oda.local');
    await set('#account-password', 'ODA-partner-2026!');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { container.querySelector<HTMLInputElement>('#account-store-oda-1')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ role: 'hq_finance', storeIds: ['oda-1'] });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  { appMode: 'production', odaSettlementOnly: true },
  { appMode: 'local', odaSettlementOnly: false },
])('loads and manages supported ODA accounts without access-policy in $appMode', async (profile) => {
  const data = normalizeBootstrap({ meta: { apiVersion: 'v2', providerMode: 'disabled', ...profile },
    currentActor: { id: 'master', name: '관리자', role: 'hq_master' },
    stores: [{ id: 'oda-1', name: '검증 매장' }], capabilities: ['hq.accounts.manage'] });
  expect(data.meta.odaSettlementOnly).toBe(profile.odaSettlementOnly);
  const actor = { id: 'operator', name: '검증 운영자', role: 'store_owner', storeIds: ['oda-1'], email: 'operator@example.test', active: true, version: 1 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/access-policy')) return new Response(JSON.stringify({ error: { message: '지원하지 않는 경로' } }), { status: 404 });
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ actor: { ...actor, version: 2 } }));
    return new Response(JSON.stringify({ actors: [actor] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<HqAccountsPage data={data} notify={vi.fn()} />));
    expect(container.textContent).toContain('operator@example.test');
    expect(container.querySelector('.account-load-error')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/v2/admin/actors']);
    expect([...container.querySelectorAll<HTMLOptionElement>('#account-role option')].map(option => option.value))
      .toEqual(['store_owner', 'store_staff', 'hq_finance', 'hq_master', 'auditor']);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="검증 운영자 상세 설정"]')!.disabled).toBe(true);
    expect(container.querySelector('[aria-label="검증 운영자 상세 설정 열기"]')).toBeNull();
    expect(container.textContent).toContain(profile.appMode === 'production' ? 'ODA 온라인 정산' : '이 컴퓨터에서 사용하는');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="검증 운영자 비밀번호 재설정"]')!.click());
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#reset-password')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Replacement-password123!');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(request?.[0]).toBe('/api/v2/admin/actors');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ action: 'reset', actorId: 'operator', expectedVersion: 1 });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('새로고침'))!;
    await act(async () => refresh.click());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/access-policy'))).toBe(false);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});

it('preserves advanced account management for the full ODA production profile', async () => {
  const data = normalizeBootstrap({ meta: { appMode: 'production', odaSettlementOnly: false },
    currentActor: { id: 'master', role: 'hq_master' }, stores: [], capabilities: ['hq.accounts.manage'] });
  const actor = { id: 'operator', name: '운영자', role: 'store_owner', storeIds: [], email: 'operator@example.test', active: true, version: 1 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/access-policy')
    ? { pages: [], roleDefaults: {}, rolePages: {}, actorPages: {}, actorEffectivePages: {} } : { actors: [actor] })));
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<HqAccountsPage data={data} notify={vi.fn()} />));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/admin/access-policy'))).toBe(true);
    expect(container.querySelector('#account-role option[value="driver"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="운영자 상세 설정 열기"]')).toBeTruthy();
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
