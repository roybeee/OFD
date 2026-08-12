import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreHomePage } from './StoreHomePage';
import type { BootstrapData } from '../types';

const baseData: BootstrapData = {
  actor: { id: 'owner-1', name: '김점주', role: 'store_owner' },
  store: { id: 'store-1', name: '연남점', businessName: '연남점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
  stores: [{ id: 'store-1', name: '연남점' }], products: [], orders: [], deliveries: [], bankMatches: [],
  paymentRequests: [], bankTransactions: [], manualMatchCandidates: [], settlements: [], invoices: [], documents: [], drivers: [],
  generatedAt: '2026-08-09T00:00:00Z', capabilities: ['store.orders.read', 'store.documents.read'],
  allowedDeliveryDates: ['2026-08-12'], routeDates: [], supportEmail: 'finance@example.com',
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: true, operationalDate: '2026-08-09' },
};

const changeRequestedOrder = {
  id: 'order-1', code: 'ORD-1042', storeId: 'store-1', storeName: '연남점', createdAt: '2026-08-07T02:00:00Z',
  deliveryDate: '2026-08-12', itemCount: 8, grossAmount: 1_320_000, supplyAmount: 1_200_000, vatAmount: 120_000,
  status: 'change_requested' as const, paymentTerm: 'monthly_credit' as const, version: 2, timeline: [],
  changeRequest: { reason: '피스타치오 수량을 확인해 주세요.', requestedBy: '본사 운영', requestedAt: '2026-08-08T01:00:00Z' },
};
const paymentRequestDocument = { id: 'doc-pay', type: 'payment_request' as const, title: '7월 결제 요청', period: '2026-07', amount: 4_180_000, status: 'pending' as const };
const taxInvoiceDocument = { id: 'doc-tax', type: 'tax_invoice' as const, title: '7월 전자세금계산서', period: '2026-07', amount: 4_180_000, status: 'nts_success' as const, downloadDocumentId: 'document-9' };

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('점주 홈', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    vi.stubGlobal('fetch', vi.fn(async () => response({ notices: [] })));
  });
  afterEach(async () => { if (root) await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  async function render(data: BootstrapData, onNavigate = vi.fn()) {
    await act(async () => { root = createRoot(container); root.render(<StoreHomePage data={data} notify={vi.fn()} onNavigate={onNavigate} />); });
    return onNavigate;
  }

  it('본사 변경 요청을 가장 먼저 띄우고 발주 화면으로 보낸다', async () => {
    const onNavigate = await render({ ...baseData, orders: [changeRequestedOrder] });
    const first = container.querySelector('.owner-action')!;
    expect(first.className).toContain('tone-urgent');
    expect(first.textContent).toContain('ORD-1042');
    expect(first.textContent).toContain('피스타치오 수량을 확인해 주세요.');
    await act(async () => first.querySelector('button')!.click());
    expect(onNavigate).toHaveBeenCalledWith('/store/orders');
  });

  it('미결제 금액을 합산해 결제 안내로 보낸다', async () => {
    const onNavigate = await render({ ...baseData, documents: [paymentRequestDocument] });
    const payAction = [...container.querySelectorAll('.owner-action')].find((element) => element.className.includes('tone-due'))!;
    expect(payAction.textContent).toContain('4,180,000원');
    await act(async () => payAction.querySelector('button')!.click());
    expect(onNavigate).toHaveBeenCalledWith('/store/documents');
  });

  it('처리할 일이 없으면 재촉하지 않는다', async () => {
    await render({ ...baseData, allowedDeliveryDates: [] });
    const actions = container.querySelectorAll('.owner-action');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.className).toContain('tone-calm');
    expect(actions[0]!.textContent).toContain('지금 처리할 일이 없어요');
  });

  it('증빙 원본은 눌렀을 때만 짧은 수명의 링크를 받아온다', async () => {
    const target = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => target));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/documents/')
      ? response({ downloadUrl: 'https://files.example/signed', expiresInSeconds: 900 })
      : response({ notices: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await render({ ...baseData, documents: [taxInvoiceDocument] });
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/documents/'))).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('.owner-doc-open')!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/documents/document-9/download', expect.objectContaining({ method: 'GET' }));
    expect(target.location.href).toBe('https://files.example/signed');
  });

  it('본사 재무 어휘를 점주 화면으로 새어 나가게 하지 않는다', async () => {
    await render({ ...baseData, orders: [changeRequestedOrder], documents: [paymentRequestDocument, taxInvoiceDocument] });
    const text = container.textContent ?? '';
    for (const term of ['공급가액', '귀속월', '수정계산서', '국세청', '로스율', '마스터 승인', '재무 검토']) {
      expect(text.includes(term)).toBe(false, `점주 화면에 본사 용어가 남아 있다: ${term}`);
    }
    expect(text).toContain('내야 할 금액');
    expect(text).toContain('받은 증빙');
  });

  it('증빙 조회 권한이 없으면 증빙 영역을 감춘다', async () => {
    await render({ ...baseData, capabilities: ['store.orders.read'], documents: [taxInvoiceDocument] });
    expect(container.textContent).not.toContain('받은 증빙');
    expect(container.textContent).toContain('본사 확인 중');
  });
});
