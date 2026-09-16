import { randomUUID } from 'node:crypto';
import { createDemoRepository, DEMO_IDS, type StateRepository } from '@ofd/db';
import { ACCESS_PAGES, HR_COMMAND_ACCESS, type Actor, type HrResponse, type HrWorkspace, type Store } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${storeId}/hr`;
const headers = (actorId: string) => ({ 'x-demo-actor-id': actorId });
async function setup() {
  const repository = createDemoRepository();
  const app = await buildApp({ repository, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
  apps.push(app); return { app, repository };
}
async function read(app: FastifyInstance, actorId: string = DEMO_IDS.owner) {
  return app.inject({ method: 'GET', url: base, headers: headers(actorId) });
}
async function command(app: FastifyInstance, type: string, input: Record<string, unknown>, version: number, actorId: string = DEMO_IDS.owner, key = randomUUID()) {
  return app.inject({ method: 'POST', url: `${base}/commands`, headers: { ...headers(actorId), 'idempotency-key': key }, payload: { type, input, expectedVersion: version } });
}
async function employee(app: FastifyInstance, version: number, number: string, actorId?: string) {
  const result = await command(app, 'employee.create', { employeeNumber: number, name: `직원${number}`, hireDate: '2026-01-01', basePay: 3210000, email: `${number}@example.test`, phone: '010-9999-1111', ...(actorId ? { actorId } : {}) }, version);
  expect(result.statusCode, result.body).toBe(200); return result.json<HrResponse>();
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('ODA HR API persistence, isolation and commands', () => {
  it('gates every registered command before object lookup for staff, unlinked finance and auditors', async () => {
    const { app } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    for (const [type, permission] of Object.entries(HR_COMMAND_ACCESS)) {
      expect((await command(app, type, {}, 1, DEMO_IDS.auditor)).statusCode, `auditor ${type}`).toBe(403);
      if (['manager', 'payroll', 'finance'].includes(permission)) expect((await command(app, type, {}, 1, DEMO_IDS.staff)).statusCode, `staff ${type}`).toBe(403);
      if (['manager', 'member', 'self'].includes(permission)) expect((await command(app, type, {}, 1, DEMO_IDS.finance)).statusCode, `finance ${type}`).toBe(403);
    }
    expect((await read(app)).json().workspace.version).toBe(1);
  });

  it('allows an unlinked manager as template creator and rejects an inactive approver before submission commits', async () => {
    const { app, repository } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const template = await command(app, 'workflow.template.save', { title: '본사 승인', category: '일반', steps: [{ approverIds: [DEMO_IDS.master], mode: 'all' }] }, 1, DEMO_IDS.master);
    expect(template.statusCode, template.body).toBe(200); const templateId = template.json().workspace.workflow.templates[0].id;
    const draft = await command(app, 'workflow.create', { templateId, title: '개인 초안', body: '제출 전 내용', amount: 0 }, 2, DEMO_IDS.staff);
    expect(draft.statusCode, draft.body).toBe(200); const id = draft.json().workspace.workflow.requests[0].id;
    expect((await read(app, DEMO_IDS.master)).body).not.toContain('제출 전 내용');
    const master = (await repository.get<Actor>('actor', DEMO_IDS.master))!;
    await repository.commit({ changes: [{ type: 'actor', id: master.id, expectedVersion: 1, value: { ...master, active: false } }] });
    const denied = await command(app, 'workflow.submit', { id }, 3, DEMO_IDS.staff);
    expect(denied.statusCode, denied.body).toBe(422); expect(denied.json().error.code).toBe('HR_APPROVER_UNAVAILABLE');
    expect((await read(app, DEMO_IDS.staff)).json().workspace.workflow.requests[0].status).toBe('draft');
  });
  it('returns an empty virtual workspace without writing and scopes account choices', async () => {
    const { app, repository } = await setup();
    const result = await read(app); expect(result.statusCode).toBe(200);
    expect(result.json().workspace).toMatchObject({ version: 0, storeId, employees: [] });
    expect(await repository.get('oda_hr', `hr:${storeId}`)).toBeUndefined();
    expect(result.json().accounts.map((row: Actor) => row.id).sort()).toEqual([DEMO_IDS.owner, DEMO_IDS.staff].sort());
    const master = (await read(app, DEMO_IDS.master)).json<HrResponse>();
    expect(master.accounts?.some(row => row.id === DEMO_IDS.master)).toBe(true);
    expect((await read(app, DEMO_IDS.staff)).json().accounts).toBeUndefined();
  });

  it('does not link unsupported or auditor accounts and strips self access after an employee becomes auditor', async () => {
    const { app, repository } = await setup();
    const auditor = (await repository.get<Actor>('actor', DEMO_IDS.auditor))!;
    await repository.commit({ changes: [{ type: 'actor', id: auditor.id, expectedVersion: 1, value: { ...auditor, storeIds: [storeId] } }] });
    expect((await read(app)).json().accounts.some((actor: Actor) => actor.id === auditor.id)).toBe(false);
    const denied = await command(app, 'employee.create', { employeeNumber: 'NO', name: '감사 연결', hireDate: '2026-01-01', actorId: auditor.id }, 0);
    expect(denied.statusCode).toBe(422); expect(denied.json().error.code).toBe('HR_ACTOR_SCOPE');
    await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const staff = (await repository.get<Actor>('actor', DEMO_IDS.staff))!;
    await repository.commit({ changes: [{ type: 'actor', id: staff.id, expectedVersion: 1, value: { ...staff, role: 'auditor', authVersion: 2 } }] });
    const response = (await read(app, staff.id)).json<HrResponse>();
    expect(response.employeeId).toBeUndefined(); expect(response.permissions).toEqual({ manage: false, payroll: false, self: false });
    expect(response.workspace.employees[0]?.basePay).toBe(0); expect(response.workspace.employees[0]?.email).toBeUndefined();
  });

  it('enforces store and page scope before reading or mutating HR', async () => {
    const { app, repository } = await setup();
    expect((await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/hr`, headers: headers(DEMO_IDS.owner) })).statusCode).toBe(403);
    for (const id of [DEMO_IDS.ops, DEMO_IDS.driver]) expect((await read(app, id)).statusCode).toBe(403);
    const finance = (await repository.get<Actor>('actor', DEMO_IDS.finance))!;
    await repository.commit({ changes: [{ type: 'actor', id: finance.id, expectedVersion: 1, value: { ...finance, storeIds: [DEMO_IDS.storeHapjeong] } }] });
    expect((await read(app, finance.id)).statusCode).toBe(403);
    await repository.commit({ changes: [{ type: 'access_policy', id: 'access-policy', storeId: '__system__', expectedVersion: null, value: {
      id: 'access-policy', version: 1, rolePages: {}, actorPages: { [DEMO_IDS.owner]: [] }, knownPaths: ACCESS_PAGES.map(row => row.path),
    } }] });
    expect((await read(app)).statusCode).toBe(403);
    expect(await repository.get('oda_hr', `hr:${storeId}`)).toBeUndefined();
  });

  it('requires a retry key, writes once, rejects changed retries, and resolves concurrent writers', async () => {
    const { app, repository } = await setup();
    const payload = { expectedVersion: 0, type: 'workspace.initialize', input: {} };
    expect((await app.inject({ method: 'POST', url: `${base}/commands`, payload, headers: headers(DEMO_IDS.owner) })).statusCode).toBe(428);
    const key = randomUUID();
    const [first, collision] = await Promise.all([command(app, payload.type, {}, 0, DEMO_IDS.owner, key), command(app, 'settings.update', { companyName: '경합 요청' }, 0)]);
    expect([first.statusCode, collision.statusCode].sort()).toEqual([200, 409]);
    const current = (await read(app)).json<HrResponse>(); expect(current.workspace.version).toBe(1);
    // Retry whichever command won using a stable key in a fresh version.
    const replayKey = randomUUID();
    const saved = await command(app, 'settings.update', { companyName: '멱등 저장' }, 1, DEMO_IDS.owner, replayKey);
    expect(saved.statusCode).toBe(200);
    const replay = await command(app, 'settings.update', { companyName: '멱등 저장' }, 1, DEMO_IDS.owner, replayKey);
    expect(replay.statusCode).toBe(200); expect(replay.headers['idempotency-replayed']).toBe('true'); expect(replay.json().workspace.version).toBe(2);
    expect((await command(app, 'settings.update', { companyName: '다른 본문' }, 1, DEMO_IDS.owner, replayKey)).statusCode).toBe(409);
    expect((await repository.listAudit()).filter(row => row.aggregateType === 'oda_hr')).toHaveLength(2);
  });

  it('rolls back invalid links and duplicate employee numbers, and preserves audit privacy', async () => {
    const { app, repository } = await setup();
    const invalid = await command(app, 'employee.create', { employeeNumber: 'A', name: '민감 이름', hireDate: '2026-01-01', actorId: DEMO_IDS.finance }, 0);
    expect(invalid.statusCode).toBe(422); expect(await repository.get('oda_hr', `hr:${storeId}`)).toBeUndefined();
    await employee(app, 0, 'A', DEMO_IDS.staff);
    expect((await command(app, 'employee.create', { employeeNumber: 'A', name: '중복', hireDate: '2026-01-01' }, 1)).statusCode).toBe(409);
    expect((await command(app, 'employee.create', { employeeNumber: 'B', name: '중복 계정', hireDate: '2026-01-01', actorId: DEMO_IDS.staff }, 1)).statusCode).toBe(409);
    const audit = (await repository.listAudit()).filter(row => row.aggregateType === 'oda_hr');
    expect(audit).toHaveLength(1); const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('example.test'); expect(serialized).not.toContain('3210000'); expect(serialized).not.toContain('010-9999');
    expect((await read(app)).json().workspace.version).toBe(1);
  });

  it('validates organization references, prevents cycles and preserves occupied organizations', async () => {
    const { app } = await setup();
    let response = (await command(app, 'department.upsert', { name: '상위' }, 0)).json<HrResponse>();
    const parent = response.workspace.departments[0]!.id;
    response = (await command(app, 'department.upsert', { name: '하위', parentId: parent }, 1)).json<HrResponse>();
    const child = response.workspace.departments[1]!.id;
    expect((await command(app, 'department.upsert', { id: parent, name: '상위', parentId: child }, 2)).statusCode).toBe(422);
    expect((await command(app, 'department.archive', { id: parent }, 2)).statusCode).toBe(409);
    expect((await command(app, 'employee.create', { employeeNumber: 'C', name: '조직 오류', hireDate: '2026-02-30', departmentId: child }, 2)).statusCode).toBe(422);
    expect((await read(app)).json().workspace.version).toBe(2);
  });

  it('protects employee private data, restricts staff to their identity and keeps finance/auditors from HR edits', async () => {
    const { app } = await setup();
    const own = await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const ownId = own.workspace.employees[0]!.id;
    const all = await employee(app, 1, 'OTHER'); const otherId = all.workspace.employees[1]!.id;
    const staff = (await read(app, DEMO_IDS.staff)).json<HrResponse>();
    expect(staff.employeeId).toBe(ownId); expect(staff.permissions).toEqual({ manage: false, payroll: false, self: true });
    expect(staff.workspace.employees.find(row => row.id === ownId)?.basePay).toBe(3210000);
    const other = staff.workspace.employees.find(row => row.id === otherId)!;
    expect(other.basePay).toBe(0); expect(other.email).toBeUndefined(); expect(other.phone).toBeUndefined(); expect(other.history).toEqual([]);
    for (const id of [DEMO_IDS.staff, DEMO_IDS.finance, DEMO_IDS.auditor]) {
      expect((await command(app, 'employee.update', { id: ownId, reason: '권한 우회', changes: { basePay: 1 } }, 2, id)).statusCode).toBe(403);
    }
    expect((await read(app, DEMO_IDS.finance)).json().workspace.employees[0].basePay).toBe(3210000);
    expect((await read(app, DEMO_IDS.auditor)).json().workspace.employees[0].basePay).toBe(0);
  });

  it('persists a staff notice receipt from server identity, isolates it, and rejects stale revisions', async () => {
    const { app, repository } = await setup();
    const own = await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const published = await command(app, 'notice.create', { title: '운영 안내', body: '이번 주 운영 안내', status: 'published' }, 1);
    expect(published.statusCode, published.body).toBe(200);
    const notice = published.json<HrResponse>().workspace.notices[0]!;
    const input = { id: notice.id, updatedAt: notice.updatedAt };
    const forged = await command(app, 'notice.acknowledge', { ...input, actorId: DEMO_IDS.owner }, 2, DEMO_IDS.staff);
    expect(forged.statusCode).toBe(422);
    const key = randomUUID();
    const acknowledged = await command(app, 'notice.acknowledge', input, 2, DEMO_IDS.staff, key);
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    const receipt = acknowledged.json<HrResponse>().workspace.notices[0]!.receipts![0]!;
    expect(receipt).toMatchObject({ actorId: DEMO_IDS.staff, employeeId: own.workspace.employees[0]!.id, noticeUpdatedAt: notice.updatedAt });
    expect((await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!.notices[0]!.receipts).toEqual([receipt]);
    const replay = await command(app, 'notice.acknowledge', input, 2, DEMO_IDS.staff, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<HrResponse>().workspace.version).toBe(3);
    const managerConfirmed = await command(app, 'notice.acknowledge', input, 3);
    expect(managerConfirmed.statusCode, managerConfirmed.body).toBe(200);
    expect(managerConfirmed.json<HrResponse>().workspace.notices[0]!.receipts).toHaveLength(2);
    expect((await read(app, DEMO_IDS.staff)).json<HrResponse>().workspace.notices[0]!.receipts).toEqual([receipt]);
    expect((await read(app, DEMO_IDS.finance)).json<HrResponse>().workspace.notices[0]!.receipts).toEqual([]);
    const updated = await command(app, 'notice.update', { id: notice.id, title: notice.title, body: '변경된 운영 안내', status: 'published' }, 4);
    expect(updated.statusCode, updated.body).toBe(200);
    const changed = updated.json<HrResponse>().workspace.notices[0]!;
    expect(changed.updatedAt).not.toBe(notice.updatedAt);
    const stale = await command(app, 'notice.acknowledge', input, 5, DEMO_IDS.staff);
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('HR_NOTICE_CHANGED');
    expect((await read(app)).json<HrResponse>().workspace.version).toBe(5);
    const reconfirmed = await command(app, 'notice.acknowledge', { id: notice.id, updatedAt: changed.updatedAt }, 5, DEMO_IDS.staff);
    expect(reconfirmed.statusCode, reconfirmed.body).toBe(200);
    expect(reconfirmed.json<HrResponse>().workspace.notices[0]!.receipts).toHaveLength(1);
    const archived = await command(app, 'notice.archive', { id: notice.id }, 6);
    expect(archived.statusCode, archived.body).toBe(200);
    const unavailable = await command(app, 'notice.acknowledge', { id: notice.id, updatedAt: changed.updatedAt }, 7, DEMO_IDS.staff);
    expect(unavailable.statusCode).toBe(404); expect(unavailable.json().error.code).toBe('HR_NOTICE_NOT_FOUND');
  });

  it('publishes notices explicitly and limits personal documents to their employee', async () => {
    const { app } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const all = await employee(app, 1, 'OTHER'); const otherId = all.workspace.employees[1]!.id;
    const draft = await command(app, 'notice.create', { title: '임시 공지', body: '아직 공개 안 함', status: 'draft' }, 2);
    expect(draft.statusCode).toBe(200);
    await command(app, 'notice.create', { title: '공개 공지', body: '공개 내용', status: 'published' }, 3);
    await command(app, 'document.create', { title: '개인 계약', category: 'contract', employeeId: otherId, body: '기밀 본문' }, 4);
    await command(app, 'document.create', { title: '공통 정책', category: 'policy', body: '누구나 열람' }, 5);
    const staff = (await read(app, DEMO_IDS.staff)).json<HrResponse>();
    expect(staff.workspace.notices.map(row => row.title)).toEqual(['공개 공지']);
    expect(staff.workspace.documents.map(row => row.title)).toEqual(['공통 정책']);
    expect(JSON.stringify(staff)).not.toContain('기밀 본문');
  });

  it('never returns someone else’s private meeting note, including to a manager', async () => {
    const { app } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    const all = await employee(app, 1, 'MANAGER', DEMO_IDS.owner);
    const ids = all.workspace.employees.map(row => row.id);
    const meeting = await command(app, 'meeting.create', { title: '면담', participantEmployeeIds: ids, scheduledDate: '2026-09-16' }, 2);
    expect(meeting.statusCode, meeting.body).toBe(200); const id = meeting.json().workspace.talent.meetings[0].id;
    const saved = await command(app, 'meeting.privateNote', { id, note: '본인만 보는 개인 메모 7823' }, 3, DEMO_IDS.staff);
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.body).toContain('7823');
    expect((await read(app)).body).not.toContain('7823'); expect((await read(app, DEMO_IDS.master)).body).not.toContain('7823');
  });

  it('re-projects retry responses after a role downgrade without replaying a prior sensitive response', async () => {
    const { app, repository } = await setup();
    await employee(app, 0, 'SELF', DEMO_IDS.owner); await employee(app, 1, 'OTHER');
    const key = randomUUID(); const input = { companyName: '권한 변경 전 저장' };
    expect((await command(app, 'settings.update', input, 2, DEMO_IDS.owner, key)).statusCode).toBe(200);
    const actor = (await repository.get<Actor>('actor', DEMO_IDS.owner))!;
    await repository.commit({ changes: [{ type: 'actor', id: actor.id, expectedVersion: 1, value: { ...actor, role: 'store_staff', authVersion: 2 } }] });
    const retried = await command(app, 'settings.update', input, 2, DEMO_IDS.owner, key);
    expect(retried.statusCode, retried.body).toBe(200); expect(retried.headers['idempotency-replayed']).toBe('true');
    expect(retried.json().permissions.manage).toBe(false); expect(retried.json().accounts).toBeUndefined();
    expect(retried.json().workspace.employees[1].email).toBeUndefined(); expect(retried.json().workspace.employees[1].basePay).toBe(0);
    const cache = await repository.getIdempotency(actor.id, key); expect(cache?.response).toEqual({ version: 3 });
  });
});

describe('ODA HR location attendance and published store schedule', () => {
  const clockLocation = { address: '서울 금천구 매장 도로명주소', latitude: 37.47, longitude: 126.9 };
  const position = (changes: Record<string, unknown> = {}) => ({ latitude: clockLocation.latitude,
    longitude: clockLocation.longitude, accuracy: 8, timestamp: Date.now(), ...changes });

  it('returns only the scoped store address on GET and POST, preferring its road address', async () => {
    const { app, repository } = await setup();
    const first = (await repository.get<Store>('store', storeId))!;
    const second = (await repository.get<Store>('store', DEMO_IDS.storeHapjeong))!;
    await repository.commit({ changes: [
      { type: 'store', id: first.id, expectedVersion: first.version, value: { ...first, version: first.version + 1, roadAddress: '독산 도로명주소', business: { ...first.business, address: '독산 사업자주소' } } },
      { type: 'store', id: second.id, expectedVersion: second.version, value: { ...second, version: second.version + 1, roadAddress: '', business: { ...second.business, address: '합정 사업자주소' } } },
    ] });
    expect((await read(app, DEMO_IDS.staff)).json().storeAddress).toBe('독산 도로명주소');
    const saved = await command(app, 'settings.update', { companyName: '독산 인사' }, 0);
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().storeAddress).toBe('독산 도로명주소');
    const secondBase = `/api/v2/oda/${second.id}/hr`;
    const other = await app.inject({ method: 'GET', url: secondBase, headers: headers(DEMO_IDS.master) });
    expect(other.statusCode).toBe(200); expect(other.json().storeAddress).toBe('합정 사업자주소');
    const otherSaved = await app.inject({ method: 'POST', url: `${secondBase}/commands`,
      headers: { ...headers(DEMO_IDS.master), 'idempotency-key': randomUUID() },
      payload: { type: 'workspace.initialize', expectedVersion: 0, input: {} } });
    expect(otherSaved.statusCode, otherSaved.body).toBe(200); expect(otherSaved.json().storeAddress).toBe('합정 사업자주소');
    const forbidden = await app.inject({ method: 'GET', url: secondBase, headers: headers(DEMO_IDS.staff) });
    expect(forbidden.statusCode).toBe(403); expect(forbidden.body).not.toContain('합정 사업자주소');
  });

  it('allows only managers to set a fixed 200 m location and rejects client radius or malformed coordinates atomically', async () => {
    const { app, repository } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    for (const actorId of [DEMO_IDS.staff, DEMO_IDS.finance, DEMO_IDS.auditor]) {
      const denied = await command(app, 'attendance.location.set', clockLocation, 1, actorId);
      expect(denied.statusCode, denied.body).toBe(403);
    }
    const before = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`);
    for (const input of [{ ...clockLocation, radiusMeters: 99999 }, { ...clockLocation, latitude: 91 },
      { ...clockLocation, longitude: '126.9' }, { ...clockLocation, address: ' ' }]) {
      const invalid = await command(app, 'attendance.location.set', input, 1);
      expect(invalid.statusCode, invalid.body).toBe(422); expect(invalid.json().error.code).toBe('HR_CLOCK_LOCATION_INVALID');
      expect(await repository.get('oda_hr', `hr:${storeId}`)).toEqual(before);
    }
    expect((await command(app, 'settings.update', { clockLocation }, 1)).statusCode).toBe(422);
    const saved = await command(app, 'attendance.location.set', clockLocation, 1);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().workspace.settings.clockLocation).toEqual({ ...clockLocation, radiusMeters: 200,
      updatedAt: expect.any(String), updatedBy: DEMO_IDS.owner });
    expect((await read(app, DEMO_IDS.staff)).json().workspace.settings.clockLocation.radiusMeters).toBe(200);
    const outsideStore = await app.inject({ method: 'POST', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/hr/commands`,
      headers: { ...headers(DEMO_IDS.owner), 'idempotency-key': randomUUID() },
      payload: { type: 'attendance.location.set', input: clockLocation, expectedVersion: 0 } });
    expect(outsideStore.statusCode).toBe(403); expect(await repository.get('oda_hr', `hr:${DEMO_IDS.storeHapjeong}`)).toBeUndefined();
    const audit = (await repository.listAudit()).filter(row => row.aggregateType === 'oda_hr');
    expect(audit).toHaveLength(2); expect(JSON.stringify(audit)).not.toContain(clockLocation.address);
  });

  it('rejects unavailable, stale, inaccurate and out-of-range positions without a clock, version or audit change', async () => {
    const { app, repository } = await setup();
    const employeeId = (await employee(app, 0, 'SELF', DEMO_IDS.staff)).workspace.employees[0]!.id;
    const unconfigured = await command(app, 'clock.in', { employeeId, location: position() }, 1, DEMO_IDS.staff);
    expect(unconfigured.statusCode).toBe(409); expect(unconfigured.json().error.code).toBe('HR_CLOCK_LOCATION_NOT_CONFIGURED');
    expect((await command(app, 'attendance.location.set', clockLocation, 1)).statusCode).toBe(200);
    const failures: Array<[string, () => Record<string, unknown>]> = [
      ['HR_CLOCK_LOCATION_REQUIRED', () => ({})],
      ['HR_CLOCK_LOCATION_INVALID', () => ({ location: position({ latitude: 91 }) })],
      ['HR_CLOCK_LOCATION_INVALID', () => ({ location: position({ timestamp: 'today' }) })],
      ['HR_CLOCK_LOCATION_INVALID', () => ({ location: position({ radiusMeters: 99999 }) })],
      ['HR_CLOCK_LOCATION_STALE', () => ({ location: position({ timestamp: Date.now() - 61000 }) })],
      ['HR_CLOCK_LOCATION_STALE', () => ({ location: position({ timestamp: Date.now() + 11000 }) })],
      ['HR_CLOCK_LOCATION_ACCURACY', () => ({ location: position({ accuracy: 51 }) })],
      ['HR_CLOCK_LOCATION_OUTSIDE', () => ({ location: position({ latitude: clockLocation.latitude + 0.01 }) })],
      // The entire accuracy circle must fit within 200 m, even when the point itself is inside.
      ['HR_CLOCK_LOCATION_OUTSIDE', () => ({ location: position({ latitude: clockLocation.latitude + 0.0017, accuracy: 20 }) })],
    ];
    for (const [type, version] of [['clock.in', 2], ['clock.out', 3]] as const) {
      const before = await repository.get('oda_hr', `hr:${storeId}`);
      const auditBefore = await repository.listAudit();
      for (const [code, input] of failures) {
        const failed = await command(app, type, { employeeId, ...input() }, version, DEMO_IDS.staff);
        expect(failed.statusCode, `${type}: ${failed.body}`).toBe(422); expect(failed.json().error.code).toBe(code);
        expect(await repository.get('oda_hr', `hr:${storeId}`)).toEqual(before);
        expect(await repository.listAudit()).toEqual(auditBefore);
      }
      if (type === 'clock.in') {
        const accepted = await command(app, type, { employeeId, location: position() }, version, DEMO_IDS.staff);
        expect(accepted.statusCode, accepted.body).toBe(200);
      }
    }
  });

  it('keeps only server verification evidence on raw clocks and checks against the requested store location', async () => {
    const { app, repository } = await setup();
    const initial = await employee(app, 0, 'SELF', DEMO_IDS.staff); const employeeId = initial.workspace.employees[0]!.id;
    expect((await command(app, 'attendance.location.set', clockLocation, 1)).statusCode).toBe(200);
    const otherBase = `/api/v2/oda/${DEMO_IDS.storeHapjeong}/hr/commands`;
    const otherPoint = { address: '합정 출퇴근 위치', latitude: 37.55, longitude: 126.91 };
    expect((await app.inject({ method: 'POST', url: otherBase,
      headers: { ...headers(DEMO_IDS.master), 'idempotency-key': randomUUID() },
      payload: { type: 'attendance.location.set', input: otherPoint, expectedVersion: 0 } })).statusCode).toBe(200);
    const otherStorePosition = await command(app, 'clock.in', { employeeId,
      location: position({ latitude: otherPoint.latitude, longitude: otherPoint.longitude }) }, 2, DEMO_IDS.staff);
    expect(otherStorePosition.json().error.code).toBe('HR_CLOCK_LOCATION_OUTSIDE');
    const key = randomUUID();
    const clockIn = await command(app, 'clock.in', { employeeId, location: position(), at: '2099-01-01T00:00:00Z' }, 2, DEMO_IDS.staff, key);
    expect(clockIn.statusCode, clockIn.body).toBe(200);
    const clockOut = await command(app, 'clock.out', { employeeId, location: position() }, 3, DEMO_IDS.staff);
    expect(clockOut.statusCode, clockOut.body).toBe(200);
    const stored = (await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!;
    expect(stored.attendance.clockEvents.map(row => row.kind)).toEqual(['in', 'out']);
    for (const row of stored.attendance.clockEvents) {
      expect(row.at).not.toContain('2099');
      expect(row.location).toEqual({ distanceMeters: 0, accuracyMeters: 8, verifiedAt: expect.any(String),
        radiusMeters: 200, locationUpdatedAt: stored.settings.clockLocation!.updatedAt });
      expect(Object.keys(row.location!).sort()).toEqual(['accuracyMeters', 'distanceMeters', 'locationUpdatedAt', 'radiusMeters', 'verifiedAt']);
    }
    expect(JSON.stringify(stored.attendance.clockEvents)).not.toMatch(/latitude|longitude|timestamp/);
    expect((await read(app, DEMO_IDS.staff)).json().workspace.attendance.clockEvents).toEqual(stored.attendance.clockEvents);
    expect((await repository.getIdempotency(DEMO_IDS.staff, key))?.response).toEqual({ version: 3 });
    const clockAudit = (await repository.listAudit()).filter(row => row.action === 'hr.clock.in' || row.action === 'hr.clock.out');
    expect(clockAudit).toHaveLength(2);
    expect(JSON.stringify(clockAudit)).not.toMatch(/latitude|longitude|accuracy|서울 금천구/);
  });

  it('keeps staff manual creations and edits pending under a policy that automatically approves clock work', async () => {
    const { app } = await setup();
    const initial = await employee(app, 0, 'SELF', DEMO_IDS.staff); const employeeId = initial.workspace.employees[0]!.id;
    const policy = await command(app, 'work.policy.create', { name: '자동 승인 근무', kind: 'fixed', effectiveFrom: '2026-01-01',
      dailyMinutes: 480, breakMinutes: 60, workdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00', requireApproval: false }, 1);
    expect(policy.statusCode, policy.body).toBe(200);
    const policyId = policy.json().workspace.attendance.workPolicies[0].id;
    expect((await command(app, 'work.policy.assign', { employeeId, policyId, effectiveFrom: '2026-01-01' }, 2)).statusCode).toBe(200);
    const input = { employeeId, date: '2026-08-31', startTime: '09:00', endTime: '18:00', breakMinutes: 60, note: '수동 정정 요청' };
    const created = await command(app, 'work.create', input, 3, DEMO_IDS.staff);
    expect(created.statusCode, created.body).toBe(200);
    const entry = created.json().workspace.attendance.workEntries[0]; expect(entry.status).toBe('pending');
    const approved = await command(app, 'work.approve', { id: entry.id, expectedRevision: entry.revision }, 4);
    expect(approved.statusCode, approved.body).toBe(200);
    const revised = await command(app, 'work.update', { ...input, id: entry.id, expectedRevision: entry.revision + 1, endTime: '17:00' }, 5, DEMO_IDS.staff);
    expect(revised.statusCode, revised.body).toBe(200); expect(revised.json().workspace.attendance.workEntries[0].status).toBe('pending');
  });

  it('shares published coworker schedule fields without drafts, cancellations, notes or private work records', async () => {
    const { app } = await setup(); await employee(app, 0, 'SELF', DEMO_IDS.staff);
    let current = await employee(app, 1, 'OTHER'); const [own, other] = current.workspace.employees;
    async function save(type: string, input: Record<string, unknown>) {
      const result = await command(app, type, input, current.workspace.version);
      expect(result.statusCode, result.body).toBe(200); current = result.json<HrResponse>(); return current;
    }
    await save('shift.template.create', { name: '오전', startTime: '09:00', endTime: '18:00', breakMinutes: 60, kind: 'work' });
    const templateId = current.workspace.attendance.shiftTemplates[0]!.id;
    await save('shift.save', { employeeId: own!.id, templateId, date: '2026-10-01', note: '본인 일정 메모' });
    await save('shift.save', { employeeId: other!.id, templateId, date: '2026-10-01', note: '동료의 비공개 메모 76543' });
    const published = current.workspace.attendance.shifts.map(row => ({ ...row }));
    await save('shift.publish', { ids: published.map(row => row.id), revisions: Object.fromEntries(published.map(row => [row.id, row.revision])) });
    await save('shift.save', { employeeId: other!.id, templateId, date: '2026-10-02', note: '동료 초안 65432' });
    await save('shift.save', { employeeId: other!.id, templateId, date: '2026-10-03', note: '취소할 일정 54321' });
    const cancelled = current.workspace.attendance.shifts.at(-1)!;
    await save('shift.cancel', { id: cancelled.id, expectedRevision: cancelled.revision });
    await save('work.create', { employeeId: other!.id, date: '2026-08-31', startTime: '09:00', endTime: '18:00', note: '동료 실제 근무 사유 43210' });
    const expected = published.map(row => ({ id: row.id, employeeId: row.employeeId,
      employeeName: current.workspace.employees.find(employee => employee.id === row.employeeId)!.name,
      date: row.date, startTime: row.startTime, endTime: row.endTime, breakMinutes: row.breakMinutes, kind: row.kind }));
    expect(current.storeSchedule).toEqual(expected);
    const staffResponse = await read(app, DEMO_IDS.staff); const staff = staffResponse.json<HrResponse>();
    expect(staff.storeSchedule).toEqual(expected);
    expect(staff.workspace.attendance.shifts.map(row => row.employeeId)).toEqual([own!.id]);
    expect(staff.workspace.attendance.workEntries).toEqual([]);
    expect(staffResponse.body).not.toMatch(/76543|65432|54321|43210/);
    for (const row of staff.storeSchedule!) expect(Object.keys(row).sort()).toEqual(
      ['breakMinutes', 'date', 'employeeId', 'employeeName', 'endTime', 'id', 'kind', 'startTime']);
    const foreign = await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/hr`, headers: headers(DEMO_IDS.master) });
    expect(foreign.json().storeSchedule).toEqual([]);
  });
});
