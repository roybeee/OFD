import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import type { HrResponse, HrWorkspace } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../api/src/app';
import { normalizeBootstrap } from '../api/client';
import { OdaHrPage } from './OdaHrPage';

// Real React panels, API client, Fastify routes, domain commands and repository.
// fetch is redirected to app.inject; no sockets or fixture DTOs. API source is
// imported directly so this test never depends on an apps/api/dist build.
// Vite gives migration-runner a browser import.meta.url in JSDOM. Adapt only its
// default directory; the real discovery function still reads/checksums every SQL file.
const migrationRead = vi.hoisted(() => ({ calls: 0, sqlFiles: 0, directory: '' }));
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
  return { ...original, discoverMigrations: async (explicitDirectory: URL = directory) => {
    const migrations = await original.discoverMigrations(explicitDirectory);
    migrationRead.calls += 1;
    migrationRead.sqlFiles = migrations.filter(row => row.sql.trim().length > 0 && /^[a-f0-9]{64}$/.test(row.checksumSha256)).length;
    migrationRead.directory = explicitDirectory.href;
    return migrations;
  } };
});
const storeId = DEMO_IDS.storeDoksan;
const endpoint = `/api/v2/oda/${storeId}/hr`;
let app: FastifyInstance;
let repository: ReturnType<typeof createDemoRepository>;
let container: HTMLDivElement;
let root: Root;
let requests: Array<{ method: string; url: string; body: unknown; status: number }>;
let data: ReturnType<typeof normalizeBootstrap>;
let notify: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  migrationRead.calls = 0; migrationRead.sqlFiles = 0;
  repository = createDemoRepository();
  app = await buildApp({ repository, env: { APP_MODE: 'test', WORKSTATION_BRAND: 'oda', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
  expect(migrationRead.calls).toBe(1);
  expect(migrationRead.sqlFiles).toBeGreaterThan(0);
  expect(migrationRead.directory).toMatch(/^file:.*\/packages\/db\/migrations\/$/);
  requests = [];
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers: { 'x-demo-actor-id': DEMO_IDS.owner } });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  data = normalizeBootstrap(bootstrap.json());
  expect(data.actor.id).toBe(DEMO_IDS.owner);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://hr-integration.test');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await app.inject({ method: method as 'GET' | 'POST', url: `${url.pathname}${url.search}`,
      headers: { ...headers, 'x-demo-actor-id': DEMO_IDS.owner }, ...(init?.body ? { payload: String(init.body) } : {}) });
    requests.push({ method, url: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null, status: response.statusCode });
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': String(response.headers['content-type'] ?? 'application/json') } });
  });
  notify = vi.fn();
  window.history.replaceState({}, '', `/store/oda-hr?store=${storeId}&tab=people`);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<OdaHrPage data={data} notify={notify} />); });
  await eventually(() => expect(container.textContent).toContain('등록된 직원이 없습니다'));
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  if (app) await app.close();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

async function eventually(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    check();
  }, { timeout: 5000, interval: 15 });
}
async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.replace(/\s+/g, ' ').trim() === label);
  expect(button, `button: ${label}`).toBeTruthy();
  expect(button!.disabled, `enabled button: ${label}`).toBe(false);
  await act(async () => button!.click());
}
function dialog(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[role="dialog"]');
  expect(element, 'dialog').toBeTruthy(); return element!;
}
async function fill(name: string, value: string, scope: ParentNode = dialog()) {
  const field = scope.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
  expect(field, `field: ${name}`).toBeTruthy();
  const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true })); field!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function registerEmployee(number: string, name: string, actorId: string) {
  await click('직원 등록');
  await fill('name', name); await fill('employeeNumber', number); await fill('hireDate', '2025-01-01');
  await fill('basePay', '3100000'); await fill('actorId', actorId);
  await click('직원 등록', dialog());
  await eventually(() => {
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('tbody')?.textContent).toContain(name);
  });
}
async function responseFor(actorId: string = DEMO_IDS.owner): Promise<HrResponse> {
  const response = await app.inject({ method: 'GET', url: endpoint, headers: { 'x-demo-actor-id': actorId } });
  expect(response.statusCode, response.body).toBe(200); return response.json<HrResponse>();
}
async function refresh() {
  const readCount = requests.filter(row => row.method === 'GET').length;
  await click('새로고침');
  await eventually(() => {
    expect(requests.filter(row => row.method === 'GET').length).toBeGreaterThan(readCount);
    expect(container.querySelector('.hr-loading')).toBeNull();
  });
}
async function remount() {
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => { root.render(<OdaHrPage data={data} notify={notify} />); });
  await eventually(() => {
    expect(container.querySelector('.hr-content')).not.toBeNull();
    expect(container.querySelector('.hr-loading')).toBeNull();
  });
}

describe('OdaHrPage through the real in-process HR API', () => {
  it('registers a linked employee, persists refresh, creates an organization and saves an assignment through the real forms', async () => {
    await registerEmployee('INTEGRATION-01', '화면 등록 직원', DEMO_IDS.owner);
    let saved = await responseFor();
    expect(saved.workspace.version).toBe(1);
    expect(saved.employeeId).toBe(saved.workspace.employees[0]!.id);
    expect(saved.workspace.employees[0]).toMatchObject({ name: '화면 등록 직원', employeeNumber: 'INTEGRATION-01', basePay: 3100000, actorId: DEMO_IDS.owner });
    await refresh(); expect(container.querySelector('tbody')?.textContent).toContain('화면 등록 직원');
    await click('조직도'); await click('조직 추가'); await fill('name', '운영지원팀');
    await fill('leaderId', saved.employeeId!); await click('저장', dialog());
    await eventually(() => { expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.querySelector('.hr-org-row')?.textContent).toContain('운영지원팀'); });
    saved = await responseFor(); const department = saved.workspace.departments[0]!;
    expect(department.leaderId).toBe(saved.employeeId);
    await click('직원 목록'); await click('상세 보기'); await click('정보 수정', dialog());
    await fill('departmentId', department.id); await fill('jobTitle', '운영 담당'); await fill('reason', '조직 구성 후 소속 지정');
    await click('변경 저장', dialog());
    await eventually(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    await refresh();
    expect(container.querySelector('tbody')?.textContent).toContain('운영지원팀');
    expect(container.querySelector('tbody')?.textContent).toContain('운영 담당');
    const stored = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`);
    expect(stored?.employees[0]).toMatchObject({ departmentId: department.id, jobTitle: '운영 담당' });
    expect(stored?.employees[0]?.history.at(-1)?.reason).toBe('조직 구성 후 소속 지정');
    expect(requests.filter(row => row.method === 'POST').map(row => row.body)).toMatchObject([
      { type: 'employee.create', expectedVersion: 0 }, { type: 'department.upsert', expectedVersion: 1 }, { type: 'employee.update', expectedVersion: 2 },
    ]);
    expect(requests.every(row => row.status === 200)).toBe(true);
  });

  it('creates a meeting from linked people and persists shared/private notes while filtering another participant and a top administrator', async () => {
    await registerEmployee('MEETING-HOST', '미팅 주최자', DEMO_IDS.owner);
    await registerEmployee('MEETING-GUEST', '미팅 참여자', DEMO_IDS.staff);
    const people = (await responseFor()).workspace.employees;
    const guest = people.find(row => row.actorId === DEMO_IDS.staff)!;
    await click('미팅'); await click('미팅 추가'); await fill('title', '실제 저장 확인 미팅');
    const checkbox = dialog().querySelector<HTMLInputElement>(`input[name="participantEmployeeIds"][value="${guest.id}"]`)!;
    expect(checkbox).toBeTruthy(); await act(async () => checkbox.click());
    await click('작성 완료', dialog());
    await eventually(() => { expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).toContain('실제 저장 확인 미팅'); });
    await click('노트 열기');
    const notesPanel = container.querySelector<HTMLElement>('[aria-label="실제 저장 확인 미팅 노트"]')!;
    await fill('notes', '다음 주 준비 자료를 공동으로 확인합니다.', notesPanel); await click('공동 노트 저장', notesPanel);
    await eventually(() => expect(requests.some(row => row.method === 'POST' && (row.body as { type: string }).type === 'meeting.update' && row.status === 200)).toBe(true));
    await fill('note', '주최자만 보는 면담 메모', notesPanel); await click('개인 메모 저장', notesPanel);
    await eventually(() => expect(requests.some(row => row.method === 'POST' && (row.body as { type: string }).type === 'meeting.privateNote' && row.status === 200)).toBe(true));
    await remount(); await click('노트 열기');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')?.value).toBe('다음 주 준비 자료를 공동으로 확인합니다.');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[name="note"]')?.value).toBe('주최자만 보는 면담 메모');
    const guestRead = await responseFor(DEMO_IDS.staff);
    expect(guestRead.workspace.talent.meetings[0]?.notes).toBe('다음 주 준비 자료를 공동으로 확인합니다.');
    expect(guestRead.workspace.talent.meetings[0]?.privateNotes).toEqual({});
    expect(JSON.stringify(guestRead)).not.toContain('주최자만 보는 면담 메모');
    const masterRead = await responseFor(DEMO_IDS.master);
    expect(masterRead.workspace.talent.meetings).toEqual([]);
    expect(JSON.stringify(masterRead)).not.toContain('주최자만 보는 면담 메모');
    const stored = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`);
    expect(stored?.talent.meetings[0]?.privateNotes[DEMO_IDS.owner]).toBe('주최자만 보는 면담 메모');
    expect(stored?.talent.meetings[0]?.participantEmployeeIds).toHaveLength(2);
    expect(requests.every(row => row.status === 200)).toBe(true);
  });

  it('keeps duplicate employee input open after the actual API rejects it and does not claim another save', async () => {
    await registerEmployee('DUPLICATE', '기존 직원', DEMO_IDS.owner);
    expect(notify).toHaveBeenCalledTimes(1);
    await click('직원 등록'); await fill('name', '저장되면 안 되는 직원'); await fill('employeeNumber', 'DUPLICATE');
    await fill('hireDate', '2025-01-01'); await fill('basePay', '3200000'); await click('직원 등록', dialog());
    await eventually(() => expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('이미 사용 중인 사번'));
    expect(dialog().querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('저장되면 안 되는 직원');
    expect(notify).toHaveBeenCalledTimes(1);
    const saved = await responseFor(); expect(saved.workspace.employees).toHaveLength(1); expect(saved.workspace.version).toBe(1);
    expect(requests.at(-1)?.status).toBe(409);
  });
});
