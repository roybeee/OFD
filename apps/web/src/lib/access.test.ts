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
    expect(defaultPathFor(['store.orders.read'])).toBe('/store/home', '점주는 필수 기능만 모은 홈으로 들어온다');
    expect(canAccessPath('/store/home', ['store.orders.read'])).toBe(true);
    expect(canAccessPath('/store/home', ['hq.invoices.read'])).toBe(false, '본사 권한으로는 점주 홈이 열리지 않는다');
    expect(defaultPathFor(['driver.deliveries.read'])).toBe('/driver/today');
    expect(defaultPathFor(['hq.accounts.manage'])).toBe('/hq/accounts');
  });
});

describe('현장 운영 경로 (V1 매장 대장·가맹 영업·감사 이식)', () => {
  it('새 경로는 각자의 권한으로만 열린다', () => {
    expect(canAccessPath('/hq/stores', ['hq.stores.manage'])).toBe(true);
    expect(canAccessPath('/hq/leads', ['hq.leads.manage'])).toBe(true);
    expect(canAccessPath('/hq/audit', ['hq.audit.read'])).toBe(true);
    expect(canAccessPath('/hq/stores', ['hq.pos.read'])).toBe(false, 'POS 조회 권한만으로 대장을 수정 화면에 들어가게 하지 않는다');
    expect(canAccessPath('/hq/audit', ['hq.leads.manage'])).toBe(false);
  });

  it('마스터의 기본 화면은 여전히 정산·세금계산서다', () => {
    const masterCaps = ['hq.settlements.approve', 'hq.settlements.draft', 'hq.invoices.read', 'hq.invoices.approve',
      'hq.pos.read', 'hq.stores.manage', 'hq.leads.manage', 'hq.notices.manage', 'hq.audit.read', 'hq.accounts.manage'];
    expect(defaultPathFor(masterCaps)).toBe('/hq/invoices');
  });

  it('감사인은 조회 권한만으로 감사 로그에 도달한다', () => {
    expect(defaultPathFor(['hq.audit.read'])).toBe('/hq/audit');
  });
});
