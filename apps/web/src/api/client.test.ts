import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdempotencyKey, normalizeBootstrap } from './client';

afterEach(() => vi.unstubAllGlobals());

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
      stores: [{ id: 's1', name: '독산점', business: { legalName: '독산사업자', representativeName: '박점주', address: '서울 금천구', businessNumber: '1' }, billingCycle: 'monthly', paymentMethod: 'monthly_credit' }],
      products: [{ id: 'p1', name: '원두', unit: '봉', unitGross: 28_600 }],
      orders: [{ id: 'o1', number: 'PO-1', storeId: 's1', status: 'submitted', requestedDeliveryDate: '2026-08-04', lines: [{ quantity: 2 }], gross: 57_200, createdAt: '2026-08-02T00:00:00.000Z', version: 1 }],
      shipments: [], paymentRequests: [], bankTransactions: [], settlements: [], taxInvoices: [], receipts: [],
    });
    expect(value.store.name).toBe('독산점');
    expect(value.products[0]).toMatchObject({ id: 'p1', grossPrice: 28_600 });
    expect(value.orders[0]).toMatchObject({ code: 'PO-1', grossAmount: 57_200, itemCount: 2 });
    expect(value.deliveries).toEqual([]);
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
});
