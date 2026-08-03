import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqAccountsPage } from './HqAccountsPage';
import type { BootstrapData } from '../types';

const data = {
  actor: { id: 'master-1', name: '최고관리자', role: 'hq_master' },
  store: { id: 'store-1', name: '강남점', businessName: '강남점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
  stores: [{ id: 'store-1', name: '강남점' }, { id: 'store-2', name: '성수점' }],
  products: [], orders: [], deliveries: [], bankMatches: [], paymentRequests: [], bankTransactions: [], manualMatchCandidates: [], settlements: [], invoices: [], documents: [], drivers: [],
  generatedAt: '', capabilities: ['hq.accounts.manage'], allowedDeliveryDates: [], routeDates: [],
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false },
} satisfies BootstrapData;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('HQ account administration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('lists sanitized accounts and provisions a store owner with explicit stores', async () => {
    const existing = {
      id: 'driver-1', name: '김배송', role: 'driver', storeIds: [], active: true, version: 1,
      email: 'driver@example.com', mfaEnabled: false, passwordHash: 'must-not-render', mfaSecret: 'must-not-render',
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return response({ actors: [existing] });
      return response({ actor: {
        id: 'owner-1', name: '새 점주', role: 'store_owner', storeIds: ['store-1'], active: true,
        version: 1, email: 'owner@example.com', mfaEnabled: false,
      } }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(<HqAccountsPage data={data} notify={notify} />);
    });
    for (let attempt = 0; attempt < 20 && !container.textContent?.includes('driver@example.com'); attempt += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(container.textContent).toContain('driver@example.com');
    expect(container.textContent).not.toContain('must-not-render');
    expect(container.querySelector('button[aria-label="김배송 자격정보 재설정"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="김배송 계정 비활성화"]')).toBeTruthy();

    async function change(selector: string, value: string, eventName = 'input') {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event(eventName, { bubbles: true }));
      });
    }
    await change('#account-role', 'store_owner', 'change');
    await change('#account-name', '새 점주');
    await change('#account-email', 'owner@example.com');
    await change('#account-password', 'CorrectHorseBatteryStaple!');
    await act(async () => {
      const store = container.querySelector<HTMLInputElement>('#account-store-store-1')!;
      store.click();
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      role: 'store_owner', name: '새 점주', email: 'owner@example.com', storeIds: ['store-1'],
    });
    expect(container.textContent).toContain('owner@example.com');
    expect(notify).toHaveBeenCalledWith('새 점주 계정을 생성했습니다.', 'success');
  });

  it('revokes the current UI session after self credential reset and prevents closing while the reset is saving', async () => {
    const master = {
      id: 'master-1', name: '최고관리자', role: 'hq_master', storeIds: [], active: true, version: 1,
      email: 'master@example.com', mfaEnabled: true,
    };
    let resolveReset!: () => void;
    const resetGate = new Promise<void>((resolve) => { resolveReset = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return response({ actors: [master] });
      await resetGate;
      return response({ actor: { ...master, version: 2 } });
    }));
    const onCurrentSessionRevoked = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(<HqAccountsPage data={data} notify={vi.fn()} onCurrentSessionRevoked={onCurrentSessionRevoked} />);
    });
    for (let attempt = 0; attempt < 20 && !container.querySelector('[aria-label="최고관리자 자격정보 재설정"]'); attempt += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="최고관리자 자격정보 재설정"]')!.click());
    await act(async () => {
      const password = container.querySelector<HTMLInputElement>('#reset-password')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'NewCorrectPassword!');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.account-reset-dialog button[type="submit"]')!.click());
    expect(container.querySelector<HTMLButtonElement>('[aria-label="최고관리자 재설정 닫기"]')?.disabled).toBe(true);
    await act(async () => { resolveReset(); await resetGate; });
    for (let attempt = 0; attempt < 20 && !onCurrentSessionRevoked.mock.calls.length; attempt += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(onCurrentSessionRevoked).toHaveBeenCalledTimes(1);
  });
});
