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
    { id: 'link-1', storeId: 'store-1', merchantId: '맵달서울점', status: 'active', lastSyncAt: null },
    { id: 'link-2', storeId: 'store-2', merchantId: '독산점', status: 'active', lastSyncAt: null },
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
      { key: 'p1', name: '우유크림도넛', productId: 'p1', qty: 7, amount: 29_400,
        stores: [{ storeId: 'store-1', qty: 5, amount: 21_000 }, { storeId: 'store-2', qty: 2, amount: 8_400 }] },
      { key: '__unmatched', name: '미매칭(기타)', productId: null, qty: 1, amount: 3_000,
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
    expect(container.textContent).not.toContain('우유크림도넛');

    const toggle = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('2026-08-03'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { (toggle as HTMLButtonElement).click(); });

    expect(container.textContent).toContain('우유크림도넛');
    expect(container.textContent).toContain('미매칭(기타)');
    expect(container.textContent).toContain('90.7%');
    const reopened = [...container.querySelectorAll('button.row-toggle')].find((node) => node.textContent?.includes('2026-08-03'))!;
    expect(reopened.getAttribute('aria-expanded')).toBe('true');
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

  it('POS 연동: 웹훅으로 자동 수집된 merchantId 칩을 클릭하면 입력칸에 채워진다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/report')) return json({ unit: 'day', storeIds: [], rows: [] });
      if (url.includes('/pos/discovered')) {
        return json({ merchants: [{ merchantId: '905533', eventType: 'app.installation.created.v1', lastSeenAt: '2026-08-12T04:00:00.000Z' }] });
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
