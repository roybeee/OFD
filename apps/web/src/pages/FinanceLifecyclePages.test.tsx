import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqInvoicesPage } from './HqInvoicesPage';
import { HqReconciliationPage } from './HqReconciliationPage';
import { StoreDocumentsPage, documentMonth } from './StoreDocumentsPage';
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

const monthlyRow = { storeId: 'store-1', code: 'GANGNAM', name: '강남점', storeKind: '가맹' as const,
  supplyConfirmed: 110_000, receiptCount: 1, settledGross: 110_000, settlementCount: 1,
  invoiceSummary: { total: 1, ntsSuccess: 0, failed: 0, inProgress: 1 },
  posRevenue: 220_000, posQty: 40, supplyToPosPct: 50, receivedQty: 15, soldQty: 8, wasteQty: 7, lossRate: 46.7 };
const emptyMonthly = { month: '2026-08', rows: [], totals: { supplyConfirmed: 0, receiptCount: 0, settledGross: 0, settlementCount: 0,
  posRevenue: 0, posQty: 0, receivedQty: null, soldQty: 0, wasteQty: null, lossRate: null,
  invoiceSummary: { total: 0, ntsSuccess: 0, failed: 0, inProgress: 0 } } };
const isMonthly = (input: RequestInfo | URL) => String(input).includes('/settlements/monthly');
const nonMonthlyCalls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([input]) => !isMonthly(input as RequestInfo | URL));

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
    const data: BootstrapData = { ...baseData, capabilities: ['hq.settlements.manage', 'hq.settlements.draft', 'hq.invoices.prepare', 'hq.invoices.retry'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', storeName: '강남점', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'draft', receiptIds: ['receipt-1'], grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, version: 1 }],
      invoices: [{ id: 'invoice-1', storeName: '강남점', period: '2026년 8월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'draft', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', version: 1 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => isMonthly(input) ? response(emptyMonthly) : response({ invoice: {}, settlement: {} }));
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
    expect(nonMonthlyCalls(fetchMock).map(([input]) => String(input))).toEqual(['/api/v2/settlements/settlement-1/review', '/api/v2/invoices/invoice-1/review']);
  });

  it('gates final settlement and invoice approval to the master role', async () => {
    const data: BootstrapData = { ...baseData,
      actor: { id: 'master-1', name: '마스터', role: 'hq_master' }, capabilities: ['hq.settlements.approve', 'hq.invoices.approve', 'hq.invoices.retry'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', storeName: '강남점', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'reviewed', receiptIds: ['receipt-1'], grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, reviewedBy: 'finance-1', reviewedByName: '재무 담당자', version: 2 }],
      invoices: [{ id: 'invoice-1', storeName: '강남점', period: '2026년 8월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'reviewed', preparedBy: '재무 담당자', preparedById: 'finance-1', reviewedBy: 'finance-1', reviewedByName: '재무 담당자', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', version: 2 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => isMonthly(input) ? response(emptyMonthly) : response({ invoice: {}, settlement: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('마스터 승인'))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.invoice-row')!.click());
    await act(async () => [...container.querySelectorAll('aside button')].find((button) => button.textContent?.includes('마스터 승인'))!.click());
    expect(nonMonthlyCalls(fetchMock).map(([input]) => String(input))).toEqual(['/api/v2/settlements/settlement-1/approve', '/api/v2/invoices/invoice-1/approve']);
  });

  it('offers only supported full-reversal reasons and retries a failed invoice exactly', async () => {
    const data: BootstrapData = { ...baseData, capabilities: ['hq.settlements.manage', 'hq.invoices.prepare', 'hq.invoices.retry'], invoices: [
      { id: 'success-1', storeName: '강남점', period: '2026년 7월', grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, status: 'nts_success', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-08-10', issueDate: '2026-07-31', issueType: 'normal', serialNumber: '123456789012345678901234', version: 3 },
      { id: 'failed-1', storeName: '강남점', period: '2026년 8월', grossAmount: 22_000, supplyAmount: 20_000, vatAmount: 2_000, status: 'failed', preparedBy: '재무 담당자', preparedById: 'finance-1', dueDate: '2026-09-10', issueDate: '2026-08-31', issueType: 'normal', failureReason: 'NTS timeout', version: 5 },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => isMonthly(input) ? response(emptyMonthly) : response({ invoice: {} }));
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
    expect(JSON.parse(String(nonMonthlyCalls(fetchMock)[0]?.[1]?.body))).toEqual({ expectedVersion: 5 });
  });

  it('renders the V1-ported monthly settlement summary with N/A-safe loss handling', async () => {
    const data: BootstrapData = { ...baseData, capabilities: ['hq.invoices.read'] };
    const noReceiptRow = { ...monthlyRow, storeId: 'store-2', code: 'MAPDAL', name: '맵달서울점', storeKind: '직영' as const,
      supplyConfirmed: 0, receiptCount: 0, settledGross: 0, settlementCount: 0,
      invoiceSummary: { total: 0, ntsSuccess: 0, failed: 0, inProgress: 0 },
      posRevenue: 480_000, posQty: 120, supplyToPosPct: 0, receivedQty: null, soldQty: 0, wasteQty: null, lossRate: null };
    const summary = { month: '2026-07', rows: [monthlyRow, noReceiptRow], totals: { supplyConfirmed: 110_000, receiptCount: 1,
      settledGross: 110_000, settlementCount: 1, posRevenue: 700_000, posQty: 160, receivedQty: 15, soldQty: 8, wasteQty: 7,
      lossRate: 46.7, invoiceSummary: { total: 1, ntsSuccess: 0, failed: 0, inProgress: 1 } } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => isMonthly(input) ? response(summary) : response({}));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v2/settlements/monthly?month=2026-08');
    const panel = container.querySelector('[data-testid="monthly-settlement-panel"]')!;
    expect(panel.textContent).toContain('강남점');
    expect(panel.textContent).toContain('가맹');
    expect(panel.textContent).toContain('46.7%');
    expect(panel.textContent).toContain('맵달서울점');
    expect(panel.textContent).toContain('—'); // 입고 없는 매장의 로스율은 N/A
    expect(panel.textContent).toContain('합계');
    const month = panel.querySelector<HTMLInputElement>('input[type="month"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(month, '2026-07'); month.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('month=2026-07');
  });

  it('lets the master start a settlement draft while review stays with finance', async () => {
    const data: BootstrapData = { ...baseData,
      actor: { id: 'master-1', name: '마스터', role: 'hq_master' },
      capabilities: ['hq.settlements.approve', 'hq.settlements.draft', 'hq.invoices.read'],
      settlements: [{ id: 'settlement-1', storeId: 'store-1', storeName: '강남점', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'draft', receiptIds: ['receipt-1'], grossAmount: 11_000, supplyAmount: 10_000, vatAmount: 1_000, version: 1 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => isMonthly(input) ? response(emptyMonthly) : response({ settlement: {}, paymentRequest: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqInvoicesPage data={data} notify={vi.fn()} refresh={vi.fn()} />); });
    const form = container.querySelector<HTMLFormElement>('form[aria-label="정산 초안 생성"]');
    expect(form).toBeTruthy();
    expect(container.textContent).toContain('재무 검토는 재무 계정');
    expect(container.textContent).toContain('재무 검토 대기'); // 마스터는 draft를 검토할 수 없음을 안내
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('재무 검토 완료'))).toBe(false);
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

describe('점주 증빙 — 문서의 달 분류', () => {
  it('전자세금계산서는 발급기한(익월 10일)이 아니라 귀속월 탭에 들어간다', () => {
    /* CI e2e가 9/3에 처음 잡아낸 실제 결함: 9월 정산의 계산서 period가 2026-10-10이라 10월 탭으로 숨었다 */
    expect(documentMonth('2026-10-10', '2026년 9월 전자세금계산서', '2026-09-03T00:00:00Z')).toBe('2026-09');
    expect(documentMonth('2026-10-10', '2026년 9월 수정 전자세금계산서', '2026-09-03T00:00:00Z')).toBe('2026-09');
  });

  it('월 정산서·거래명세서·결제 요청은 이전과 같은 달에 들어간다', () => {
    expect(documentMonth('2026-09-01–2026-09-30', '2026년 9월 월 정산서', '2026-09-03T00:00:00Z')).toBe('2026-09');
    expect(documentMonth('2026-09-03', '독산점 거래명세서', '2026-09-03T00:00:00Z')).toBe('2026-09');
    expect(documentMonth('납부기한 2026-09-30', '결제 요청', '2026-09-03T00:00:00Z')).toBe('2026-09');
    /* 연도 없는 제목은 기간에서, 둘 다 없으면 생성 연도 + 제목의 월 */
    expect(documentMonth('2026-08-31', '8월 전자세금계산서', '2026-09-03T00:00:00Z')).toBe('2026-08');
    expect(documentMonth('', '7월 전자세금계산서', '2026-09-03T00:00:00Z')).toBe('2026-07');
  });
});
