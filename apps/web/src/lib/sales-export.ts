import type { PosReportResult } from '../api/client';

/** 매출현황 엑셀(CSV·BOM) 추출 — 체크박스로 고른 섹션만 담는다. */
export interface SalesExportOptions {
  summary: boolean;       // 요약 지표 (기간 합계·판매 수량·구간 평균)
  pivotAmount: boolean;   // 기간×매장 매출(원)
  pivotQty: boolean;      // 기간×매장 수량(개)
  items: boolean;         // 기간×품목 상세 (단가·수량·매출·비중)
  itemsByStore: boolean;  // 기간×품목×매장 분해
}

export const SALES_EXPORT_LABELS: Record<keyof SalesExportOptions, string> = {
  summary: '요약 지표 (합계·수량·평균)',
  pivotAmount: '기간×매장 매출',
  pivotQty: '기간×매장 수량',
  items: '품목별 판매 상세',
  itemsByStore: '품목×매장 분해',
};

const cell = (value: string | number): string => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const line = (values: Array<string | number>): string => values.map(cell).join(',');

export function buildSalesCsv(
  report: PosReportResult,
  storeLabel: (storeId: string) => string,
  range: { from: string; to: string },
  options: SalesExportOptions,
): string {
  const sections: string[] = [];
  const stores = report.storeIds;
  const totalAmount = report.rows.reduce((acc, row) => acc + row.total.amount, 0);
  const totalQty = report.rows.reduce((acc, row) => acc + row.total.qty, 0);

  if (options.summary) {
    sections.push([
      line(['조회 기간', `${range.from} ~ ${range.to}`]),
      line(['집계 단위', report.unit === 'day' ? '일별' : report.unit === 'week' ? '주별' : '월별']),
      line(['기간 합계(원)', totalAmount]),
      line(['판매 수량(개)', totalQty]),
      line(['구간 수', report.rows.length]),
      line(['구간 평균(원)', report.rows.length ? Math.round(totalAmount / report.rows.length) : 0]),
    ].join('\n'));
  }

  const pivot = (metric: 'amount' | 'qty', title: string) => [
    line([title]),
    line(['기간', ...stores.map(storeLabel), '합계']),
    ...report.rows.map((row) => line([
      row.label,
      ...stores.map((storeId) => row.perStore[storeId]?.[metric] ?? 0),
      row.total[metric],
    ])),
  ].join('\n');
  if (options.pivotAmount) sections.push(pivot('amount', '기간별 매장 매출(원)'));
  if (options.pivotQty) sections.push(pivot('qty', '기간별 매장 수량(개)'));

  if (options.items) {
    sections.push([
      line(['품목별 판매 상세']),
      line(['기간', '품목', '단가(원)', '수량', '매출(원)', '비중(%)']),
      ...report.rows.flatMap((row) => row.mix.map((mix) => line([
        row.label, mix.name,
        mix.qty > 0 ? Math.round(mix.amount / mix.qty) : 0,
        mix.qty, mix.amount,
        row.total.amount ? Math.round((mix.amount / row.total.amount) * 1000) / 10 : 0,
      ]))),
    ].join('\n'));
  }

  if (options.itemsByStore) {
    sections.push([
      line(['품목×매장 분해']),
      line(['기간', '품목', '매장', '수량', '매출(원)']),
      ...report.rows.flatMap((row) => row.mix.flatMap((mix) => mix.stores.map((store) => line([
        row.label, mix.name, storeLabel(store.storeId), store.qty, store.amount,
      ])))),
    ].join('\n'));
  }

  return `\uFEFF${sections.join('\n\n')}\n`;  /* BOM — 엑셀 한글 인코딩 호환 */
}
