import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import type { HrResponse, HrWorkspace } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../api/src/app';
import { normalizeBootstrap } from '../api/client';
import { hrToday } from '../hr/shared';
import { OdaStaffPage } from './OdaStaffPage';

// The page, HTTP client, Fastify routes, domain and repository are real. Only
// fetch transport and the device's native location response are controlled.
// Vite changes backend import.meta.url in JSDOM, so supply the real filesystem
// migration directory while retaining real SQL discovery and checksum reads.
vi.mock('@ofd/db', async importOriginal => {
  const original = await importOriginal<typeof import('@ofd/db')>();
  const [{ existsSync }, { dirname, join, sep }, { pathToFileURL }] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:url'),
  ]);
  let workspaceRoot = process.cwd();
  while (!existsSync(join(workspaceRoot, 'packages/db/migrations'))) {
    const parent = dirname(workspaceRoot);
    if (parent === workspaceRoot) throw new Error('The real packages/db/migrations directory was not found.');
    workspaceRoot = parent;
  }
  const directory = pathToFileURL(`${join(workspaceRoot, 'packages/db/migrations')}${sep}`);
  return { ...original, discoverMigrations: (explicitDirectory: URL = directory) => original.discoverMigrations(explicitDirectory) };
});

const storeId = DEMO_IDS.storeDoksan;
const endpoint = `/api/v2/oda/${storeId}/hr`;
const storePoint = { latitude: 37.467, longitude: 126.897 };
const employeeName = '직원 홈 통합 직원';
type RequestRecord = { method: string; url: string; body: { type?: string; input?: Record<string, unknown>; expectedVersion?: number } | null; status: number };
let app: FastifyInstance;
let repository: ReturnType<typeof createDemoRepository>;
let container: HTMLDivElement;
let root: Root;
let data: ReturnType<typeof normalizeBootstrap>;
let notify: ReturnType<typeof vi.fn>;
let requests: RequestRecord[];
let employeeId: string;
let initialVersion: number;
let point: typeof storePoint & { accuracy: number };
let locate: ReturnType<typeof vi.fn>;
let previousGeolocation: PropertyDescriptor | undefined;

async function readAs(actorId: string = DEMO_IDS.staff): Promise<HrResponse> {
  const response = await app.inject({ method: 'GET', url: endpoint, headers: { 'x-demo-actor-id': actorId } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<HrResponse>();
}
async function adminCommand(type: string, input: Record<string, unknown>): Promise<HrResponse> {
  const current = await readAs(DEMO_IDS.owner);
  const response = await app.inject({ method: 'POST', url: `${endpoint}/commands`,
    headers: { 'x-demo-actor-id': DEMO_IDS.owner, 'idempotency-key': randomUUID() },
    payload: { type, input, expectedVersion: current.workspace.version } });
  expect(response.statusCode, `${type}: ${response.body}`).toBe(200);
  return response.json<HrResponse>();
}
async function stored(): Promise<HrWorkspace> {
  const value = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`);
  expect(value).toBeDefined(); return value!;
}
function clockRequests() { return requests.filter(row => row.method === 'POST' && row.body?.type?.startsWith('clock.')); }
function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(row => {
    const visible = row.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    return visible.textContent?.replace(/\s+/g, ' ').trim() === label;
  });
}
async function eventually(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    check();
  }, { timeout: 5000, interval: 15 });
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button: ${label}`).toBeTruthy();
  expect(target!.disabled, `enabled button: ${label}`).toBe(false);
  await act(async () => target!.click());
}
async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(<OdaStaffPage data={data} notify={notify} />); });
  await eventually(() => expect(button('출근하기') ?? button('퇴근하기')).toBeDefined());
}

beforeEach(async () => {
  repository = createDemoRepository();
  app = await buildApp({ repository, env: { APP_MODE: 'test', WORKSTATION_BRAND: 'oda', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
  const created = await adminCommand('employee.create', {
    employeeNumber: 'STAFF-INTEGRATION', name: employeeName, hireDate: '2025-01-01', actorId: DEMO_IDS.staff, basePay: 3100000,
  });
  employeeId = created.workspace.employees[0]!.id;
  await adminCommand('attendance.location.set', { address: '서울특별시 금천구 독산로 100', ...storePoint });
  const templates = await adminCommand('shift.template.create', { name: '매장 주간 근무', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work' });
  const shifts = await adminCommand('shift.save', { employeeId, date: hrToday(), templateId: templates.workspace.attendance.shiftTemplates[0]!.id });
  const shift = shifts.workspace.attendance.shifts[0]!;
  await adminCommand('shift.publish', { ids: [shift.id], revisions: { [shift.id]: shift.revision } });
  const seeded = await adminCommand('notice.create', { title: '오늘 매장 운영 안내', body: '마감 전에 정리 상태를 함께 확인해 주세요.', status: 'published', pinned: true });
  initialVersion = seeded.workspace.version;
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers: { 'x-demo-actor-id': DEMO_IDS.staff } });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  data = normalizeBootstrap(bootstrap.json());
  expect(data.actor.id).toBe(DEMO_IDS.staff);
  expect(data.store.id).toBe(storeId);
  requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://staff-integration.test');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await app.inject({ method: method as 'GET' | 'POST', url: `${url.pathname}${url.search}`,
      headers: { ...headers, 'x-demo-actor-id': DEMO_IDS.staff }, ...(init?.body ? { payload: String(init.body) } : {}) });
    requests.push({ method, url: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null, status: response.statusCode });
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': String(response.headers['content-type'] ?? 'application/json') } });
  });
  point = { ...storePoint, accuracy: 8 };
  locate = vi.fn((success: PositionCallback, _error?: PositionErrorCallback | null, _options?: PositionOptions) => success({
    coords: { ...point, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now(),
  } as GeolocationPosition));
  previousGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: locate } });
  vi.stubGlobal('isSecureContext', true);
  notify = vi.fn();
  window.history.replaceState({}, '', `/store/oda-staff?store=${storeId}`);
  container = document.createElement('div'); document.body.append(container);
  await mount();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  if (app) await app.close();
  if (previousGeolocation) Object.defineProperty(navigator, 'geolocation', previousGeolocation);
  else Reflect.deleteProperty(navigator, 'geolocation');
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('OdaStaffPage through the real in-process HR API', () => {
  it('shows a staff-linked employee, published schedule and notice without clocking in when the home opens', async () => {
    await eventually(() => {
      expect(container.textContent).toContain(employeeName);
      expect(container.textContent).toContain('오늘 매장 운영 안내');
      expect(container.textContent).toContain('09:00');
      expect(container.textContent).toContain('18:00');
    });
    const notice = container.querySelector<HTMLButtonElement>('.staff-notices button');
    expect(notice?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => notice!.click());
    expect(container.querySelector('.staff-notice-body')?.textContent).toBe('마감 전에 정리 상태를 함께 확인해 주세요.');
    expect(requests.some(row => row.method === 'GET' && row.url === endpoint)).toBe(true);
    expect(requests.filter(row => row.method === 'POST')).toEqual([]);
    const saved = await stored();
    expect(saved.version).toBe(initialVersion);
    expect(saved.attendance.clockEvents).toEqual([]);
    expect((await readAs()).storeSchedule).toMatchObject([{ employeeId, employeeName, date: hrToday(), startTime: '09:00', endTime: '18:00' }]);
  });

  it('checks fresh native GPS on click, persists sanitized clock events and restores clocked-in state after remount', async () => {
    await eventually(() => expect(button('출근하기')?.disabled).toBe(false));
    const beforeClockGpsCalls = locate.mock.calls.length;
    expect(clockRequests()).toEqual([]);
    await click('출근하기');
    await eventually(() => expect(button('퇴근하기')?.disabled).toBe(false));
    expect(locate.mock.calls.length).toBeGreaterThan(beforeClockGpsCalls);
    expect(locate.mock.calls.at(-1)?.[2]).toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    const clockIn = await stored();
    expect(clockIn.version).toBe(initialVersion + 1);
    expect(clockIn.attendance.clockEvents).toHaveLength(1);
    expect(clockIn.attendance.clockEvents[0]).toMatchObject({ employeeId, actorId: DEMO_IDS.staff, kind: 'in', location: { distanceMeters: 0, accuracyMeters: 8, radiusMeters: 200 } });
    expect(Object.keys(clockIn.attendance.clockEvents[0]!.location!).sort()).toEqual(['accuracyMeters', 'distanceMeters', 'locationUpdatedAt', 'radiusMeters', 'verifiedAt']);
    expect(JSON.stringify(clockIn.attendance.clockEvents)).not.toMatch(/latitude|longitude|timestamp/);
    expect(clockRequests()).toMatchObject([{ status: 200, body: { type: 'clock.in', expectedVersion: initialVersion, input: { employeeId, location: { ...storePoint, accuracy: 8 } } } }]);

    await act(async () => root.unmount()); await mount();
    await eventually(() => expect(button('퇴근하기')?.disabled).toBe(false));
    expect(button('출근하기')).toBeUndefined();
    expect(clockRequests()).toHaveLength(1);
    const beforeClockOutGpsCalls = locate.mock.calls.length;
    await click('퇴근하기');
    await eventually(() => expect(button('출근하기')?.disabled).toBe(false));
    expect(locate.mock.calls.length).toBeGreaterThan(beforeClockOutGpsCalls);
    const clockOut = await stored();
    expect(clockOut.version).toBe(initialVersion + 2);
    expect(clockOut.attendance.clockEvents.map(row => row.kind)).toEqual(['in', 'out']);
    expect(JSON.stringify(clockOut.attendance.clockEvents)).not.toMatch(/latitude|longitude|timestamp/);
    expect(clockRequests().map(row => row.body?.type)).toEqual(['clock.in', 'clock.out']);
    expect(clockRequests().every(row => row.status === 200)).toBe(true);
    expect((await readAs()).workspace.attendance.clockEvents).toEqual(clockOut.attendance.clockEvents);
  });

  it('rejects a fresh outside or invalid location without a clock POST or a stored version change', async () => {
    await eventually(() => expect(button('출근하기')?.disabled).toBe(false));
    point = { ...storePoint, latitude: storePoint.latitude + 0.01, accuracy: 8 };
    const beforeOutsideGpsCalls = locate.mock.calls.length;
    await click('출근하기');
    await eventually(() => {
      expect(locate.mock.calls.length).toBeGreaterThan(beforeOutsideGpsCalls);
      expect(container.querySelector('.staff-clock-error')?.textContent).toContain('매장 근처에서 확인해 주세요');
      expect(button('출근하기')?.disabled).toBe(false);
    });
    expect(clockRequests()).toEqual([]);
    expect((await stored()).version).toBe(initialVersion);

    point = { ...storePoint, accuracy: 8 };
    await click('위치 다시 확인');
    await eventually(() => expect(button('출근하기')?.disabled).toBe(false));
    point = { ...storePoint, latitude: 91, accuracy: 8 };
    await click('출근하기');
    await eventually(() => {
      expect(container.querySelector('.staff-clock-error')?.textContent).toContain('올바른 위치 정보를 받지 못했습니다');
      expect(button('출근하기')?.disabled).toBe(false);
    });
    expect(clockRequests()).toEqual([]);
    const saved = await stored();
    expect(saved.version).toBe(initialVersion);
    expect(saved.attendance.clockEvents).toEqual([]);
  });
});
