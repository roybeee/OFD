import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

let container: HTMLDivElement;
let root: Root;

function button(name: RegExp | string) {
  const match = [...container.querySelectorAll('button')].find((element) => {
    const accessibleName = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return typeof name === 'string' ? accessibleName.trim() === name : name.test(accessibleName);
  });
  if (!match) throw new Error(`button not found: ${String(name)}`);
  return match as HTMLButtonElement;
}

function hasHeading(name: string) {
  return [...container.querySelectorAll('h1,h2,h3')].some((element) => element.textContent?.trim() === name);
}

async function waitFor(assertion: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (assertion()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error('condition not reached');
}

async function renderApp() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
    await Promise.resolve();
  });
}

function bootstrapPayload({
  role = 'store_owner',
  capabilities = ['store.orders.read'],
  settlements = [],
  taxInvoices = [],
  products = [],
  orders = [],
  shipments = [],
  drivers = [],
  allowedDeliveryDates = [],
  routeDates = [],
}: {
  role?: string;
  capabilities?: string[];
  settlements?: unknown[];
  taxInvoices?: unknown[];
  products?: unknown[];
  orders?: unknown[];
  shipments?: unknown[];
  drivers?: unknown[];
  allowedDeliveryDates?: string[];
  routeDates?: string[];
} = {}) {
  return {
    meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false, generatedAt: '2026-08-03T00:00:00.000Z' },
    currentActor: { id: 'actor-1', name: '운영 사용자', role },
    availableActors: [],
    driverDirectory: drivers,
    headquarters: { email: 'finance@example.com' },
    stores: [{ id: 'store-1', name: '운영 매장', business: { legalName: '운영 사업자' }, billingCycle: 'monthly', paymentMethod: 'monthly_credit' }],
    products, orders, shipments, paymentRequests: [], bankTransactions: [], settlements, taxInvoices, receipts: [],
    capabilities,
    allowedDeliveryDates,
    routeDates,
  };
}

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('role-aware OFD workspace', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    window.history.replaceState({}, '', '/store/orders');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('signs a store owner in and lands on the store owner home', async () => {
    let authenticated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) return authenticated
        ? apiResponse(bootstrapPayload())
        : apiResponse({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }, 401);
      if (url.endsWith('/auth/login') && init?.method === 'POST') {
        authenticated = true;
        return apiResponse({ authenticated: true, mfaRequired: false, actor: { id: 'actor-1', name: '운영 사용자', role: 'store_owner', storeIds: ['store-1'] } });
      }
      return apiResponse({ error: { code: 'UNEXPECTED', message: 'unexpected' } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderApp();
    await waitFor(() => hasHeading('OFD 워크스테이션 로그인'));

    async function enter(selector: string, value: string) {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await enter('input[type="email"]', 'owner@example.com');
    await enter('input[type="password"]', 'CorrectHorseBatteryStaple!');
    await act(async () => button('로그인').click());

    await waitFor(() => hasHeading('지금 해야 할 일'));
    expect(window.location.pathname).toBe('/store/home');
    expect(container.querySelector('[data-testid="store-home-screen"]')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/login'))).toBe(true);
  });

  it('logs an HQ master in with password only and redirects to the first permitted HQ route', async () => {
    let authenticated = false;
    window.history.replaceState({}, '', '/store/orders');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) return authenticated
        ? apiResponse(bootstrapPayload({ role: 'hq_master', capabilities: ['hq.orders.read'] }))
        : apiResponse({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }, 401);
      if (url.endsWith('/auth/login') && init?.method === 'POST') {
        authenticated = true;
        return apiResponse({ authenticated: true, mfaRequired: false, actor: { id: 'hq-1', name: '본사 관리자', role: 'hq_master', storeIds: [] } });
      }
      return apiResponse({ error: { code: 'UNEXPECTED', message: 'unexpected' } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderApp();
    await waitFor(() => hasHeading('OFD 워크스테이션 로그인'));

    async function enter(selector: string, value: string) {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await enter('input[type="email"]', 'master@example.com');
    await enter('input[type="password"]', 'CorrectHorseBatteryStaple!');
    await act(async () => button('로그인').click());

    await waitFor(() => hasHeading('주문 운영'));
    expect(window.location.pathname).toBe('/hq/orders');
    // MFA 2단계는 더 이상 없다 — /auth/mfa 호출이 없어야 한다
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/mfa'))).toBe(false);
  });

  it('shows only menus granted by the current OFD session and keeps home destinations distinct', async () => {
    window.history.replaceState({}, '', '/hq/reconciliation');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse(bootstrapPayload({
      role: 'hq_finance',
      capabilities: ['hq.payments.reconcile', 'hq.invoices.read'],
    }))));
    await renderApp();
    await waitFor(() => hasHeading('입금 대사'));
    const navText = container.querySelector('nav[aria-label="주요 메뉴"]')?.textContent ?? '';
    expect(navText).toContain('입금 대사');
    expect(navText).toContain('정산·세금계산서');
    expect(navText).not.toContain('주문 운영');
    expect(navText).not.toContain('배송');
    expect(container.querySelector('a.legacy-home-link[href="/"]')?.getAttribute('aria-label')).toBe('기존 OFD 워크스테이션 홈으로 이동');
    expect(button('통합 발주·정산 첫 화면')).toBeTruthy();
  });

  it('renders a stable access 안내 with a workstation-home route when the session has no V2 capability', async () => {
    window.history.replaceState({}, '', '/hq/orders');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse(bootstrapPayload({
      role: 'auditor',
      capabilities: [],
    }))));

    await renderApp();
    await waitFor(() => hasHeading('접근 가능한 업무가 없습니다'));

    expect(container.querySelector<HTMLAnchorElement>('a[href="/"]')?.textContent).toContain('워크스테이션 홈');
    expect(container.querySelector('[aria-label="화면을 불러오는 중"]')).toBeNull();
  });

  it('keeps legacy orders read-only and returns them to the existing order ledger in the same tab', async () => {
    window.history.replaceState({}, '', '/hq/orders');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse(bootstrapPayload({
      role: 'hq_ops',
      capabilities: ['hq.orders.read', 'hq.orders.approve', 'hq.orders.change_request'],
      orders: [{
        id: 'legacy-order-1', storeId: 'store-1', number: 'LEGACY-20260803-001', source: 'legacy_unverified',
        status: 'submitted', version: 1, createdAt: '2026-08-03T08:00:00.000Z', submittedAt: '2026-08-03T08:00:00.000Z',
        requestedDeliveryDate: '2026-08-04', gross: 11_000, supply: 10_000, vat: 1_000,
        lines: [{ id: 'line-1', quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000, snapshot: { productId: 'product-1', name: '기존 품목', unit: '박스', unitGross: 11_000 } }],
      }],
    }))));

    await renderApp();
    await waitFor(() => hasHeading('주문 운영'));
    await act(async () => button(/기존 원장/).click());
    await act(async () => container.querySelector<HTMLButtonElement>('.order-table-row.legacy-read-only')?.click());

    expect(container.textContent).toContain('이전 시스템에서 생성된 읽기 전용 주문입니다');
    expect(container.textContent).toContain('금액 확인 불가');
    expect(container.textContent).not.toContain('11,000원');
    expect(container.querySelector<HTMLAnchorElement>('a[href="/?tab=orders"]')?.textContent).toContain('기존 발주 화면 열기');
    expect([...container.querySelectorAll('button')].some((element) => element.textContent?.includes('발주 승인'))).toBe(false);
  });

  it('does not advertise document downloads when the API provides no original file URL', async () => {
    window.history.replaceState({}, '', '/store/documents');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse(bootstrapPayload({
      capabilities: ['store.documents.read'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', periodStart: '2026-07-01', periodEnd: '2026-07-31', receiptIds: [], gross: 100_000, supply: 90_909, vat: 9_091, status: 'locked', version: 1 }],
    }))));
    await renderApp();
    await waitFor(() => hasHeading('정산·증빙'));
    expect(container.textContent).not.toContain('원본 생성 대기');
    expect(container.textContent).not.toContain('정산서 원본 열기');
    expect(container.querySelector('[aria-label*="원본"]')).toBeNull();
  });

  it('starts a new live order with every product quantity at zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse(bootstrapPayload({
      capabilities: ['store.orders.read', 'store.orders.create'],
      products: [{ id: 'product-1', name: '운영 상품', unit: '박스', unitSupply: 10_000, unitGross: 12_000 }],
      allowedDeliveryDates: ['2026-08-04'],
    }))));
    await renderApp();
    await waitFor(() => hasHeading('발주·입고'));
    await act(async () => button('새 발주 시작').click());
    expect(container.querySelector('.quantity-control output')?.textContent).toBe('0');
    expect(button(/다음 단계/).disabled).toBe(true);
    expect(container.textContent).not.toContain('최근 4주');
  });

  it('keeps the authenticated workspace open when logout fails and offers an explicit retry', async () => {
    let logoutAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) return apiResponse(bootstrapPayload());
      if (url.endsWith('/auth/logout')) {
        logoutAttempts += 1;
        return logoutAttempts === 1
          ? apiResponse({ error: { code: 'LOGOUT_FAILED', message: '로그아웃 서버 오류' } }, 503)
          : new Response(null, { status: 204 });
      }
      return apiResponse({ error: 'unexpected' }, 500);
    }));
    await renderApp();
    await waitFor(() => hasHeading('발주·입고'));

    await act(async () => button('로그아웃').click());
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(hasHeading('발주·입고')).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('로그아웃 서버 오류');

    await act(async () => button('로그아웃 다시 시도').click());
    await waitFor(() => hasHeading('OFD 워크스테이션 로그인'));
    expect(logoutAttempts).toBe(2);
  });

  it('returns the current master to login immediately after self credential reset revokes the session', async () => {
    window.history.replaceState({}, '', '/hq/accounts');
    const master = {
      id: 'actor-1', name: '운영 사용자', role: 'hq_master', storeIds: [], active: true, version: 1,
      email: 'master@example.com',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) return apiResponse(bootstrapPayload({ role: 'hq_master', capabilities: ['hq.accounts.manage'] }));
      if (url.endsWith('/admin/access-policy')) return apiResponse({ pages: [], roleDefaults: {}, rolePages: {}, actorPages: {}, actorEffectivePages: {} });
      if (url.endsWith('/admin/actors') && (!init?.method || init.method === 'GET')) return apiResponse({ actors: [master] });
      if (url.endsWith('/admin/actors') && init?.method === 'PATCH') return apiResponse({ actor: { ...master, version: 2 } });
      return apiResponse({ error: { code: 'UNEXPECTED', message: 'unexpected' } }, 500);
    }));
    await renderApp();
    await waitFor(() => Boolean(container.querySelector('[aria-label="운영 사용자 비밀번호 재설정"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="운영 사용자 비밀번호 재설정"]')!.click());
    await act(async () => {
      const password = container.querySelector<HTMLInputElement>('#reset-password')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'NewCorrectPassword!');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.account-reset-dialog button[type="submit"]')!.click());
    await waitFor(() => hasHeading('OFD 워크스테이션 로그인'));
    expect(container.querySelector('.account-reset-dialog')).toBeNull();
  });

  it('creates a shipment, keeps it visible on today\'s route, and dispatches it', async () => {
    window.history.replaceState({}, '', '/hq/delivery');
    const order = {
      id: 'order-1', storeId: 'store-1', number: 'PO-20260804-001', source: 'native', status: 'approved', version: 1,
      createdAt: '2026-08-03T08:00:00.000Z', approvedAt: '2026-08-03T09:00:00.000Z', requestedDeliveryDate: '2026-08-04',
      gross: 11_000, supply: 10_000, vat: 1_000,
      lines: [{ id: 'line-1', quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000,
        snapshot: { productId: 'product-1', name: '원두', unit: '박스', unitGross: 11_000 } }],
    };
    const shipment = {
      id: 'shipment-1', orderId: order.id, storeId: 'store-1', driverId: 'driver-1', status: 'preparing',
      plannedDate: '2026-08-04', routeSequence: 1, deliveryWindow: { start: '09:00', end: '10:00' },
      lines: [{ orderLineId: 'line-1', quantity: 1 }], version: 1,
    };
    let created = false;
    const payload = () => bootstrapPayload({
      role: 'hq_ops', capabilities: ['hq.shipments.manage', 'hq.shipments.dispatch'], orders: [order],
      shipments: created ? [shipment] : [], drivers: [{ id: 'driver-1', name: '김배송' }], routeDates: ['2026-08-04'],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) return apiResponse(payload());
      if (url.endsWith('/shipments') && init?.method === 'POST') {
        created = true;
        return apiResponse({ shipment }, 201);
      }
      if (url.endsWith('/shipments/shipment-1/dispatch') && init?.method === 'POST') {
        return apiResponse({ shipment: { ...shipment, status: 'out_for_delivery', version: 2 } });
      }
      return apiResponse({ error: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();
    await waitFor(() => Boolean(container.querySelector('[data-testid="shipment-create-order-1"]')));
    async function change(selector: string, value: string, index = 0) {
      await act(async () => {
        const element = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(selector)[index]!;
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    }
    await change('.dispatch-card select', 'driver-1');
    await change('.dispatch-card input[type="number"]', '1');
    await change('.dispatch-card input[type="time"]', '09:00');
    await change('.dispatch-card input[type="time"]', '10:00', 1);
    await waitFor(() => !container.querySelector<HTMLButtonElement>('[data-testid="shipment-create-order-1"]')!.disabled);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="shipment-create-order-1"]')!.click());

    await waitFor(() => Boolean(container.querySelector('[data-testid="shipment-dispatch-shipment-1"]')));
    expect(container.querySelector<HTMLSelectElement>('.date-picker select')?.value).toBe('2026-08-04');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="shipment-dispatch-shipment-1"]')!.click());
    await waitFor(() => fetchMock.mock.calls.some(([input]) => String(input).endsWith('/shipments/shipment-1/dispatch')));
    const createCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/shipments'));
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      orderId: 'order-1', driverId: 'driver-1', plannedDate: '2026-08-04', routeSequence: 1,
      deliveryWindow: { start: '09:00', end: '10:00' },
    });
  });

  it('fails closed instead of silently showing demo data when the live API is down', async () => {
    window.history.replaceState({}, '', '/store/orders');
    await renderApp();
    await waitFor(() => hasHeading('운영 서버에 연결할 수 없습니다'));
    expect(container.textContent).not.toContain('데모 데이터');
    expect(button('다시 연결')).toBeTruthy();
  });
});
