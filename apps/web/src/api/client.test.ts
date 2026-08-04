import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  approveInvoiceV2,
  approveSettlementV2,
  autoMatchPaymentsV2,
  defaultShipmentSchedule,
  draftInvoiceV2,
  draftSettlementV2,
  getDocumentDownloadV2,
  isAllowedApiAppMode,
  loadBootstrap,
  manualMatchPaymentV2,
  modifyInvoiceV2,
  mutateV2,
  newIdempotencyKey,
  normalizeBootstrap,
  requestBankSyncV2,
  retryInvoiceV2,
  reversePaymentMatchV2,
  reviewInvoiceV2,
  reviewSettlementV2,
  shipmentMutationPayload,
} from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function bootstrapPayload(appMode = 'production') {
  return {
    meta: {
      apiVersion: 'v2',
      appMode,
      providerMode: 'production',
      externalIssueEnabled: false,
      generatedAt: '2026-08-03T00:00:00.000Z',
    },
    currentActor: { id: 'owner', name: '실제 점주', role: 'store_owner' },
    availableActors: [],
    stores: [{ id: 's1', name: '운영 매장', business: { legalName: '운영 사업자' }, billingCycle: 'monthly', paymentMethod: 'monthly_credit' }],
    products: [], orders: [], shipments: [], paymentRequests: [], bankTransactions: [], settlements: [], taxInvoices: [], receipts: [],
    capabilities: ['store.orders.read'],
    allowedDeliveryDates: [],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('V2 bootstrap adapter', () => {
  it('uses Web Crypto entropy when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xab);
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(newIdempotencyKey()).toBe(`ofd-${'ab'.repeat(16)}`);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('normalizes the domain DTO without inventing demo records', () => {
    const value = normalizeBootstrap({
      meta: { generatedAt: '2026-08-02T00:00:00.000Z' },
      currentActor: { id: 'owner', name: '박점주', role: 'store_owner' },
      availableActors: [],
      stores: [{ id: 's1', name: '독산점', business: { legalName: '독산사업자', representativeName: '박점주', address: '서울 금천구', businessNumber: '1' }, billingCycle: '', paymentMethod: '' }],
      products: [{ id: 'p1', name: '원두', unit: '봉', unitSupply: 26_000, unitGross: 28_600 }, { id: 'p2', name: '판매 중지 상품', unit: '봉', unitSupply: 9_000, unitGross: 10_000, active: false }],
      orders: [{ id: 'o1', number: 'PO-1', storeId: 's1', status: 'approved', requestedDeliveryDate: '2026-08-04', lines: [{ id: 'l1', quantity: 2, gross: 57_200, supply: 52_000, vat: 5_200, snapshot: { productId: 'p1', name: '원두', unit: '봉', unitGross: 28_600 } }], gross: 57_200, supply: 52_000, vat: 5_200, createdAt: '2026-08-02T00:00:00.000Z', version: 1 }],
      shipments: [], paymentRequests: [], bankTransactions: [], settlements: [], taxInvoices: [], receipts: [],
    });
    expect(value.store.name).toBe('독산점');
    expect(value.products[0]).toEqual({ id: 'p1', name: '원두', unit: '1봉', grossPrice: 28_600, category: '기타' });
    expect(value.products).toHaveLength(1);
    expect(value.orders[0]).toMatchObject({ code: 'PO-1', grossAmount: 57_200, supplyAmount: 52_000, vatAmount: 5_200, itemCount: 2, paymentTerm: 'unconfigured' });
    expect(value.orders[0]?.lines?.[0]).toMatchObject({ gross: 57_200, supply: 52_000, vat: 5_200 });
    expect(value.orders[0]?.timeline).toContainEqual(expect.objectContaining({ label: '배송 연동 미설정', at: '배송 일정 미등록', active: false }));
    expect(value.store).toMatchObject({ billingPolicy: '확인 필요', paymentTerm: '확인 필요' });
    expect(value.deliveries).toEqual([]);
    expect(value.allowedDeliveryDates).toEqual([]);
  });

  it('keeps a newly created HQ or unassigned driver usable when no store is in scope', () => {
    const value = normalizeBootstrap({
      meta: { generatedAt: '2026-08-02T00:00:00.000Z' },
      currentActor: { id: 'driver-new', name: '신규 기사', role: 'driver' },
      availableActors: [], stores: [], products: [], orders: [], shipments: [], paymentRequests: [], bankTransactions: [], settlements: [], taxInvoices: [], receipts: [],
      capabilities: ['driver.deliveries.read'],
      allowedDeliveryDates: [],
    });
    expect(value.actor).toMatchObject({ id: 'driver-new', role: 'driver' });
    expect(value.store).toMatchObject({ id: '', name: '배정 매장 없음' });
    expect(value.orders).toEqual([]);
    expect(value.deliveries).toEqual([]);
  });

  it('does not invent a delivery sequence or recipient when the server did not record them', () => {
    const payload: any = bootstrapPayload();
    payload.stores[0].business = { representativeName: '대표자 이름' };
    payload.shipments = [{
      id: 'shipment-1', orderId: 'order-1', storeId: 's1', status: 'ready',
      plannedDate: '2026-08-04', deliveryWindow: '', lines: [], proof: {},
    }];

    const value = normalizeBootstrap(payload);

    expect(value.deliveries[0]).toMatchObject({ id: 'shipment-1', window: '시간 미정' });
    expect(value.deliveries[0]?.sequence).toBeUndefined();
    expect(value.deliveries[0]?.recipientName).toBeUndefined();
  });

  it('uses the requested order date by default and sends only explicit route scheduling values', () => {
    const draft = defaultShipmentSchedule({ deliveryDate: '2026-08-07T12:00:00' });
    expect(draft).toEqual({ driverId: '', plannedDate: '2026-08-07', routeSequence: '', windowStart: '', windowEnd: '' });
    expect(() => shipmentMutationPayload('order-1', draft)).toThrow(/배송일/);

    expect(shipmentMutationPayload('order-1', {
      ...draft, driverId: 'driver-1', routeSequence: '3', windowStart: '13:30', windowEnd: '15:00',
    })).toEqual({
      orderId: 'order-1', driverId: 'driver-1', plannedDate: '2026-08-07', routeSequence: 3,
      deliveryWindow: { start: '13:30', end: '15:00' },
    });
  });

  it('normalizes the price-free driver route DTO without requiring full store or order entities', () => {
    const payload: any = bootstrapPayload();
    payload.currentActor = { id: 'driver-1', name: '기사', role: 'driver' };
    payload.stores = [];
    payload.orders = [];
    payload.shipments = [{
      id: 'shipment-1', status: 'out_for_delivery', plannedDate: '2026-08-04', routeSequence: 2,
      deliveryWindow: { start: '10:00', end: '11:30' }, version: 2,
      destination: { name: '독산점', address: '서울 금천구', phone: '01012345678' },
      items: [{ name: '원두', unit: '봉', quantity: 2 }], deliveryNote: '후문',
      proof: { recipientName: '점주', capturedAt: '2026-08-04T02:00:00.000Z' },
    }];

    const value = normalizeBootstrap(payload);
    expect(value.deliveries[0]).toMatchObject({
      id: 'shipment-1', sequence: 2, window: '10:00–11:30', storeName: '독산점', address: '서울 금천구',
      phone: '01012345678', itemCount: 2, notes: '후문', recipientName: '점주',
      lines: [{ name: '원두', unit: '봉', quantity: 2 }],
    });
  });

  it('fails closed instead of displaying a missing operational amount as zero won', () => {
    const payload: any = bootstrapPayload();
    payload.orders = [{
      id: 'order-1', number: 'PO-1', storeId: 's1', status: 'submitted',
      requestedDeliveryDate: '2026-08-04', createdAt: '2026-08-03T00:00:00.000Z', version: 1,
      lines: [{ id: 'line-1', quantity: 1, supply: 1_000, vat: 100, snapshot: { productId: 'p1', name: '원두', unit: '봉', unitGross: 1_100 } }],
    }];

    expect(() => normalizeBootstrap(payload)).toThrow(/order line gross/i);
  });

  it('does not relabel current catalog prices as verified money for a legacy order', () => {
    const payload: any = bootstrapPayload();
    payload.orders = [{
      id: 'legacy-order-1', number: 'LEGACY-1', storeId: 's1', source: 'legacy_unverified', status: 'submitted',
      requestedDeliveryDate: '2026-08-04', createdAt: '2026-08-03T00:00:00.000Z', version: 1,
      gross: 11_000, supply: 10_000, vat: 1_000,
      lines: [{ id: 'line-1', quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000, snapshot: { productId: 'p1', name: '기존 품목', unit: '박스', unitGross: 11_000 } }],
    }];

    const value = normalizeBootstrap(payload);

    expect(value.orders[0]).toMatchObject({ grossAmount: null, supplyAmount: null, vatAmount: null });
    expect(value.orders[0]?.lines?.[0]).toMatchObject({ unitGross: null, gross: null, supply: null, vat: null });
  });

  it('preserves tax invoice failure and internal-statement provenance in store documents', () => {
    const payload: any = bootstrapPayload();
    payload.taxInvoices = [
      { id: 'invoice-failed', storeId: 's1', issueDate: '2026-08-03', gross: 1_100, supply: 1_000, vat: 100, status: 'failed', issueType: 'tax_invoice' },
      { id: 'statement-1', storeId: 's1', issueDate: '2026-08-03', gross: 2_200, supply: 2_000, vat: 200, status: 'issued', issueType: 'internal_statement' },
    ];

    const value = normalizeBootstrap(payload);

    expect(value.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'invoice-failed', type: 'tax_invoice', status: 'failed' }),
      expect.objectContaining({ id: 'statement-1', type: 'internal_statement', status: 'internal_statement' }),
    ]));
  });

  it('normalizes payment requests, candidates, settlements, and signed modified invoices without losing lifecycle fields', () => {
    const payload: any = bootstrapPayload();
    payload.meta.operationalDate = '2026-08-04';
    payload.currentActor = { id: 'finance-1', name: '재무', role: 'hq_finance' };
    payload.stores = [{ id: 's1', name: '독산점', business: { legalName: '독산점' } }];
    payload.availableActors = [
      { id: 'finance-1', name: '재무', role: 'hq_finance' },
      { id: 'master-1', name: '마스터', role: 'hq_master' },
    ];
    payload.actorDirectory = [{ id: 'finance-1', name: '재무' }, { id: 'master-1', name: '마스터' }];
    payload.paymentRequests = [{ id: 'pay-1', storeId: 's1', amount: 11_000, dueDate: '2026-08-03', status: 'manual_review', depositorHint: '독산', version: 2, createdAt: '2026-08-01T00:00:00Z' }];
    payload.bankTransactions = [{ id: 'bank-1', providerId: 'provider-1', accountId: 'ofd-main', occurredAt: '2026-08-03T01:00:00Z', amount: 11_000, direction: 'credit', memo: '독산', matched: false, version: 1 }];
    payload.manualMatchCandidates = [{ paymentRequestId: 'pay-1', bankTransactionId: 'bank-1', storeId: 's1', amount: 11_000, requestVersion: 2, label: '독산점 · 11,000원' }];
    payload.settlements = [{ id: 'settlement-1', storeId: 's1', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'reviewed', receiptIds: ['receipt-1'], gross: 11_000, supply: 10_000, vat: 1_000, reviewedBy: 'finance-1', reviewedAt: '2026-08-31T01:00:00Z', version: 2 }];
    payload.taxInvoices = [{
      id: 'modified-1', storeId: 's1', settlementId: 'settlement-1', invoiceGroupId: 'group-1', partNumber: 1, partCount: 1,
      issueType: 'modified', status: 'draft', issueDate: '2026-08-31', gross: -11_000, supply: -10_000, vat: -1_000,
      preparedBy: 'finance-1', originalInvoiceId: 'invoice-1', modificationReasonCode: '01', version: 1,
      supplier: { legalName: '본사', businessNumber: '1234567890' }, recipient: { legalName: '독산점', businessNumber: '0987654321' },
    }];

    const value = normalizeBootstrap(payload);
    expect(value.paymentRequests[0]).toMatchObject({ id: 'pay-1', storeName: '독산점', status: 'manual_review', overdue: true, version: 2 });
    expect(value.bankTransactions[0]).toMatchObject({ id: 'bank-1', memo: '독산', matched: false, direction: 'credit' });
    expect(value.manualMatchCandidates[0]).toMatchObject({ paymentRequestId: 'pay-1', bankTransactionId: 'bank-1', requestVersion: 2 });
    expect(value.settlements[0]).toMatchObject({ id: 'settlement-1', status: 'reviewed', reviewedBy: 'finance-1', reviewedByName: '재무' });
    expect(value.invoices[0]).toMatchObject({ id: 'modified-1', issueType: 'modified', grossAmount: -11_000, supplyAmount: -10_000, vatAmount: -1_000, originalInvoiceId: 'invoice-1', modificationReasonCode: '01' });
  });

  it('maps delivery statements and only exposes a current locked settlement original', () => {
    const payload: any = bootstrapPayload();
    payload.orders = [{ id: 'order-1', number: 'PO-1', storeId: 's1', status: 'approved', source: 'native', requestedDeliveryDate: '2026-08-04', createdAt: '2026-08-01T00:00:00Z', gross: 11_000, supply: 10_000, vat: 1_000, version: 1, lines: [] }];
    payload.shipments = [{ id: 'shipment-1', orderId: 'order-1', storeId: 's1', status: 'delivered', plannedDate: '2026-08-04', version: 3 }];
    payload.settlements = [
      { id: 'locked-current', storeId: 's1', periodStart: '2026-07-01', periodEnd: '2026-07-31', status: 'locked', receiptIds: [], gross: 11_000, supply: 10_000, vat: 1_000, version: 2 },
      { id: 'locked-stale', storeId: 's1', periodStart: '2026-06-01', periodEnd: '2026-06-30', status: 'locked', receiptIds: [], gross: 22_000, supply: 20_000, vat: 2_000, version: 4 },
      { id: 'draft-with-file', storeId: 's1', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'draft', receiptIds: [], gross: 33_000, supply: 30_000, vat: 3_000, version: 1 },
    ];
    payload.documents = [
      { id: 'delivery-doc-1', storeId: 's1', kind: 'delivery_statement', aggregateType: 'shipment', aggregateId: 'shipment-1', sourceVersion: 3, fileName: 'delivery.pdf', mimeType: 'application/pdf', sizeBytes: 100, createdAt: '2026-08-04T01:00:00Z' },
      { id: 'current-settlement-doc', storeId: 's1', kind: 'monthly_statement', aggregateType: 'settlement', aggregateId: 'locked-current', sourceVersion: 2, fileName: 'current.pdf', mimeType: 'application/pdf', sizeBytes: 200, createdAt: '2026-08-01T01:00:00Z' },
      { id: 'stale-settlement-doc', storeId: 's1', kind: 'monthly_statement', aggregateType: 'settlement', aggregateId: 'locked-stale', sourceVersion: 3, fileName: 'stale.pdf', mimeType: 'application/pdf', sizeBytes: 200, createdAt: '2026-07-01T01:00:00Z' },
      { id: 'draft-settlement-doc', storeId: 's1', kind: 'monthly_statement', aggregateType: 'settlement', aggregateId: 'draft-with-file', sourceVersion: 1, fileName: 'draft.pdf', mimeType: 'application/pdf', sizeBytes: 200, createdAt: '2026-08-01T01:00:00Z' },
    ];

    const value = normalizeBootstrap(payload);
    expect(value.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'delivery_statement', downloadDocumentId: 'delivery-doc-1', amount: 11_000, status: 'issued' }),
      expect.objectContaining({ id: 'locked-current', status: 'issued', downloadDocumentId: 'current-settlement-doc' }),
      expect.objectContaining({ id: 'locked-stale', status: 'issued' }),
      expect.objectContaining({ id: 'draft-with-file', status: 'scheduled' }),
    ]));
    expect(value.documents.find((document) => document.id === 'locked-stale')).not.toHaveProperty('downloadDocumentId');
    expect(value.documents.find((document) => document.id === 'draft-with-file')).not.toHaveProperty('downloadDocumentId');
  });

  it('validates the array-shaped auto-match response instead of treating counts as arrays', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ paid: [{ id: 'pay-1' }], manualReview: [{ id: 'pay-2' }], unmatched: 1 }))
      .mockResolvedValueOnce(jsonResponse({ paid: 1, manualReview: 0, unmatched: 1 })));

    const result = await autoMatchPaymentsV2('auto-array-key');
    expect(result.paid).toHaveLength(1);
    expect(result.manualReview).toHaveLength(1);
    await expect(autoMatchPaymentsV2('auto-drift-key')).rejects.toThrow(/auto-match response contract mismatch/i);
  });

  it('maps the full reconciliation, settlement, invoice, retry, and on-demand download contracts exactly', async () => {
    const download = { document: { id: 'document-1', kind: 'tax_invoice', aggregateType: 'tax_invoice', aggregateId: 'invoice-1', sourceVersion: 3, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1024, createdAt: '2026-08-04T00:00:00Z' }, downloadUrl: 'https://files.example/signed', expiresInSeconds: 900 };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(jsonResponse(String(input).endsWith('/download') ? download : String(input).endsWith('/auto-match') ? { paid: [], manualReview: [], unmatched: 0 } : { ok: true, invoice: {}, settlement: {}, paymentRequest: {} })));
    vi.stubGlobal('fetch', fetchMock);

    await autoMatchPaymentsV2('auto-key');
    await requestBankSyncV2('2026-08-01', '2026-08-04', 'sync-key');
    await manualMatchPaymentV2('pay-1', 'bank-1', 2, 'manual-key');
    await reversePaymentMatchV2('pay-1', 3, '다른 매장 입금', 'reverse-key');
    await draftSettlementV2({ storeId: 's1', periodStart: '2026-08-01', periodEnd: '2026-08-31' }, 'settlement-key');
    await reviewSettlementV2('settlement-1', 1, 'settlement-review-key');
    await approveSettlementV2('settlement-1', 2, 'settlement-approve-key');
    await draftInvoiceV2('settlement-1', 'invoice-key');
    await reviewInvoiceV2('invoice-1', 1, 'invoice-review-key');
    await modifyInvoiceV2('invoice-1', '01', 'invoice-modify-key');
    await approveInvoiceV2('invoice-1', 2, 'invoice-approve-key');
    await retryInvoiceV2('invoice-1', 3, 'invoice-retry-key');
    expect(await getDocumentDownloadV2('invoice-1')).toEqual(download);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/v2/payments/auto-match', '/api/v2/bank-sync', '/api/v2/payments/pay-1/manual-match', '/api/v2/payments/pay-1/reverse-match',
      '/api/v2/settlements', '/api/v2/settlements/settlement-1/review', '/api/v2/settlements/settlement-1/approve',
      '/api/v2/invoices', '/api/v2/invoices/invoice-1/review', '/api/v2/invoices/invoice-1/modify', '/api/v2/invoices/invoice-1/approve',
      '/api/v2/invoices/invoice-1/retry', '/api/v2/documents/invoice-1/download',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ expectedVersion: 2, bankTransactionId: 'bank-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[9]?.[1]?.body))).toEqual({ reasonCode: '01' });
    expect(JSON.parse(String(fetchMock.mock.calls[11]?.[1]?.body))).toEqual({ expectedVersion: 3 });
    expect(fetchMock.mock.calls[12]?.[1]?.method).toBe('GET');
  });

  it('always loads the operational API even when an old demo query remains in the URL', async () => {
    window.history.replaceState({}, '', '/store/orders?demo=1');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(bootstrapPayload()));
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadBootstrap();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/bootstrap', expect.objectContaining({ credentials: 'same-origin' }));
    expect(result.source).toBe('live');
    expect(result.data.actor.name).toBe('실제 점주');
  });

  it('fails closed when the connected API is not in production mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(bootstrapPayload('demo'))));

    await expect(loadBootstrap()).rejects.toMatchObject({ code: 'NON_PRODUCTION_API' });
  });

  it('fails closed when production mode metadata is missing', async () => {
    const payload = bootstrapPayload();
    payload.meta.appMode = '';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    await expect(loadBootstrap()).rejects.toMatchObject({ code: 'NON_PRODUCTION_API' });
  });

  it('allows the isolated test API only from an explicitly enabled development build', () => {
    expect(isAllowedApiAppMode('production', false, false)).toBe(true);
    expect(isAllowedApiAppMode('test', true, true)).toBe(true);
    expect(isAllowedApiAppMode('test', false, true)).toBe(false);
    expect(isAllowedApiAppMode('test', true, false)).toBe(false);
    expect(isAllowedApiAppMode('demo', true, true)).toBe(false);
  });

  it('adds the existing OFD session mutation guard header to every write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await mutateV2('/orders/order-1/approve', { expectedVersion: 1 }, { idempotencyKey: 'write-1' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/orders/order-1/approve', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-OFD': '1' }),
    }));
  });

  it('parses the legacy flat API error contract without hiding its code or message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'VERSION_CONFLICT',
      message: '다른 담당자가 먼저 변경했습니다.',
      requestId: 'legacy-request-1',
    }, 409)));

    const error = await mutateV2('/orders/order-1/approve', { expectedVersion: 1 }, { idempotencyKey: 'write-2' })
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      message: '다른 담당자가 먼저 변경했습니다.',
      requestId: 'legacy-request-1',
    });
  });
});
