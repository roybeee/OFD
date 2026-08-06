import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqStoresPage, formatPhone, haversineKm } from './HqStoresPage';
import { HqLeadsPage } from './HqLeadsPage';
import { HqAuditPage } from './HqAuditPage';
import type { BootstrapData } from '../types';

const data = {
  actor: { id: 'master-1', name: '최고관리자', role: 'hq_master' },
  store: { id: 'store-1', name: '맵달서울점', businessName: '맵달서울점', billingPolicy: '월 합산', paymentTerm: '월 외상' },
  stores: [
    { id: 'store-1', name: '맵달서울점', code: 'ST001', storeKind: '직영' as const, region: '서울 성동',
      roadAddress: '서울 성동구 왕십리로 83-21', notificationPhone: '01012345678', openDate: '2025-11-01', active: true, version: 3 },
    { id: 'store-2', name: '독산점', code: 'ST002', notificationPhone: '0212345678', active: true, version: 1 },
  ],
  availableActors: [{ id: 'master-1', name: '최고관리자', role: 'hq_master' }],
  products: [], orders: [], deliveries: [], bankMatches: [], paymentRequests: [], bankTransactions: [],
  manualMatchCandidates: [], settlements: [], invoices: [], documents: [], drivers: [],
  generatedAt: '', capabilities: ['hq.stores.manage', 'hq.leads.manage', 'hq.audit.read'], allowedDeliveryDates: [], routeDates: [],
  meta: { apiVersion: 'v2', appMode: 'production', providerMode: 'production', externalIssueEnabled: false },
} satisfies BootstrapData;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LEAD = {
  id: 'lead-1', name: '김가맹', phone: '010-1111-2222', area: '수원 영통', storeName: '영통점', stage: 2,
  docDate: '2026-08-01', advisor: false, openTarget: '', memo: '', flag: false, storeId: null, version: 4,
  cooling: { has: true, days: 14, gate: '2026-08-15', ok: false },
};
const STAGES = ['리드', '상담', '정보공개서 제공', '가맹계약', '실사·공사', '오픈완료'];

describe('현장 운영 화면 (매장 대장·가맹 영업·감사)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('전화 포맷과 직선거리 계산은 V1 규칙을 따른다', () => {
    expect(formatPhone('01012345678')).toBe('010-1234-5678');
    expect(formatPhone('0212345678')).toBe('02-1234-5678');
    expect(formatPhone('021234567')).toBe('02-123-4567');
    expect(formatPhone('0311234567')).toBe('031-123-4567');
    expect(formatPhone('010-1234-5678')).toBe('010-1234-5678', '이미 하이픈이 있어도 같은 결과');
    expect(formatPhone('12')).toBe('12', '판단 불가 자릿수는 그대로 둔다');
    /* 서울시청 ↔ 수원시청 ≈ 30km */
    const seoul = { lat: 37.5665, lng: 126.978 };
    const suwon = { lat: 37.2636, lng: 127.0286 };
    expect(haversineKm(seoul, suwon)).toBeGreaterThan(30);
    expect(haversineKm(seoul, suwon)).toBeLessThan(35);
    expect(haversineKm(seoul, seoul)).toBe(0);
  });

  it('매장 대장은 인라인 수정을 낙관적 잠금과 함께 저장한다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/config/navermap')) return json({ keyId: null });
      if (url.includes('/notices')) return json({ notices: [] });
      if (url.includes('/pos/stores/store-1')) return json({ store: {}, changed: ['region'] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn();
    await act(async () => { root = createRoot(container); root.render(<HqStoresPage data={data} notify={vi.fn()} refresh={refresh} />); });

    expect(container.textContent).toContain('맵달서울점');
    expect(container.textContent).toContain('010-1234-5678'); // 저장은 숫자, 표시는 포맷
    expect(container.textContent).toContain('네이버 지도 키가 아직 없습니다');

    const editButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '수정')!;
    await act(async () => editButton.click());
    const regionInput = container.querySelector<HTMLInputElement>('input[aria-label="지역"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(regionInput, '서울 성수');
      regionInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '저장')!.click());

    const patchCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/pos/stores/store-1'))!;
    expect(patchCall[1]).toMatchObject({ method: 'PATCH' });
    const body = JSON.parse(String(patchCall[1]?.body)) as Record<string, unknown>;
    expect(body.expectedVersion).toBe(3);
    expect(body.region).toBe('서울 성수');
    expect(refresh).toHaveBeenCalled();
  });

  it('가맹 영업은 숙려기간 409를 받으면 경고 확인 후에만 override로 재시도한다', async () => {
    let stageCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/leads') && (!init?.method || init.method === 'GET')) return json({ stages: STAGES, leads: [LEAD] });
      if (url.includes('/leads/lead-1/stage')) {
        stageCalls += 1;
        const body = JSON.parse(String(init?.body)) as { override?: boolean };
        if (!body.override) return json({ error: { code: 'COOLING', message: '숙려기간 미경과 — 2026-08-15 이후 가맹계약이 가능합니다.', details: { gate: '2026-08-15', days: 14 } } }, 409);
        return json({ lead: { ...LEAD, stage: 3, flag: true } });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    await act(async () => { root = createRoot(container); root.render(<HqLeadsPage data={data} notify={vi.fn()} />); });

    expect(container.textContent).toContain('정보공개서 제공');
    expect(container.textContent).toContain('숙려기간 중 · 2026-08-15 이후 계약 가능');

    await act(async () => [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '김가맹 다음 단계')!.click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0]?.[0])).toContain('숙려기간 미준수 사후기록');
    expect(stageCalls).toBe(2); // 409 후 override 재시도

    /* 사용자가 경고를 거부하면 override 호출이 없어야 한다 */
    confirmMock.mockReturnValueOnce(false);
    stageCalls = 0;
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '김가맹 다음 단계')!.click());
    expect(stageCalls).toBe(1);
  });

  it('감사 로그는 기본 필터(시스템 제외)로 조회하고 검색 조건을 쿼리로 보낸다', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/audit')) {
        return json({ total: 1, rows: [{ id: 'audit-1', aggregateType: 'store', aggregateId: 'store-1', action: 'store.updated',
          actorId: 'master-1', actorRole: 'hq_master', storeId: 'store-1', metadata: { changed: ['region'] }, occurredAt: '2026-08-06T15:00:00.000Z' }] });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root = createRoot(container); root.render(<HqAuditPage data={data} notify={vi.fn()} />); });

    const first = String(fetchMock.mock.calls[0]?.[0]);
    expect(first).toContain('/audit?');
    expect(first).toContain('noSched=1');
    expect(first).toContain('page=1');
    expect(container.textContent).toContain('store.updated');
    expect(container.textContent).toContain('최고관리자');
    expect(container.textContent).toContain('맵달서울점');
    expect(container.textContent).toContain('1건 · 1/1 페이지');

    const keyword = container.querySelector<HTMLInputElement>('form[aria-label="감사 로그 검색"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(keyword, '숙려');
      keyword.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '검색')!.click());
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`q=${encodeURIComponent('숙려')}`);
  });
});
