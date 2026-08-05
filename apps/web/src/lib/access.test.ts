import { describe, expect, it } from 'vitest';
import { browserPathFor, canAccessPath, defaultPathFor, logicalPathFromLocation } from './access';

describe('V2 deployment base path', () => {
  it('converts a deployed /v2 URL into the logical role route', () => {
    expect(logicalPathFromLocation('/v2/hq/orders', '/v2/')).toBe('/hq/orders');
    expect(logicalPathFromLocation('/v2/driver/today', '/v2/')).toBe('/driver/today');
  });

  it('keeps local root routes unchanged', () => {
    expect(logicalPathFromLocation('/store/orders', '/')).toBe('/store/orders');
    expect(browserPathFor('/store/documents', '/')).toBe('/store/documents');
  });

  it('prefixes navigation paths exactly once in the deployed app', () => {
    expect(browserPathFor('/hq/invoices', '/v2/')).toBe('/v2/hq/invoices');
    expect(browserPathFor('/v2/hq/invoices', '/v2/')).toBe('/v2/hq/invoices');
  });

  it('POS 현장 운영 경로는 hq.pos.read 권한으로 열린다 (마스터·재무·운영)', () => {
    expect(canAccessPath('/hq/sales', ['hq.pos.read'])).toBe(true);
    expect(canAccessPath('/hq/products', ['hq.pos.read'])).toBe(true);
    expect(canAccessPath('/hq/openings', ['hq.pos.read'])).toBe(true);
    expect(canAccessPath('/hq/sales', ['hq.orders.read'])).toBe(false, '주문 권한만으로는 열리지 않는다');
    expect(canAccessPath('/hq/sales', ['store.orders.read'])).toBe(false);
    expect(defaultPathFor(['hq.pos.read'])).toBe('/hq/sales', '마스터의 첫 화면 후보에 포함');
  });

  it('lands store owners, drivers, and account masters on their first permitted route', () => {
    expect(defaultPathFor(['store.orders.read'])).toBe('/store/orders');
    expect(defaultPathFor(['driver.deliveries.read'])).toBe('/driver/today');
    expect(defaultPathFor(['hq.accounts.manage'])).toBe('/hq/accounts');
  });
});
