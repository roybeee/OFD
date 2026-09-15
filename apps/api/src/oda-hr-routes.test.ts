import { randomUUID } from 'node:crypto';
import { createDemoRepository, DEMO_IDS, type StateRepository } from '@ofd/db';
import { ACCESS_PAGES, HR_COMMAND_ACCESS, type Actor, type HrResponse, type HrWorkspace } from '@ofd/domain';
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
