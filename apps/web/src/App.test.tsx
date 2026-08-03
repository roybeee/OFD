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
  allowedDeliveryDates = [],
}: {
  role?: string;
  capabilities?: string[];
  settlements?: unknown[];
  taxInvoices?: unknown[];
  products?: unknown[];
  orders?: unknown[];
  allowedDeliveryDates?: string[];
} = {}) {
  return {
    meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false, generatedAt: '2026-08-03T00:00:00.000Z' },
    currentActor: { id: 'actor-1', name: '운영 사용자', role },
    availableActors: [],
    headquarters: { email: 'finance@example.com' },
    stores: [{ id: 'store-1', name: '운영 매장', business: { legalName: '운영 사업자' }, billingCycle: 'monthly', paymentMethod: 'monthly_credit' }],
    products, orders, shipments: [], paymentRequests: [], bankTransactions: [], settlements, taxInvoices, receipts: [],
    capabilities,
    allowedDeliveryDates,
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

  it('sends an unauthenticated user to the existing OFD login instead of showing a second login form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiResponse({ error: 'AUTH_REQUIRED' }, 401)));
    await renderApp();
    await waitFor(() => hasHeading('기존 워크스테이션 로그인이 필요합니다'));
    const link = container.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(link?.textContent).toContain('로그인 화면으로 이동');
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
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
      settlements: [{ id: 'settlement-1', periodStart: '2026-07-01', periodEnd: '2026-07-31', gross: 100_000, status: 'locked' }],
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

  it('fails closed instead of silently showing demo data when the live API is down', async () => {
    window.history.replaceState({}, '', '/store/orders');
    await renderApp();
    await waitFor(() => hasHeading('운영 서버에 연결할 수 없습니다'));
    expect(container.textContent).not.toContain('데모 데이터');
    expect(button('다시 연결')).toBeTruthy();
  });
});
