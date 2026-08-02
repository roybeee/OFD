import { describe, expect, it } from 'vitest';
import { browserPathFor, logicalPathFromLocation } from './access';

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
});
