import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, loadBootstrap, mutateV2, newIdempotencyKey, normalizeBootstrap } from './client';

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
