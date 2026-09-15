import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import { createOdaMonth, type Actor, type OdaLine, type OdaMonth, type OdaSource } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildApp } from './app.ts';

const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan;
const month = '2026-08';
const base = `/api/v2/oda/${storeId}/${month}`;
const owner = { 'x-demo-actor-id': DEMO_IDS.owner };
const finance = { 'x-demo-actor-id': DEMO_IDS.finance };
const proof: OdaSource = { id: 'receipt', fileName: '증빙.pdf', kind: 'evidence', channel: '', sha256: 'stored-hash',
  importedAt: '2026-08-31T00:00:00.000Z', importedBy: DEMO_IDS.owner, rowCount: 0, sizeBytes: 24, mimeType: 'application/pdf' };
const expense = (id: string, extra: Partial<OdaLine> = {}): OdaLine => ({ id, kind: 'expense', date: `${month}-31`,
  description: '포장재 구입', amount: 11000, vat: 1000, category: 'uncategorized', channel: 'manual', sourceId: '',
  sourceRow: 0, externalId: '', reviewed: false, note: '', ...extra });
type Record = OdaMonth & { evidenceBytes: { [sourceId: string]: string } };
function record(lines = [expense('one'), expense('two')]): Record {
  const data = createOdaMonth(storeId, month); data.version = 1; data.policy.vatBasis = 'net';
  return { ...data, id: `${storeId}:${month}`, lines, sources: [proof], evidenceBytes: { receipt: 'PRIVATE ORIGINAL BYTES' } };
}
async function setup(data = record(), authenticated = false) {
  const repository = createDemoRepository();
  const actor = (await repository.get<Actor>('actor', DEMO_IDS.finance))!;
  await repository.commit({ changes: [{ type: 'actor', id: actor.id, expectedVersion: 1, value: { ...actor, storeIds: [storeId] } },
    { type: 'oda_month', id: data.id, storeId, expectedVersion: null, value: data }] });
  const app = await buildApp({ repository, logger: false, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent',
    ...(authenticated ? { TEST_AUTH_REQUIRED: 'true', SESSION_SECRET: 'batch-test-session-secret-at-least-thirty-two-characters' } : {}) } });
  apps.push(app); return { app, repository, data };
}
const batch = (app: FastifyInstance, changes: unknown, lineIds = ['one', 'two'], expectedVersion = 1, headers = owner, url = base) =>
  app.inject({ method: 'POST', url: `${url}/expenses/batch`, headers, payload: { expectedVersion, lineIds, changes } });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('ODA atomic expense batch API', () => {
  it('applies classification, proof attachment and confirmation once, preserving original fields and private bytes', async () => {
    const { app, repository, data } = await setup(record([expense('one', { sourceId: proof.id, sourceRow: 2 }), expense('two')]));
    const response = await batch(app, { category: 'supplies', sourceId: proof.id, reviewed: true }, undefined, undefined, finance);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ version: 2, batchResult: { updated: 2 }, summary: { expenses: 20000, grossExpenses: 22000 } });
    expect(response.json().data.lines).toEqual(data.lines.map(line => ({ ...line, category: 'supplies', sourceId: proof.id, reviewed: true })));
    expect(response.body).not.toContain('evidenceBytes');
    expect(response.body).not.toContain('PRIVATE ORIGINAL BYTES');
    const audits = await repository.listAudit(100, [storeId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: DEMO_IDS.finance, action: 'ODA 비용 일괄 정리', metadata: {
      lineIds: ['one', 'two'], changes: { category: 'supplies', sourceId: proof.id, reviewed: true } } });
    expect(audits[0]!.metadata.lineChanges).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('PRIVATE ORIGINAL BYTES');
    expect((await repository.get<Record>('oda_month', data.id))?.evidenceBytes).toEqual(data.evidenceBytes);
  });

  it('supports draft organization before evidence is ready without confirming it', async () => {
    const { app } = await setup();
    const response = await batch(app, { category: 'supplies', reviewed: false });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.lines.every((line: OdaLine) => line.category === 'supplies' && !line.reviewed && !line.sourceId)).toBe(true);
    expect(response.json().summary.blockers.filter((issue: { code: string }) => issue.code === 'source_missing')).toHaveLength(2);
  });

  it('enforces authentication, editing roles and store membership before any mutation', async () => {
    const { app, repository, data } = await setup();
    for (const actorId of [DEMO_IDS.auditor, DEMO_IDS.staff, DEMO_IDS.ops]) {
      expect((await batch(app, { category: 'supplies' }, undefined, undefined, { 'x-demo-actor-id': actorId })).statusCode).toBe(403);
    }
    const other = `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${month}`;
    for (const headers of [owner, finance]) expect((await batch(app, { category: 'supplies' }, undefined, undefined, headers, other)).statusCode).toBe(403);
    expect((await repository.get<OdaMonth>('oda_month', data.id))?.version).toBe(1);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
    const secure = await setup(record(), true);
    expect((await batch(secure.app, { category: 'supplies' })).statusCode).toBe(401);
  });

  it.each(['finalized', 'paid'] as const)('rejects %s months and stale versions', async status => {
    const data = record(); data.status = status;
    const { app, repository } = await setup(data);
    expect((await batch(app, { category: 'supplies' }, undefined, 0)).json().error.code).toBe('VERSION_CONFLICT');
    expect((await batch(app, { category: 'supplies' })).json().error.code).toBe('ODA_MONTH_LOCKED');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
  });

  it.each([
    { lineIds: [], changes: { reviewed: true } },
    { lineIds: ['one', 'one'], changes: { reviewed: true } },
    { lineIds: Array.from({ length: 201 }, (_, index) => String(index)), changes: { reviewed: true } },
    { lineIds: ['one'], changes: {} },
    { lineIds: ['one'], changes: { category: 'capex' } },
    { lineIds: ['one'], changes: { category: 'supplies', amount: 100 } },
    { lineIds: ['one'], changes: { sourceId: '' } },
  ])('rejects malformed or overbroad batch payload $changes without changes', async payload => {
    const { app, repository, data } = await setup();
    const response = await batch(app, payload.changes, payload.lineIds);
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
  });

  it.each(['bank', 'revenue', 'excluded'] as const)('rolls back all selected rows if a %s row was included', async kind => {
    const { app, repository, data } = await setup(record([expense('one'), expense('two', { kind, sourceRow: 2 })]));
    const response = await batch(app, { category: 'supplies' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('ODA_EXPENSE_REQUIRED');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
  });

  it('never resolves foreign line IDs or foreign month proof and rolls back earlier selected edits', async () => {
    const { app, repository, data } = await setup();
    const other = { ...record([expense('foreign')]), id: `${DEMO_IDS.storeHapjeong}:${month}`, storeId: DEMO_IDS.storeHapjeong };
    const prior = { ...record(), id: `${storeId}:2026-07`, month: '2026-07', sources: [{ ...proof, id: 'prior-proof' }] };
    await repository.commit({ changes: [other, prior].map(value => ({ type: 'oda_month' as const, id: value.id, storeId: value.storeId, expectedVersion: null, value })) });
    expect((await batch(app, { category: 'supplies' }, ['one', 'foreign'])).json().error.code).toBe('ODA_LINE_NOT_FOUND');
    expect((await batch(app, { sourceId: 'prior-proof' })).json().error.code).toBe('ODA_SOURCE_INVALID');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect(await repository.get<OdaMonth>('oda_month', other.id)).toEqual(other);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
  });

  it('rejects confirmation without proof, classification or actual VAT and preserves every row on failure', async () => {
    for (const invalid of [expense('two', { category: 'supplies' }), expense('two', { sourceId: proof.id }),
      expense('two', { category: 'supplies', sourceId: proof.id, vat: null })]) {
      const { app, repository, data } = await setup(record([expense('one', { category: 'supplies', sourceId: proof.id }), invalid]));
      const response = await batch(app, { reviewed: true });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe(invalid.sourceId ? 'ODA_EXPENSE_REVIEW_BLOCKED' : 'ODA_EXPENSE_SOURCE_REQUIRED');
      if (invalid.sourceId) expect(response.json().error.details.blockers[0].lineId).toBe('two');
      expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
      expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
    }
  });

  it('rejects duplicate original transactions during confirmation', async () => {
    const { app, repository, data } = await setup(record(['one', 'two'].map(id => expense(id, { category: 'supplies', sourceId: proof.id, externalId: 'shared-id' }))));
    const response = await batch(app, { reviewed: true });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.blockers.some((issue: { code: string }) => issue.code === 'duplicate_external_id')).toBe(true);
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
  });

  it('preserves immutable source links, bank safeguards and repeated-cost proof requirements', async () => {
    const first = record([expense('one'), expense('two', { sourceId: 'original', sourceRow: 3 })]);
    first.sources.push({ ...proof, id: 'original', kind: 'expense' });
    const { app, repository } = await setup(first);
    expect((await batch(app, { sourceId: proof.id })).json().error.code).toBe('ODA_SOURCE_IMMUTABLE');
    expect(await repository.get<OdaMonth>('oda_month', first.id)).toEqual(first);
    const bank = record(); bank.sources.push({ ...proof, id: 'bank-original', kind: 'bank' });
    const bankApp = await setup(bank);
    expect((await batch(bankApp.app, { sourceId: 'bank-original' })).json().error.code).toBe('ODA_BANK_NOT_PL');
    const repeated = record([expense('one', { externalId: 'repeat:2026-07:rent', category: 'rent' })]);
    const repeatApp = await setup(repeated);
    expect((await batch(repeatApp.app, { reviewed: true }, ['one'])).json().error.code).toBe('ODA_REPEAT_SOURCE_REQUIRED');
    const attached = await batch(repeatApp.app, { reviewed: true, sourceId: proof.id }, ['one']);
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json().summary.expenses).toBe(10000);
  });

  it('serializes concurrent submissions so one batch wins and the other leaves no partial edits', async () => {
    const { app, repository, data } = await setup();
    const responses = await Promise.all([batch(app, { category: 'supplies' }), batch(app, { category: 'other' })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const stored = (await repository.get<OdaMonth>('oda_month', data.id))!;
    expect(stored.version).toBe(2);
    expect(new Set(stored.lines.map(line => line.category)).size).toBe(1);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(1);
  });

  it('requires proof for individual confirmation while allowing repair of existing reviewed rows', async () => {
    const { app, repository, data } = await setup(record([expense('one', { reviewed: true }), expense('two', { reviewed: true })]));
    const update = (expectedVersion: number, changes: unknown) => app.inject({ method: 'POST', url: `${base}/lines/one`, headers: owner, payload: { expectedVersion, changes } });
    const confirmed = await update(1, { reviewed: true });
    expect(confirmed.statusCode).toBe(422);
    expect(confirmed.json().error.code).toBe('ODA_EXPENSE_SOURCE_REQUIRED');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect((await update(1, { category: 'supplies' })).statusCode).toBe(200);
    const attached = await update(2, { sourceId: proof.id, reviewed: true });
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json().data.lines[0]).toMatchObject({ sourceId: proof.id, reviewed: true });
  });

  it('exports a downloadable private ZIP only within authorized store scope without a write', async () => {
    const { app, repository, data } = await setup();
    const download = await app.inject({ method: 'GET', url: `${base}/expenses/export.zip`, headers: owner });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['cache-control']).toContain('no-store');
    expect(download.headers['content-disposition']).toBe('attachment; filename="ODA-expenses-2026-08.zip"');
    expect(Object.keys((await JSZip.loadAsync(download.rawPayload)).files).length).toBeGreaterThan(0);
    for (const headers of [owner, finance]) expect((await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/${month}/expenses/export.zip`, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${base}/expenses/export.zip`, headers: { 'x-demo-actor-id': DEMO_IDS.staff } })).statusCode).toBe(403);
    const secure = await setup(record(), true);
    expect((await secure.app.inject({ method: 'GET', url: `${base}/expenses/export.zip`, headers: owner })).statusCode).toBe(401);
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
  });

  it('prevents new confirmed expenses without proof while accepting an unfinished cost or a documented exclusion', async () => {
    const { app, repository, data } = await setup();
    const line = { date: `${month}-31`, kind: 'expense', description: '새 비용', amount: 1100, vat: 100, category: 'supplies', reviewed: true };
    const create = (expectedVersion: number, changes = {}) => app.inject({ method: 'POST', url: `${base}/lines`, headers: owner, payload: { expectedVersion, line: { ...line, ...changes } } });
    const rejected = await create(1);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe('ODA_EXPENSE_SOURCE_REQUIRED');
    expect(await repository.get<OdaMonth>('oda_month', data.id)).toEqual(data);
    expect((await create(1, { reviewed: false })).statusCode).toBe(200);
    expect((await create(2, { kind: 'excluded', note: '운영 비용에 해당하지 않아 제외' })).statusCode).toBe(200);
    expect((await create(3, { sourceId: proof.id })).statusCode).toBe(200);
  });
});
