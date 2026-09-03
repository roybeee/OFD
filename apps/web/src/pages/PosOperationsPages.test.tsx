import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqSalesPage } from './HqSalesPage';
import { HqProductsPage } from './HqProductsPage';
import { HqOpeningsPage } from './HqOpeningsPage';
import type { BootstrapData } from '../types';

const data = {
  actor: { id: 'master-1', name: '최고관리자', role: 'hq_master' },
  store: { id: 'store-1', name: '맵달서울점', businessName: '맵달서울점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
  stores: [{ id: 'store-1', name: '맵달서울점' }, { id: 'store-2', name: '독산점' }],
  products: [], orders: [], deliveries: [], bankMatches: [], paymentRequests: [], bankTransactions: [],
  manualMatchCandidates: [], settlements: [], invoices: [], documents: [], drivers: [],
  generatedAt: '', capabilities: ['hq.pos.read'], allowedDeliveryDates: [], routeDates: [],
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false },
} satisfies BootstrapData;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LINKS = {
  links: [
    { id: 'link-1', storeId: 'store-1', merchantId: '480975', status: 'active', lastSyncAt: null },
    { id: 'link-2', storeId: 'store-2', merchantId: '521445', status: 'active', lastSyncAt: null },
  ],
};

const REPORT = {
  unit: 'day',
  storeIds: ['store-1', 'store-2'],
  rows: [{
    bucket: '2026-08-03', label: '2026-08-03',
    perStore: { 'store-1': { qty: 6, amount: 24_000 }, 'store-2': { qty: 2, amount: 8_400 } },
    total: { qty: 8, amount: 32_400 },
    mix: [
      { key: 'p1', name: '우유크림도넛', productId: 'p1', category: '도넛', qty: 7, amount: 29_400,
        stores: [{ storeId: 'store-1', qty: 5, amount: 21_000 }, { storeId: 'store-2', qty: 2, amount: 8_400 }] },
      { key: '__unmatched', name: '미매칭(기타)', productId: null, category: null, qty: 1, amount: 3_000,
        stores: [{ storeId: 'store-1', qty: 1, amount: 3_000 }] },
    ],
  }],
};

describe('POS 현장 운영 화면', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  }

  async function render(node: React.ReactElement) {
    await act(async () => {
      root = createRoot(container);
      root.render(node);
    });
  }

  it('매출현황: 매장 피벗을 그리고 행을 클릭하면 품목 내역이 펼쳐진다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json(REPORT);
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqSalesPage data={data} notify={() => {}} />);

    expect(container.textContent).toContain('매출현황');
    expect(container.textContent).toContain('32,400');
    /* 매장 열·필터는 상점번호(merchantId)가 아니라 매장 이름으로 표기한다 */
    expect(container.textContent).toContain('맵달서울점');
    expect(container.textContent).toContain('독산점');
    expect(container.textContent).not.toContain('480975');
    expect(container.textContent).not.toContain('우유크림도넛');

    const toggle = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('2026-08-03'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { (toggle as HTMLButtonElement).click(); });

    expect(container.textContent).toContain('우유크림도넛');
    expect(container.textContent).toContain('미매칭(기타)');
    expect(container.textContent).toContain('90.7%');
    expect(container.textContent).toContain('4,200원'); /* 품목 단가 = 29,400 ÷ 7 */
    const reopened = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('2026-08-03'))!;
    expect(reopened.getAttribute('aria-expanded')).toBe('true');

    /* 품목 표 위에 카테고리별 매출 분포 — 색은 카테고리 이름에 고정 배정(순위 아님) */
    const mix = container.querySelector('.category-mix')!;
    expect(mix).toBeTruthy();
    expect(mix.textContent).toContain('도넛');
    expect(mix.textContent).toContain('90.7%');   /* 도넛 29,400 / 32,400 */
    expect(mix.textContent).toContain('미분류');   /* 상품 미매칭 품목 */
    expect(mix.textContent).toContain('9.3%');
    const donutSlice = mix.querySelector<HTMLElement>('.category-slice')!;
    expect(donutSlice.style.background).toBe('rgb(42, 120, 214)'); /* 도넛 = 슬롯1 blue */
  });

  it('POS 연동: 링크가 없으면 설정 패널이 자동으로 열리고, 매장 등록→토스 연동을 순서대로 보낸다', async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/pos/stores')) {
        captured.push({ url, body: JSON.parse(String(init.body)) });
        return json({ store: { id: 'store-9', code: 'ST003', name: '판교점' } }, 201);
      }
      if (init?.method === 'POST' && url.includes('/pos/links')) {
        captured.push({ url, body: JSON.parse(String(init.body)) });
        return json({ id: 'link-9', storeId: 'store-9', merchantId: '777', status: 'active' }, 201);
      }
      if (url.includes('/pos/report')) return json({ unit: 'day', storeIds: [], rows: [] });
      if (url.includes('/pos/links')) return json({ links: [] });
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    await render(<HqSalesPage data={data} notify={notify} />);

    expect(container.textContent).toContain('POS 연동 관리');
    expect(container.textContent).toContain('아직 연동된 매장이 없습니다');

    const nameInput = [...container.querySelectorAll('input[type="text"]')].find((node) => (node as HTMLInputElement).placeholder.includes('독산점')) as HTMLInputElement;
    await act(async () => { setValue(nameInput, '판교점'); });
    const storeButton = [...container.querySelectorAll('button')].find((node) => node.textContent === '매장 등록') as HTMLButtonElement;
    await act(async () => { storeButton.click(); });
    expect(captured[0]?.url).toContain('/pos/stores');
    expect(captured[0]?.body).toMatchObject({ name: '판교점', billingCycle: 'monthly' });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('ST003'), 'success');

    const merchantInput = [...container.querySelectorAll('input[type="text"]')].find((node) => (node as HTMLInputElement).placeholder.includes('매장 ID')) as HTMLInputElement;
    const [accessInput, secretInput] = [...container.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
    await act(async () => {
      setValue(merchantInput, '777');
      setValue(accessInput, 'AK');
      setValue(secretInput, 'SK');
    });
    const linkButton = [...container.querySelectorAll('button')].find((node) => node.textContent === '연동 등록') as HTMLButtonElement;
    await act(async () => { linkButton.click(); });
    expect(captured[1]?.url).toContain('/pos/links');
    expect(captured[1]?.body).toMatchObject({ storeId: 'store-9', merchantId: '777', accessKey: 'AK', secretKey: 'SK' });
  });

  it('매출현황: 매출 숫자를 클릭해도 품목별 판매가 열리고 매장 셀은 그 매장만 보여준다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json(REPORT);
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqSalesPage data={data} notify={() => {}} />);
    expect(container.textContent).not.toContain('우유크림도넛');

    /* 합계(32,400) 셀 클릭 → 전체 품목 내역이 열린다 */
    const totalCell = [...container.querySelectorAll('button.cell-toggle')].find((node) => node.textContent?.includes('32,400'))!;
    await act(async () => { (totalCell as HTMLButtonElement).click(); });
    expect(container.textContent).toContain('우유크림도넛');
    expect(container.textContent).toContain('미매칭(기타)');

    /* 독산점(store-2) 셀 클릭 → 그 매장 판매만: 미매칭(store-1 전용)은 사라진다 */
    const storeCell = [...container.querySelectorAll('button.cell-toggle')].find((node) => node.textContent?.trim() === '8,400')!;
    await act(async () => { (storeCell as HTMLButtonElement).click(); });
    const drill = container.querySelector('.drilldown')!;
    expect(drill.textContent).toContain('독산점');
    expect(drill.textContent).toContain('우유크림도넛');
    expect(drill.textContent).not.toContain('미매칭(기타)');
    expect(drill.textContent).toContain('전체 보기');

    /* 같은 셀을 다시 누르면 접힌다 */
    const sameCell = [...container.querySelectorAll('button.cell-toggle')].find((node) => node.textContent?.trim() === '8,400')!;
    await act(async () => { (sameCell as HTMLButtonElement).click(); });
    expect(container.querySelector('.drilldown')).toBeNull();
  });

  it('POS 연동: 웹훅으로 자동 수집된 merchantId 칩을 클릭하면 입력칸에 채워진다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json({ unit: 'day', storeIds: [], rows: [] });
      if (url.includes('/pos/discovered')) {
        return json({ merchants: [{ merchantId: '905533', eventType: 'app.installation.created.v1', lastSeenAt: '2026-08-12T04:00:00.000Z' }],
          lastWebhook: { receivedAt: '2026-08-12T04:00:00.000Z', eventType: 'app.installation.created.v1', merchantId: '905533' } });
      }
      if (url.includes('/pos/links')) return json({ links: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqSalesPage data={data} notify={() => {}} />);

    const strip = container.querySelector('[data-testid="discovered-merchants"]');
    expect(strip).toBeTruthy();
    expect(strip!.textContent).toContain('앱 설치가 감지');
    const chip = [...strip!.querySelectorAll('button')].find((node) => node.textContent?.includes('905533')) as HTMLButtonElement;
    await act(async () => { chip.click(); });
    const merchantInput = [...container.querySelectorAll('input[type="text"]')]
      .find((node) => (node as HTMLInputElement).placeholder.includes('매장 ID')) as HTMLInputElement;
    expect(merchantInput.value).toBe('905533');
    /* 파이프 생사는 칩과 별개로 항상 보여야 한다 */
    expect(container.querySelector('[data-testid="webhook-heartbeat"]')!.textContent)
      .toContain('웹훅 마지막 수신 2026-08-12 04:00');
  });

  it('POS 연동: 웹훅을 한 번도 받지 못하면 개발자센터 설정을 확인하라고 알린다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json({ unit: 'day', storeIds: [], rows: [] });
      if (url.includes('/pos/discovered')) return json({ merchants: [], lastWebhook: null });
      if (url.includes('/pos/links')) return json({ links: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqSalesPage data={data} notify={() => {}} />);

    expect(container.querySelector('[data-testid="discovered-merchants"]')).toBeNull();
    expect(container.querySelector('[data-testid="webhook-heartbeat"]')!.textContent)
      .toContain('한 번도 받지 못했습니다');
  });

  it('매출현황: 엑셀 내보내기는 체크한 섹션만 CSV로 담는다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json(REPORT);
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let captured = '';
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: (blob: Blob) => { void blob.text().then((text) => { captured = text; }); return 'blob:mock'; },
      revokeObjectURL: () => {},
    }));
    const notify = vi.fn();
    await render(<HqSalesPage data={data} notify={notify} />);

    const openButton = [...container.querySelectorAll('button')].find((node) => node.textContent === '엑셀 내보내기') as HTMLButtonElement;
    await act(async () => { openButton.click(); });
    const panel = container.querySelector('[data-testid="sales-export-panel"]')!;
    expect(panel.textContent).toContain('품목×매장 분해');

    /* 기본 체크(요약·매출 피벗·품목 상세)에서 요약을 끄고 내보낸다 */
    const summaryBox = [...panel.querySelectorAll('label')].find((node) => node.textContent?.includes('요약 지표'))!
      .querySelector('input') as HTMLInputElement;
    await act(async () => { summaryBox.click(); });
    const download = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'CSV 다운로드') as HTMLButtonElement;
    await act(async () => { download.click(); });
    await act(async () => {}); /* blob.text() 비동기 캡처 대기 */

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('내보내기 완료'), 'success');
    expect(captured).toContain('기간별 매장 매출(원)');
    expect(captured).toContain('맵달서울점');       /* 매장 이름 열 */
    expect(captured).toContain('품목별 판매 상세');
    expect(captured).not.toContain('기간 합계(원)');  /* 요약은 껐다 */
    expect(captured).not.toContain('품목×매장 분해'); /* 기본 미선택 */
  });

  it('매출현황: 집계 단위를 바꾸면 해당 unit으로 다시 조회한다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json({ ...REPORT, unit: url.includes('unit=week') ? 'week' : 'day' });
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqSalesPage data={data} notify={() => {}} />);

    const weekly = [...container.querySelectorAll('button.chip')].find((node) => node.textContent === '주별')!;
    await act(async () => { (weekly as HTMLButtonElement).click(); });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('unit=week'))).toBe(true);
  });

  it('상품 관리: 미매칭 품목에 유사도 제안을 띄우고 매핑 결과를 알린다', async () => {
    const notify = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pos/products') && init?.method === 'POST') return json({ product: { id: 'p9' } }, 201);
      if (url.includes('/pos/products')) {
        return json({
          products: [{ id: 'p1', sku: 'S1', name: '우유크림도넛', category: '도넛', storeId: null, consumerPrice: 4_200 }],
          deviations: [{ productId: 'p1', productName: '시나몬슈가', storeId: 'store-2', consumerPrice: 3_400, avgSoldPrice: 3_713, deviationPct: 9.2 }],
        });
      }
      if (url.includes('/pos/unmatched')) {
        return json({ items: [{ storeId: 'store-2', rawName: '우유크림 도넛', qty: 3, amount: 12_600,
          suggestion: { productId: 'p1', productName: '우유크림도넛', similarity: 92 } }] });
      }
      if (url.includes('/pos/aliases')) return json({ aliasId: 'a1', scopeStoreId: null, relinked: 3 }, 201);
      if (url.includes('/pos/waste')) return json({ storeId: 'store-1', date: '2026-08-04', hasReceipt: false, hasPos: true,
        items: [], totals: { received: null, sold: 12, waste: null, wasteRatePct: null, lossAmount: null } });
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqProductsPage data={data} notify={notify} />);

    expect(container.textContent).toContain('미매칭 품목 정리');
    expect(container.textContent).toContain('유사도 92%');
    expect(container.textContent).toContain('+9.2%');
    expect(container.textContent).toContain('입고 기록이 없어 폐기를 계산할 수 없습니다');

    const select = container.querySelector('.inline-actions select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'p1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('3건 소급 반영'), 'success');
  });

  it('상품 관리: 카테고리·범위·소비자가를 표에서 바로 수정하고 V1 품목을 일괄 등록한다', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    let created = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pos/products') && init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return json({ product: { id: 'p1' } });
      }
      if (url.includes('/pos/products') && init?.method === 'POST') { created += 1; return json({ product: { id: `v1-${created}` } }, 201); }
      if (url.includes('/pos/products')) {
        return json({ products: [{ id: 'p1', sku: 'S1', name: '우유크림도넛', category: '기타', storeId: null, consumerPrice: 4_200 }], deviations: [] });
      }
      if (url.includes('/pos/unmatched')) return json({ items: [] });
      if (url.includes('/pos/waste')) return json({ storeId: 'store-1', date: '2026-08-04', hasReceipt: false, hasPos: false,
        items: [], totals: { received: null, sold: 0, waste: null, wasteRatePct: null, lossAmount: null } });
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    await render(<HqProductsPage data={data} notify={notify} />);

    /* 카테고리 인라인 수정 → PATCH */
    const categorySelect = container.querySelector('select[aria-label="우유크림도넛 카테고리"]') as HTMLSelectElement;
    await act(async () => { setValue(categorySelect, '도넛'); });
    expect(patches[0]?.body).toMatchObject({ category: '도넛' });

    /* 범위(매장 전용) 인라인 수정 → PATCH */
    const scopeSelect = container.querySelector('select[aria-label="우유크림도넛 범위"]') as HTMLSelectElement;
    await act(async () => { setValue(scopeSelect, 'store-2'); });
    expect(patches[1]?.body).toMatchObject({ storeId: 'store-2' });

    /* V1 카탈로그 일괄 등록 — 이미 있는 우유크림도넛은 건너뛰고 40종만 등록 */
    const importButton = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('V1 품목 불러오기')) as HTMLButtonElement;
    await act(async () => { importButton.click(); });
    expect(created).toBe(40);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('V1 품목 40종 등록 완료'), 'success');
  });

  it('상품 관리: 상품을 클릭하면 매장별 현재 판매가가 펼쳐진다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/products')) {
        return json({
          products: [{ id: 'p1', sku: 'S1', name: '우유크림도넛', category: '도넛', storeId: null, consumerPrice: 4_200 }],
          deviations: [],
          storePrices: [
            { productId: 'p1', storeId: 'store-1', qty: 10, amount: 42_000, avgPrice: 4_200 },
            { productId: 'p1', storeId: 'store-2', qty: 5, amount: 23_500, avgPrice: 4_700 },
          ],
        });
      }
      if (url.includes('/pos/unmatched')) return json({ items: [] });
      if (url.includes('/pos/waste')) return json({ storeId: 'store-1', date: '2026-08-04', hasReceipt: false, hasPos: false,
        items: [], totals: { received: null, sold: 0, waste: null, wasteRatePct: null, lossAmount: null } });
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqProductsPage data={data} notify={() => {}} />);
    for (let attempt = 0; attempt < 20 && !container.textContent?.includes('우유크림도넛'); attempt += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    /* 펼치기 전에는 매장별 판매가가 보이지 않는다 */
    expect(container.querySelector('.row-detail')).toBeNull();

    const toggle = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('우유크림도넛'))!;
    await act(async () => { (toggle as HTMLButtonElement).click(); });

    const detail = container.querySelector('.row-detail')!;
    expect(detail.textContent).toContain('매장별 현재 판매가');
    expect(detail.textContent).toContain('맵달서울점');
    expect(detail.textContent).toContain('4,200원');
    expect(detail.textContent).toContain('독산점');
    expect(detail.textContent).toContain('4,700원');
    expect(detail.textContent).toContain('+11.9%'); /* 4,700 vs 등록 4,200 */

    /* 다시 누르면 접힌다 */
    const reopened = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('우유크림도넛'))!;
    await act(async () => { (reopened as HTMLButtonElement).click(); });
    expect(container.querySelector('.row-detail')).toBeNull();
  });

  it('상품 관리: 입고가 있으면 폐기율과 로스를 보여준다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/products')) return json({ products: [], deviations: [] });
      if (url.includes('/pos/unmatched')) return json({ items: [] });
      if (url.includes('/pos/waste')) {
        return json({
          storeId: 'store-1', date: '2026-08-04', hasReceipt: true, hasPos: true,
          items: [{ productId: 'p1', productName: '우유크림도넛', received: 70, sold: 60, waste: 10, over: 0, wasteRatePct: 14.3, lossAmount: 20_160 }],
          totals: { received: 70, sold: 60, waste: 10, wasteRatePct: 14.3, lossAmount: 20_160 },
        });
      }
      if (url.includes('/pos/links')) return json(LINKS);
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqProductsPage data={data} notify={() => {}} />);

    expect(container.textContent).toContain('폐기율 14.3%');
    expect(container.textContent).toContain('20,160');
  });

  it('오픈: 칸반 단계별 카드와 지연을 표시하고 상세 체크리스트를 연다', async () => {
    const opening = {
      id: 'op-1', name: '판교점', region: '경기 성남', openDate: '2026-09-01', mode: '가맹', storeType: '테이블형',
      stage: '진행', storeId: null, memo: '', total: 52, done: 13, overdue: 2, progressPct: 25, dDay: 28,
      phases: { 'D-4주차': { total: 17, done: 13 }, 'D-3주차': { total: 4, done: 0 }, 'D-2주차': { total: 9, done: 0 }, 'D-1주차': { total: 14, done: 0 }, 'D-DAY': { total: 8, done: 0 } },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/openings/op-1')) {
        return json({ ...opening, tasks: [
          { id: 't1', phase: 'D-4주차', group: '초기 구성', title: '영업신고증 발급', detail: '오픈일 기준 10일 전까지 준비',
            owner: 'pt', dayOffset: -10, deadline: '2026-08-22', done: false, doneAt: null, memo: '', overdue: true, custom: false },
        ] });
      }
      if (url.includes('/openings')) {
        return json({ openings: [opening], board: { 상담중: [], 진행: [opening], 보류: [], 완료: [] },
          kpi: { active: 1, overdue: 2, within30Days: 1 } });
      }
      if (url.includes('/pos/discovered')) return json({ merchants: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<HqOpeningsPage data={data} notify={() => {}} />);

    expect(container.textContent).toContain('판교점');
    expect(container.textContent).toContain('D-28');
    expect(container.textContent).toContain('13/52 완료');
    expect(container.querySelector('.kanban-card.card-alert')).not.toBeNull();

    const title = container.querySelector('button.kanban-title') as HTMLButtonElement;
    await act(async () => { title.click(); });
    expect(container.textContent).toContain('영업신고증 발급');
    expect(container.textContent).toContain('마감 2026-08-22');
    expect(container.querySelector('.task-overdue')).not.toBeNull();
  });
});
