export function odaMasterSettlementPath(storeId: string, tab = 'overview', anchor = '', month = '') {
  const params = new URLSearchParams({ tab });
  if (storeId) params.set('store', storeId);
  if (month) params.set('month', month);
  return `/hq/oda-settlement?${params}${anchor ? `#${anchor}` : ''}`;
}

