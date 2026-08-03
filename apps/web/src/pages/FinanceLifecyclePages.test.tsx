import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqInvoicesPage } from './HqInvoicesPage';
import { HqReconciliationPage } from './HqReconciliationPage';
import { StoreDocumentsPage } from './StoreDocumentsPage';
import type { BootstrapData } from '../types';

const baseData: BootstrapData = {
  actor: { id: 'finance-1', name: '재무 담당자', role: 'hq_finance' },
  store: { id: 'store-1', name: '강남점', businessName: '강남점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
  stores: [{ id: 'store-1', name: '강남점' }], products: [], orders: [], deliveries: [], bankMatches: [],
  paymentRequests: [], bankTransactions: [], manualMatchCandidates: [], settlements: [], invoices: [], documents: [], drivers: [],
  generatedAt: '2026-08-04T00:00:00Z', capabilities: [], allowedDeliveryDates: [], routeDates: [],
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: true, operationalDate: '2026-08-04' },
};

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('finance lifecycle pages', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); });
  afterEach(async () => { if (root) await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('keeps request-only receivables visible and runs explicit auto and manual matching', async () => {
    const data: BootstrapData = { ...baseData,
      capabilities: ['hq.payments.reconcile'],
      paymentRequests: [{ id: 'pay-1', storeId: 'store-1', storeName: '강남점', amount: 11_000, dueDate: '2026-08-03', status: 'manual_review', depositorHint: '강남', version: 2, createdAt: '2026-08-01T00:00:00Z', overdue: true }],
      bankTransactions: [{ id: 'bank-1', providerId: 'provider-1', accountId: 'main', occurredAt: '2026-08-03T00:00:00Z', amount: 11_000, direction: 'credit', memo: '강남', matched: false, version: 1 }],
      manualMatchCandidates: [{ paymentRequestId: 'pay-1', bankTransactionId: 'bank-1', storeId: 'store-1', storeName: '강남점', amount: 11_000, requestVersion: 2, label: '강남점 · 11,000원' }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => response(String(input).endsWith('/auto-match') ? { paid: [{ id: 'pay-auto' }], manualReview: [{ id: 'pay-review' }], unmatched: 1 } : { paymentRequest: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn();
    const notify = vi.fn();
    await act(async () => { root = createRoot(container); root.render(<HqReconciliationPage data={data} notify={notify} refresh={refresh} />); });
    expect(container.textContent).toContain('강남점');
    expect(container.textContent).toContain('연체');
    const auto = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('자동 대사 실행'))!;
    await act(async () => auto.click());
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'bank-1'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    const manual = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('선택 거래에 연결'))!;
    await act(async () => manual.click());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/v2/payments/auto-match', '/api/v2/payments/pay-1/manual-match']);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedVersion: 2, bankTransactionId: 'bank-1' });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('입금 완료 1건'), 'success');
  });

  it('reverses a paid request with the exact version and reason contract', async () => {
    const data: BootstrapData = { ...baseData, capabilities: ['hq.payments.reconcile'], paymentRequests: [{ id: 'pay-1', storeId: 'store-1', storeName: '강남점', amount: 11_000, dueDate: '2026-08-03', status: 'paid', depositorHint: '강남', matchedBankTransactionId: 'bank-1', version: 4, createdAt: '2026-08-01T00:00:00Z', overdue: false }] };
    const fetchMock = vi.fn(async () => response({ paymentRequest: { status: 'pending' }, bankTransaction: { matched: false } }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqReconciliationPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('입금 완료'))!.click());
    const reason = container.querySelector<HTMLInputElement>('.reverse-reason input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, '다른 매장 입금'); reason.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('연결 취소'))!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/payments/pay-1/reverse-match', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ expectedVersion: 4, reason: '다른 매장 입금' });
  });

  it('exposes finance review actions and an accessible invoice lifecycle dialog', async () => {
    const data: BootstrapData = { ...baseData, capabilities: ['hq.settlements.manage', 'hq.invoices.prepare', 'hq.invoices.retry'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', storeName: '강남점', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'draft', receiptIds: ['receipt-1'], grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, version: 1 }],
      invoices: [{ id: 'invoice-1', storeName: '강남점', period: '2026년 8월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'draft', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', version: 1 }],
    };
    const fetchMock = vi.fn(async () => response({ invoice: {}, settlement: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    expect(container.querySelector('form[aria-label="정산 초안 생성"]')).toBeTruthy();
    const settlementReview = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('재무 검토 완료'))!;
    await act(async () => settlementReview.click());
    const invoiceRow = container.querySelector<HTMLButtonElement>('.invoice-row')!;
    await act(async () => invoiceRow.click());
    const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('작성·검토·승인 분리');
    const invoiceReview = [...dialog!.querySelectorAll('button')].find((button) => button.textContent?.includes('재무 검토 완료'))!;
    await act(async () => invoiceReview.click());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/v2/settlements/settlement-1/review', '/api/v2/invoices/invoice-1/review']);
  });

  it('gates final settlement and invoice approval to the master role', async () => {
    const data: BootstrapData = { ...baseData,
      actor: { id: 'master-1', name: '마스터', role: 'hq_master' }, capabilities: ['hq.settlements.approve', 'hq.invoices.approve', 'hq.invoices.retry'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', storeName: '강남점', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'reviewed', receiptIds: ['receipt-1'], grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, reviewedBy: 'finance-1', reviewedByName: '재무 담당자', version: 2 }],
      invoices: [{ id: 'invoice-1', storeName: '강남점', period: '2026년 8월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'reviewed', preparedBy: '재무 담당자', preparedById: 'finance-1', reviewedBy: 'finance-1', reviewedByName: '재무 담당자', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', version: 2 }],
    };
    const fetchMock = vi.fn(async () => response({ invoice: {}, settlement: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('마스터 승인'))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.invoice-row')!.click());
    await act(async () => [...container.querySelectorAll('aside button')].find((button) => button.textContent?.includes('마스터 승인'))!.click());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/v2/settlements/settlement-1/approve', '/api/v2/invoices/invoice-1/approve']);
  });

  it('offers only supported full-reversal reasons and retries a failed invoice exactly', async () => {
    const data: BootstrapData = { ...baseData, capabilities: ['hq.settlements.manage', 'hq.invoices.prepare', 'hq.invoices.retry'], invoices: [
      { id: 'success-1', storeName: '강남점', period: '2026년 7월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'nts_success', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-08-10', issueDate: '2026-07-31', issueType: 'normal', serialNumber: '123456789012345678901234', version: 3 },
      { id: 'failed-1', storeName: '강남점', period: '2026년 8월', grossAmount: 22_000, supplyAmount: 20_000, vatAmount: 2_000, status: 'failed', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', failureReason: 'NTS timeout', version: 5 },
    ] };
    const fetchMock = vi.fn(async () => response({ invoice: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.invoice-row')[0]!.click());
    const reason = container.querySelector<HTMLSelectElement>('.lifecycle-reason select')!;
    expect(reason.value).toBe('03');
    expect([...reason.options].map((option) => option.value)).toEqual(['03', '04', '06']);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="계산서 상세 닫기"]')!.click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.invoice-row')[1]!.click());
    await act(async () => [...container.querySelectorAll('aside button')].find((button) => button.textContent?.includes('발행 재시도'))!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/invoices/failed-1/retry', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ expectedVersion: 5 });
  });

  it('fetches a short-lived original URL only when the store opens a document', async () => {
    const data: BootstrapData = { ...baseData,
      actor: { id: 'owner-1', name: '점주', role: 'store_owner' }, capabilities: ['store.documents.read'],
      documents: [{ id: 'invoice-1', type: 'tax_invoice', title: '8월 전자세금계산서', period: '2026-08-31', amount: 11_000, status: 'nts_success', downloadDocumentId: 'document-1', fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }],
    };
    const target = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => target);
    vi.stubGlobal('open', open);
    const fetchMock = vi.fn(async () => response({ document: { id: 'document-1', storeId: 'store-1', kind: 'tax_invoice', aggregateType: 'tax_invoice', aggregateId: 'invoice-1', sourceVersion: 3, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1024, createdAt: '2026-08-04T00:00:00Z' }, downloadUrl: 'https://files.example/signed', expiresInSeconds: 900 }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<StoreDocumentsPage data={data} notify={vi.fn()} />); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="8월 전자세금계산서 원본 열기"]')!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/documents/document-1/download', expect.objectContaining({ method: 'GET' }));
    expect(target.location.href).toBe('https://files.example/signed');
    expect(open).toHaveBeenCalledWith('', '_blank');
  });
});
