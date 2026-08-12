import { describe, expect, it } from 'vitest';
import { buildSalesCsv, type SalesExportOptions } from './sales-export';
import type { PosReportResult } from '../api/client';

const REPORT: PosReportResult = {
  unit: 'day',
  storeIds: ['store-1', 'store-2'],
  rows: [{
    bucket: '2026-08-03', label: '2026-08-03',
    perStore: { 'store-1': { qty: 6, amount: 24_000 }, 'store-2': { qty: 2, amount: 8_400 } },
    total: { qty: 8, amount: 32_400 },
    mix: [
      { key: 'p1', name: '우유크림, "특제"', productId: 'p1', qty: 7, amount: 29_400,
        stores: [{ storeId: 'store-1', qty: 5, amount: 21_000 }, { storeId: 'store-2', qty: 2, amount: 8_400 }] },
      { key: '__unmatched', name: '미매칭(기타)', productId: null, qty: 1, amount: 3_000,
        stores: [{ storeId: 'store-1', qty: 1, amount: 3_000 }] },
    ],
  }],
};

const names: Record<string, string> = { 'store-1': '맵달서울성수점', 'store-2': '독산점' };
const label = (storeId: string) => names[storeId] ?? storeId;
const range = { from: '2026-08-03', to: '2026-08-03' };
const all: SalesExportOptions = { summary: true, pivotAmount: true, pivotQty: true, items: true, itemsByStore: true };

describe('buildSalesCsv', () => {
  it('선택한 섹션만 담고 BOM으로 시작한다', () => {
    const csv = buildSalesCsv(REPORT, label, range, { ...all, pivotQty: false, itemsByStore: false });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('기간 합계(원),32400');
    expect(csv).toContain('기간별 매장 매출(원)');
    expect(csv).not.toContain('기간별 매장 수량(개)');
    expect(csv).toContain('품목별 판매 상세');
    expect(csv).not.toContain('품목×매장 분해');
  });

  it('피벗은 매장 이름 열과 합계를 쓰고 빈 매장은 0으로 채운다', () => {
    const csv = buildSalesCsv(REPORT, label, range, { ...all, summary: false, items: false, itemsByStore: false });
    expect(csv).toContain('기간,맵달서울성수점,독산점,합계');
    expect(csv).toContain('2026-08-03,24000,8400,32400');
    expect(csv).toContain('2026-08-03,6,2,8');
  });

  it('품목 상세는 단가·비중을 계산하고 쉼표·따옴표가 든 품목명을 이스케이프한다', () => {
    const csv = buildSalesCsv(REPORT, label, range, { ...all, summary: false, pivotAmount: false, pivotQty: false, itemsByStore: false });
    expect(csv).toContain('"우유크림, ""특제""",4200,7,29400,90.7');
    expect(csv).toContain('미매칭(기타),3000,1,3000,9.3');
  });

  it('품목×매장 분해는 매장 이름으로 행을 만든다', () => {
    const csv = buildSalesCsv(REPORT, label, range, { summary: false, pivotAmount: false, pivotQty: false, items: false, itemsByStore: true });
    expect(csv).toContain('맵달서울성수점,5,21000');
    expect(csv).toContain('독산점,2,8400');
    expect(csv).not.toContain('품목별 판매 상세');
  });
});
