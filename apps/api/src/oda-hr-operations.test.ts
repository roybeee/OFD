import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import type { HrResponse, HrWorkspace } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan, base = `/api/v2/oda/${storeId}/hr`;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4UcAAAAASUVORK5CYII=';
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const repository = createDemoRepository();
  const app = await buildApp({ repository, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false }); apps.push(app);
  const read = (actorId: string = DEMO_IDS.owner) => app.inject({ url: base, headers: { 'x-demo-actor-id': actorId } });
  const command = (type: string, input: object, expectedVersion: number, actorId: string = DEMO_IDS.owner, key = randomUUID()) => app.inject({ method: 'POST', url: `${base}/commands`, headers: { 'x-demo-actor-id': actorId, 'idempotency-key': key }, payload: { type, input, expectedVersion } });
  const linked = await command('employee.create', { employeeNumber: 'OPS-TEST', name: '점검 직원', actorId: DEMO_IDS.staff, hireDate: '2026-01-01', payType: 'hourly', basePay: 15000 }, 0); expect(linked.statusCode).toBe(200);
  return { repository, app, read, command };
}
const check = { date: '2026-01-02', phase: 'open', taskKey: 'open_clean', done: true };
const handover = { date: '2026-01-02', body: '냉장고 문 점검 부탁드립니다', category: 'facility' };
describe('ODA existing HR store operations', () => {
  it('persists check completion, serializes stale versions and replays without duplicate audit', async () => {
    const { command, read, repository } = await setup(); const key = randomUUID();
    const saved = await command('operations.check', check, 1, DEMO_IDS.staff, key); expect(saved.statusCode).toBe(200);
    expect(saved.json<HrResponse>().workspace.operations.checks[0]).toMatchObject({ ...check, completedBy: DEMO_IDS.staff });
    const audits = await repository.listAudit();
    const replay = await command('operations.check', check, 1, DEMO_IDS.staff, key); expect(replay.statusCode).toBe(200); expect(replay.headers['idempotency-replayed']).toBe('true'); expect(await repository.listAudit()).toEqual(audits);
    const concurrent = await Promise.all([command('operations.check', { ...check, done: false }, 2), command('operations.check', { ...check, taskKey: 'open_stock' }, 2)]); expect(concurrent.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await read()).json<HrResponse>().workspace.version).toBe(3);
    expect((await command('operations.check', { ...check, date: '2026-02-30' }, 3)).statusCode).toBe(422);
    expect((await command('operations.check', { ...check, taskKey: 'invented' }, 3)).statusCode).toBe(422);
    expect((await command('operations.check', { ...check, date: '2099-01-01' }, 3)).statusCode).toBe(422);
  });
  it('stores binary photo separately and serves only authorized current store members', async () => {
    const { app, command, read, repository } = await setup();
    const created = await command('operations.handover.create', { ...handover, photo: { base64: png, mimeType: 'image/png' } }, 1, DEMO_IDS.staff); expect(created.statusCode, created.body).toBe(200);
    const row = created.json<HrResponse>().workspace.operations.handovers[0]!; expect(row).toMatchObject({ ...handover, hasPhoto: true, authorId: DEMO_IDS.staff, authorName: '점검 직원' });
    const persisted = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`); expect(JSON.stringify(persisted)).not.toContain(png); expect(JSON.stringify(persisted)).not.toContain('base64');
    expect(Buffer.from((await repository.getHrPhoto(storeId, row.id))!.bytes).toString('base64')).toBe(png);
    const getPhoto = (actorId: string, selectedStore: string = storeId) => app.inject({ url: `/api/v2/oda/${selectedStore}/hr/handovers/${row.id}/photo`, headers: { 'x-demo-actor-id': actorId } });
    const photo = await getPhoto(DEMO_IDS.staff); expect(photo.statusCode).toBe(200); expect(photo.rawPayload.equals(Buffer.from(png, 'base64'))).toBe(true);
    for (const actor of [DEMO_IDS.finance, DEMO_IDS.auditor, DEMO_IDS.driver]) expect((await getPhoto(actor)).statusCode).toBe(403);
    expect((await getPhoto(DEMO_IDS.staff, DEMO_IDS.storeHapjeong)).statusCode).toBe(403);
    expect((await getPhoto(DEMO_IDS.master, DEMO_IDS.storeHapjeong)).statusCode).toBe(404);
    for (const actor of [DEMO_IDS.finance, DEMO_IDS.auditor]) expect((await read(actor)).json<HrResponse>().workspace.operations.handovers).toEqual([]);
    expect((await command('operations.handover.resolve', { id: row.id, resolved: true }, 2, DEMO_IDS.staff)).statusCode).toBe(403);
    expect((await command('operations.handover.resolve', { id: row.id, resolved: true }, 2)).statusCode).toBe(200);
    const retired = await command('employee.retire', { id: persisted!.employees[0]!.id, endDate: '2026-01-02', reason: '합성 검증' }, 3); expect(retired.statusCode).toBe(200);
    expect((await getPhoto(DEMO_IDS.staff)).statusCode).toBe(403);
    expect(JSON.stringify(await repository.listAudit())).not.toContain(handover.body);
  });
  it('rolls back invalid photo and rejects client metadata injection without leaving snapshot or retry result', async () => {
    const { command, read, repository } = await setup(); const before = await repository.listAudit(); const key = randomUUID();
    expect((await command('operations.handover.create', { ...handover, photo: { base64: Buffer.from('not png data with length').toString('base64'), mimeType: 'image/png' } }, 1, DEMO_IDS.staff, key)).statusCode).toBe(422);
    expect((await read()).json<HrResponse>().workspace.operations.handovers).toEqual([]); expect(await repository.listAudit()).toEqual(before); expect(await repository.getIdempotency(DEMO_IDS.staff, key)).toBeUndefined();
    expect((await command('operations.handover.create', { ...handover, hasPhoto: true }, 1)).statusCode).toBe(422);
    expect((await command('operations.handover.create', { ...handover, photo: { base64: png, mimeType: 'image/jpeg' } }, 1)).statusCode).toBe(422);
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1); Buffer.from(png, 'base64').copy(oversized);
    expect((await command('operations.handover.create', { ...handover, photo: { base64: oversized.toString('base64'), mimeType: 'image/png' } }, 1)).statusCode).toBe(422);
    expect((await read()).json<HrResponse>().workspace.version).toBe(1);
  });
  it('projects legacy workspaces with absent operations without data loss', async () => {
    const { repository, read, command } = await setup(); const row = (await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!;
    const { operations: _operations, ...legacy } = row;
    await repository.commit({ changes: [{ type: 'oda_hr', id: row.id, storeId, expectedVersion: row.version, value: { ...legacy, version: row.version + 1 } }] });
    expect((await read()).json<HrResponse>().workspace.operations).toEqual({ checks: [], handovers: [] });
    expect((await command('operations.check', check, 2)).statusCode).toBe(200);
    expect((await read()).json<HrResponse>().workspace.employees[0]?.basePay).toBe(15000);
  });
});
