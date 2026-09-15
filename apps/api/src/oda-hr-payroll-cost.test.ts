import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDemoRepository, DEMO_IDS, type StateRepository } from '@ofd/db';
import { ACCESS_PAGES, applyHrPayrollCommand, calculateOdaMonth, createHrWorkspace, createOdaMonth, type Actor, type HrContext, type HrWorkspace, type OdaLine, type OdaMonth } from '@ofd/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { registerOdaHrPayrollCostRoutes, type HrPayrollCostPreview } from './oda-hr-payroll-cost.ts';

const storeId = DEMO_IDS.storeDoksan;
const month = '2026-09'; const NOW = '2026-10-05T00:00:00.000Z';
const path = `/api/v2/oda/${storeId}/hr/payroll-cost`;
type RecordMonth = OdaMonth & { evidenceBytes: Record<string, string>; hrPayrollCost?: unknown };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const repository = createDemoRepository(); const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('preHandler', async request => { request.actor = (await repository.get<Actor>('actor', String(request.headers['x-test-actor'] ?? DEMO_IDS.owner)))!; });
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 422).send({ error: { code: (error as { code?: string }).code ?? 'VALIDATION', message: error.message } }));
  registerOdaHrPayrollCostRoutes(app, repository); return { app, repository };
}
async function seedHr(repository: StateRepository, locked = true) {
  const hr = createHrWorkspace(storeId, '인사 테스트', NOW); hr.version = 1;
  hr.employees = [1_234_567, 7_654_321].map((basePay, index) => ({ id: `secret-employee-${index}`, employeeNumber: `PRIVATE-${index}`, name: `개별기밀성명${index}`, departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-01-01', payType: 'monthly', basePay, history: [] }));
  hr.attendance.locks.push({ id: 'closed', startDate: '2026-09-01', endDate: '2026-09-30', employeeIds: [], status: 'locked', revision: 1, at: NOW, actorId: 'manager', reason: '완료' });
  const ctx: HrContext = { actorId: 'manager', manager: true, payroll: true, today: '2026-10-05', now: NOW, id: randomUUID };
  applyHrPayrollCommand(hr, { type: 'payroll.create', input: { month, payDate: '2026-10-05' } }, ctx);
  for (const row of hr.payroll.runs[0]!.rows) applyHrPayrollCommand(hr, { type: 'payroll.updateRow', input: { runId: hr.payroll.runs[0]!.id, employeeId: row.employeeId, incomeTax: 10_000, localTax: 1000, employeeInsurance: 50_000, employerInsurance: 100_000, manualConfirmed: true } }, ctx);
  if (locked) for (const action of ['review', 'lock']) applyHrPayrollCommand(hr, { type: `payroll.${action}`, input: { runId: hr.payroll.runs[0]!.id } }, ctx);
  await repository.commit({ changes: [{ type: 'oda_hr', id: hr.id, storeId, expectedVersion: null, value: hr }] }); return hr;
}
function manualLine(id: string, category = 'labor'): OdaLine {
  return { id, date: `${month}-30`, kind: 'expense', description: '원래 수기 비용', amount: 999, vat: 0, category, channel: '', sourceId: '', sourceRow: 0, externalId: '', reviewed: false, note: '사용자 메모' };
}
async function seedMonth(repository: StateRepository, extra: Partial<RecordMonth> = {}) {
  const oda: RecordMonth = { ...createOdaMonth(storeId, month, NOW), id: `${storeId}:${month}`, version: 1, evidenceBytes: {}, ...extra };
  await repository.commit({ changes: [{ type: 'oda_month', id: oda.id, storeId, expectedVersion: null, value: oda }] }); return oda;
}
async function preview(app: FastifyInstance, actorId: string = DEMO_IDS.owner) { return app.inject({ method: 'GET', url: `${path}?month=${month}`, headers: { 'x-test-actor': actorId } }); }
async function apply(app: FastifyInstance, expectedHrVersion: number, expectedOdaVersion: number, key = randomUUID(), actorId: string = DEMO_IDS.owner, extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: path, headers: { 'x-test-actor': actorId, 'idempotency-key': key }, payload: { month, expectedHrVersion, expectedOdaVersion, ...extra } });
}

describe('HR confirmed payroll cost bridge', () => {
  it('previews virtual data without writing either aggregate or generating evidence', async () => {
    const { app, repository } = await setup(); const response = await preview(app);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ hrVersion: 0, odaVersion: 0, total: null, canApply: false });
    expect(await repository.get('oda_hr', `hr:${storeId}`)).toBeUndefined(); expect(await repository.get('oda_month', `${storeId}:${month}`)).toBeUndefined();
    expect((await apply(app, 0, 0)).statusCode).toBe(409);
  });
  it('requires HR and finance page capabilities, assigned store, active role and a retry key', async () => {
    const { app, repository } = await setup(); await seedHr(repository);
    expect((await app.inject({ method: 'POST', url: path, payload: { month, expectedHrVersion: 1, expectedOdaVersion: 0 } })).statusCode).toBe(428);
    expect((await preview(app, DEMO_IDS.staff)).statusCode).toBe(403);
    const auditRead = await preview(app, DEMO_IDS.auditor); expect(auditRead.statusCode).toBe(200); expect(auditRead.json().canApply).toBe(false);
    expect((await apply(app, 1, 0, randomUUID(), DEMO_IDS.auditor)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/hr/payroll-cost?month=${month}` })).statusCode).toBe(403);
    await repository.commit({ changes: [{ type: 'access_policy', id: 'access-policy', storeId: '__system__', expectedVersion: null, value: { id: 'access-policy', version: 1, rolePages: {}, actorPages: { [DEMO_IDS.owner]: ['/store/oda-hr'] }, knownPaths: ACCESS_PAGES.map(page => page.path) } }] });
    expect((await preview(app)).statusCode).toBe(403); expect((await apply(app, 1, 0)).statusCode).toBe(403);
  });
  it('commits aggregate cost with both CAS guards, immutable aggregate evidence and no employee disclosure', async () => {
    const { app, repository } = await setup(); const hr = await seedHr(repository);
    const response = await apply(app, 1, 0, randomUUID(), DEMO_IDS.owner, { expectedPayrollRunId: hr.payroll.runs[0]!.id });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ total: 9_088_888, gross: 8_888_888, currentAmount: 9_088_888, hrVersion: 2, odaVersion: 1, alreadyApplied: true });
    const oda = (await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!;
    expect(oda.lines).toHaveLength(1); expect(oda.lines[0]).toMatchObject({ id: 'hr-payroll:2026-09', category: 'labor', amount: 9_088_888, vat: 0, reviewed: true });
    expect(calculateOdaMonth(oda).expenses).toBe(9_088_888); expect(calculateOdaMonth(oda).blockers.some(issue => issue.code === 'source_missing')).toBe(false);
    const source = oda.sources[0]!; const bytes = Buffer.from(oda.evidenceBytes[source.id]!, 'base64');
    expect(source.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(source.sizeBytes).toBe(bytes.length);
    const publicMaterial = response.body + bytes.toString() + JSON.stringify(await repository.listAudit());
    for (const secret of ['개별기밀성명', 'PRIVATE-', 'secret-employee-', '1234567', '7654321', 'evidenceBytes']) expect(publicMaterial).not.toContain(secret);
    const currentHr = (await repository.get<HrWorkspace>('oda_hr', hr.id))!; expect(currentHr.version).toBe(2); expect(currentHr.payroll).toEqual(hr.payroll);
  });
  it('preserves existing source bytes and non-labor lines when adding cost', async () => {
    const { app, repository } = await setup(); await seedHr(repository);
    const bytes = Buffer.from('PRIVATE ORIGINAL PROOF'); const line = { ...manualLine('supplies', 'supplies'), sourceId: 'original', reviewed: true };
    const original = await seedMonth(repository, { lines: [line], sources: [{ id: 'original', fileName: 'original.txt', kind: 'expense', channel: '', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, rowCount: 1, mimeType: 'text/plain', importedAt: NOW, importedBy: 'original-actor' }], evidenceBytes: { original: bytes.toString('base64') } });
    expect((await apply(app, 1, 1)).statusCode).toBe(200); const current = (await repository.get<RecordMonth>('oda_month', original.id))!;
    expect(current.sources[0]).toEqual(original.sources[0]); expect(current.evidenceBytes.original).toBe(original.evidenceBytes.original); expect(current.lines[0]).toEqual(line);
  });
  it('replays only a non-sensitive receipt and a fresh response, and new duplicate requests do not write again', async () => {
    const { app, repository } = await setup(); await seedHr(repository); const key = randomUUID();
    expect((await apply(app, 1, 0, key)).statusCode).toBe(200);
    const replay = await apply(app, 1, 0, key); expect(replay.headers['idempotency-replayed']).toBe('true'); expect(replay.json().odaVersion).toBe(1);
    const receipt = (await repository.getIdempotency(DEMO_IDS.owner, key))!.response;
    expect(receipt).toEqual({ changed: true, month, hrVersion: 2, odaVersion: 1 });
    expect((await apply(app, 2, 1)).statusCode).toBe(200);
    expect((await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!.sources).toHaveLength(1);
    expect((await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!.version).toBe(2);
    const owner = (await repository.get<Actor>('actor', DEMO_IDS.owner))!;
    await repository.commit({ changes: [{ type: 'actor', id: owner.id, expectedVersion: 1, value: { ...owner, role: 'store_staff' } }] });
    expect((await apply(app, 1, 0, key)).statusCode).toBe(403);
  });
  it('resolves simultaneous writes once and rolls back both aggregates on stale HR/ODA or selected-run versions', async () => {
    const { app, repository } = await setup(); await seedHr(repository);
    expect((await apply(app, 999, 0)).statusCode).toBe(409); expect((await apply(app, 1, 5)).statusCode).toBe(409);
    expect((await apply(app, 1, 0, randomUUID(), DEMO_IDS.owner, { expectedPayrollRunId: 'wrong' })).statusCode).toBe(409);
    expect(await repository.get('oda_month', `${storeId}:${month}`)).toBeUndefined(); expect((await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!.version).toBe(1);
    const results = await Promise.all([apply(app, 1, 0), apply(app, 1, 0)]); expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!.lines).toHaveLength(1);
  });
  for (const status of ['finalized', 'paid'] as const) it(`never changes a ${status} ODA month`, async () => {
    const { app, repository } = await setup(); await seedHr(repository); const before = await seedMonth(repository, { status });
    expect((await apply(app, 1, 1)).statusCode).toBe(409); expect(await repository.get('oda_month', before.id)).toEqual(before);
    expect((await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!.version).toBe(1);
  });
  it('rejects draft payroll, manual labor collisions and an occupied managed identifier', async () => {
    const first = await setup(); await seedHr(first.repository, false); expect((await apply(first.app, 1, 0)).statusCode).toBe(409);
    for (const line of [manualLine('manual-labor'), manualLine('hr-payroll:2026-09', 'supplies')]) {
      const { app, repository } = await setup(); await seedHr(repository); const before = await seedMonth(repository, { lines: [line] });
      expect((await apply(app, 1, 1)).statusCode).toBe(409); expect(await repository.get('oda_month', before.id)).toEqual(before);
    }
  });
  it('records the current lock revision for unchanged and changed re-finalizations without treating publication as another cost', async () => {
    for (const amount of [0, 111]) {
      const { app, repository } = await setup(); await seedHr(repository); await apply(app, 1, 0);
      const before = (await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!;
      const hr = (await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!; const run = hr.payroll.runs[0]!;
      const ctx: HrContext = { actorId: 'hr', manager: true, payroll: true, today: '2026-10-05', now: NOW, id: randomUUID };
      applyHrPayrollCommand(hr, { type: 'payroll.publish', input: { runId: run.id } }, ctx);
      applyHrPayrollCommand(hr, { type: 'payroll.reopen', input: { runId: run.id, reason: '확정 내용 재검토' } }, ctx);
      if (amount) applyHrPayrollCommand(hr, { type: 'payroll.addAdjustment', input: { runId: run.id, employeeId: run.rows[0]!.employeeId, kind: 'allowance', label: '정정 수당', amount } }, ctx);
      for (const row of run.rows) applyHrPayrollCommand(hr, { type: 'payroll.updateRow', input: { runId: run.id, employeeId: row.employeeId, incomeTax: 10_000, localTax: 1000, employeeInsurance: 50_000, employerInsurance: 100_000, manualConfirmed: true } }, ctx);
      for (const type of ['review', 'lock']) applyHrPayrollCommand(hr, { type: `payroll.${type}`, input: { runId: run.id } }, ctx);
      const lockedRevision = run.revision;
      hr.version = 3; await repository.commit({ changes: [{ type: 'oda_hr', id: hr.id, storeId, expectedVersion: 2, value: hr }] });
      expect((await preview(app)).json()).toMatchObject({ canApply: true, alreadyApplied: false });
      expect((await apply(app, 3, 1)).statusCode).toBe(200);
      const after = (await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!;
      expect(after.hrPayrollCost).toMatchObject({ runRevision: lockedRevision });
      expect(after.lines).toHaveLength(1); expect(after.lines[0]!.amount).toBe(9_088_888 + amount);
      expect(after.sources).toHaveLength(2); expect(after.sources[1]!.id).not.toBe(before.sources[0]!.id);
      expect(after.sources[1]!.fileName).toBe(`HR_급여합계_${month}_v${lockedRevision}.csv`);
      expect(Buffer.from(after.evidenceBytes[after.sources[1]!.id]!, 'base64').toString()).toContain(`,${run.id},${lockedRevision}\r\n`);
      const published = (await repository.get<HrWorkspace>('oda_hr', hr.id))!;
      applyHrPayrollCommand(published, { type: 'payroll.publish', input: { runId: run.id } }, ctx);
      published.version = 5; await repository.commit({ changes: [{ type: 'oda_hr', id: hr.id, storeId, expectedVersion: 4, value: published }] });
      expect((await preview(app)).json()).toMatchObject({ canApply: false, alreadyApplied: true });
      expect((await apply(app, 5, 2)).json().receipt.changed).toBe(false);
      expect((await repository.get<RecordMonth>('oda_month', after.id))!.sources).toHaveLength(2);
    }
  });
  it('replaces one managed line after explicit re-finalization while preserving previous evidence', async () => {
    const { app, repository } = await setup(); await seedHr(repository); await apply(app, 1, 0);
    const before = (await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!;
    const hr = (await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`))!; const run = hr.payroll.runs[0]!;
    const ctx: HrContext = { actorId: 'hr', manager: true, payroll: true, today: '2026-10-05', now: NOW, id: randomUUID };
    applyHrPayrollCommand(hr, { type: 'payroll.reopen', input: { runId: run.id, reason: '수당 누락 정정' } }, ctx);
    applyHrPayrollCommand(hr, { type: 'payroll.addAdjustment', input: { runId: run.id, employeeId: run.rows[0]!.employeeId, kind: 'allowance', label: '수당', amount: 111 } }, ctx);
    for (const row of run.rows) applyHrPayrollCommand(hr, { type: 'payroll.updateRow', input: { runId: run.id, employeeId: row.employeeId, incomeTax: 10_000, localTax: 1000, employeeInsurance: 50_000, employerInsurance: 100_000, manualConfirmed: true } }, ctx);
    for (const type of ['review', 'lock']) applyHrPayrollCommand(hr, { type: `payroll.${type}`, input: { runId: run.id } }, ctx);
    hr.version = 3; await repository.commit({ changes: [{ type: 'oda_hr', id: hr.id, storeId, expectedVersion: 2, value: hr }] });
    expect((await apply(app, 3, 1)).statusCode).toBe(200); const after = (await repository.get<RecordMonth>('oda_month', `${storeId}:${month}`))!;
    expect(after.lines).toHaveLength(1); expect(after.lines[0]!.amount).toBe(9_088_999); expect(after.sources).toHaveLength(2);
    expect(after.sources[0]).toEqual(before.sources[0]); expect(after.evidenceBytes[before.sources[0]!.id]).toBe(before.evidenceBytes[before.sources[0]!.id]);
    // Manual review changes must not be silently overwritten by a fresh bridge request.
    after.lines[0]!.note = '사용자가 직접 수정'; after.version += 1;
    await repository.commit({ changes: [{ type: 'oda_month', id: after.id, storeId, expectedVersion: 2, value: after }] });
    expect((await apply(app, 4, 3)).statusCode).toBe(409);
  });
});
