import { randomUUID } from 'node:crypto';
import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import { createOdaMonth, type Actor, type OdaMonth } from '@ofd/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import type { AutomationBatch, IntegrationToken } from './oda-automation.ts';

const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan; const month = '2026-08';
const ui = '/api/v2/oda/automation'; const machine = '/api/v2/oda/integration';
const owner = { 'x-demo-actor-id': DEMO_IDS.owner };
const line = { externalRef: 'external-1', date: '2026-08-31', kind: 'revenue', channel: 'baemin', category: 'sales', description: '배달 매출', amountKrw: 11000, vatKrw: 1000 };
const input = (changes = {}) => ({ batchId: randomUUID(), storeId, month, source: { system: 'ASIDE', accountRef: 'synthetic-store', url: 'https://example.com/report', capturedAt: '2026-09-16T01:00:00.000Z' }, lines: [line], ...changes });
async function setup() {
  const repository = createDemoRepository();
  const app = await buildApp({ repository, logger: false, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' } }); apps.push(app);
  const response = await app.inject({ method: 'POST', url: `${ui}/tokens`, headers: owner, payload: { name: 'Synthetic integration', storeIds: [storeId], kinds: ['revenue', 'expense'], routines: true } });
  expect(response.statusCode, response.body).toBe(200);
  const token = response.json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  return { app, repository, token, headers, tokenId: response.json().connection.id as string };
}
async function preview(app: FastifyInstance, headers: { authorization: string }, payload = input()) {
  return app.inject({ method: 'POST', url: `${machine}/batches/preview`, headers, payload });
}
async function approve(app: FastifyInstance, batch: AutomationBatch, commit = true) {
  return app.inject({ method: 'POST', url: `${ui}/batches/${batch.id}/approve`, headers: owner, payload: { digest: batch.digest, commit } });
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('ODA scoped automation posting', () => {
  it('keeps only a hash at rest and rejects missing, invalid and browser bearer tokens', async () => {
    const { app, repository, headers, token, tokenId } = await setup();
    const stored = await repository.get<IntegrationToken>('oda_automation_token', tokenId);
    expect(stored?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token.split('.')[1]);
    expect((await app.inject({ url: `${machine}/capabilities` })).statusCode).toBe(401);
    expect((await app.inject({ url: `${machine}/capabilities`, headers: { authorization: `${headers.authorization.slice(0, -2)}XX` } })).statusCode).toBe(401);
    expect((await app.inject({ url: `${machine}/capabilities`, headers: { ...headers, origin: 'https://other.example' } })).statusCode).toBe(403);
    const capabilities = await app.inject({ url: `${machine}/capabilities`, headers });
    expect(capabilities.json()).toMatchObject({ storeIds: [storeId], stores: [{ id: storeId }], routines: true, approvedCommit: true });
    expect((await app.inject({ url: `${ui}/tokens?storeId=${storeId}`, headers: owner })).body).not.toContain(stored!.secretHash);
    expect(JSON.stringify(await repository.listAudit())).not.toContain(stored!.secretHash);
  });
  it('allows restricted bearer routes without a browser session but keeps user approval behind session authentication', async () => {
    const seeded = await setup();
    const app = await buildApp({ repository: seeded.repository, logger: false, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent',
      TEST_AUTH_REQUIRED: 'true', SESSION_SECRET: 'automation-test-secret-thirty-two-characters' } }); apps.push(app);
    expect((await app.inject({ url: `${machine}/capabilities`, headers: seeded.headers })).statusCode).toBe(200);
    const batch = (await preview(app, seeded.headers)).json() as AutomationBatch;
    const response = await app.inject({ method: 'POST', url: `${ui}/batches/${batch.id}/approve`, headers: seeded.headers, payload: { digest: batch.digest, commit: true } });
    expect(response.statusCode).toBe(401);
    expect(await seeded.repository.get('oda_month', `${storeId}:${month}`)).toBeUndefined();
  });
  it('previews without posting, requires exact user approval and atomically updates actual sales and expenses', async () => {
    const { app, repository, headers } = await setup();
    const payload = input({ lines: [line, { ...line, externalRef: 'expense-1', kind: 'expense', category: 'fees', amountKrw: 1100, vatKrw: 100 }] });
    const response = await preview(app, headers, payload); expect(response.statusCode, response.body).toBe(200);
    const batch = response.json() as AutomationBatch;
    expect(await repository.get('oda_month', `${storeId}:${month}`)).toBeUndefined();
    const unapproved = await app.inject({ method: 'POST', url: `${machine}/batches/${batch.id}/commit`, headers, payload: { digest: batch.digest } });
    expect(unapproved.json().error.code).toBe('ODA_APPROVAL_REQUIRED');
    const stale = await app.inject({ method: 'POST', url: `${ui}/batches/${batch.id}/approve`, headers: owner, payload: { digest: '0'.repeat(64) } });
    expect(stale.json().error.code).toBe('ODA_BATCH_CHANGED');
    const approved = await approve(app, batch); expect(approved.statusCode, approved.body).toBe(200); expect(approved.json().result).toMatchObject({ added: 2, duplicates: 0 });
    const saved = await repository.get<OdaMonth & { evidenceBytes: Record<string, string> }>('oda_month', `${storeId}:${month}`);
    expect(saved?.lines).toHaveLength(2); expect(saved?.lines.map(row => row.amount)).toEqual([11000, 1100]);
    expect(saved?.lines.every(row => !row.reviewed && row.sourceRow > 0)).toBe(true);
    expect(Buffer.from(Object.values(saved!.evidenceBytes)[0]!, 'base64').toString()).toContain('https://example.com/report');
    const retry = await app.inject({ method: 'POST', url: `${machine}/batches/${batch.id}/commit`, headers, payload: { digest: batch.digest } });
    expect(retry.json().result).toEqual(approved.json().result);
    expect((await repository.get<OdaMonth>('oda_month', `${storeId}:${month}`))?.lines).toHaveLength(2);
  });
  it('deduplicates concurrent retries and rejects changed batch IDs or changed external values', async () => {
    const { app, repository, headers } = await setup(); const payload = input();
    const responses = await Promise.all([preview(app, headers, payload), preview(app, headers, payload)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    const batch = responses[0]!.json() as AutomationBatch;
    const approvals = await Promise.all([approve(app, batch), approve(app, batch)]); expect(approvals.every(response => response.statusCode === 200)).toBe(true);
    const duplicate = await preview(app, headers); expect(duplicate.json().preview).toMatchObject({ duplicates: 1, added: 0 });
    expect((await approve(app, duplicate.json())).json().result.added).toBe(0);
    const changed = await preview(app, headers, input({ lines: [{ ...line, amountKrw: 22000 }] }));
    expect(changed.json().preview.conflicts).toEqual(['external-1']); expect((await approve(app, changed.json())).json().error.code).toBe('ODA_EXTERNAL_CONFLICT');
    expect((await preview(app, headers, { ...payload, lines: [{ ...line, amountKrw: 33000 }] })).json().error.code).toBe('ODA_IDEMPOTENCY_CONFLICT');
    const otherMonth = await preview(app, headers, input({ month: '2026-07', lines: [{ ...line, date: '2026-07-31' }] }));
    expect(otherMonth.json().preview.conflicts).toEqual(['external-1']);
    expect((await repository.get<OdaMonth>('oda_month', `${storeId}:${month}`))?.lines).toHaveLength(1);
  });
  it('normalizes external references before checking batch duplicates and replay identities', async () => {
    const { app, repository, headers } = await setup();
    const duplicate = await preview(app, headers, input({ lines: [{ ...line, externalRef: 'T1' }, { ...line, externalRef: 'Ｔ1' }] }));
    expect(duplicate.statusCode).toBe(422); expect(await repository.list('oda_automation_batch')).toHaveLength(0);
    const first = await preview(app, headers, input({ lines: [{ ...line, externalRef: ' Ｔ1 ' }] }));
    expect(first.json().input.lines[0].externalRef).toBe('T1'); await approve(app, first.json());
    const replay = await preview(app, headers, input({ lines: [{ ...line, externalRef: 'T1' }] }));
    expect(replay.json().preview).toMatchObject({ added: 0, duplicates: 1 });
  });
  it('does not reintroduce a source transaction intentionally excluded through the existing review workflow', async () => {
    const { app, repository, headers } = await setup();
    const record = { ...createOdaMonth(storeId, month), id: `${storeId}:${month}`, evidenceBytes: {}, lines: [{ id: 'original', date: line.date, kind: 'excluded', originalKind: 'revenue', originalCategory: 'sales',
      description: line.description, amount: line.amountKrw, vat: line.vatKrw, category: 'other', channel: line.channel, sourceId: 'csv-source', sourceRow: 1, externalId: line.externalRef, reviewed: true, note: '제외 사유' }] };
    await repository.commit({ changes: [{ type: 'oda_month', id: record.id, storeId, expectedVersion: null, value: record }] });
    const response = await preview(app, headers); expect(response.json().preview).toMatchObject({ added: 0, duplicates: 1 });
    await approve(app, response.json()); expect((await repository.get<OdaMonth>('oda_month', record.id))?.lines).toEqual(record.lines);
  });
  it('enforces store scope and admin-only minting; revocation fences both preview and commit', async () => {
    const { app, repository, headers, tokenId } = await setup();
    expect((await preview(app, headers, input({ storeId: DEMO_IDS.storeHapjeong }))).statusCode).toBe(403);
    for (const actorId of [DEMO_IDS.staff, DEMO_IDS.finance, DEMO_IDS.auditor]) {
      const response = await app.inject({ method: 'POST', url: `${ui}/tokens`, headers: { 'x-demo-actor-id': actorId }, payload: { name: 'bad', storeIds: [storeId], kinds: ['revenue'] } }); expect(response.statusCode).toBe(403);
    }
    const batch = (await preview(app, headers)).json() as AutomationBatch; expect((await approve(app, batch, false)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${ui}/tokens/${tokenId}/revoke`, headers: owner, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${machine}/batches/${batch.id}/commit`, headers, payload: { digest: batch.digest } })).statusCode).toBe(401);
    expect(await repository.get('oda_month', `${storeId}:${month}`)).toBeUndefined();
  });
  it('rejects locked months at commit after approval and revokes approval if issuer rights changed', async () => {
    const { app, repository, headers } = await setup(); const batch = (await preview(app, headers)).json() as AutomationBatch;
    await approve(app, batch, false);
    const record = { ...createOdaMonth(storeId, month), id: `${storeId}:${month}`, status: 'finalized', evidenceBytes: {} };
    await repository.commit({ changes: [{ type: 'oda_month', id: record.id, storeId, expectedVersion: null, value: record }] });
    const result = await app.inject({ method: 'POST', url: `${machine}/batches/${batch.id}/commit`, headers, payload: { digest: batch.digest } });
    expect(result.json().error.code).toBe('ODA_MONTH_LOCKED');
    const actor = (await repository.get<Actor>('actor', DEMO_IDS.owner))!;
    await repository.commit({ changes: [{ type: 'actor', id: actor.id, expectedVersion: 1, value: { ...actor, authVersion: actor.authVersion + 1 } }] });
    expect((await app.inject({ url: `${machine}/capabilities`, headers })).statusCode).toBe(401);
  });
  it.each([
    { date: '2026-02-30' }, { date: '2026-07-31' }, { amountKrw: 1.1 }, { amountKrw: Number.MAX_SAFE_INTEGER },
    { vatKrw: -10 }, { vatKrw: 11001 }, { category: 'supplies' }, { channel: 'unknown' },
  ])('rejects malformed accounting values before persistence: %j', async changes => {
    const { app, repository, headers } = await setup();
    const result = await preview(app, headers, input({ lines: [{ ...line, ...changes }] })); expect(result.statusCode, result.body).toBe(422);
    expect(await repository.list('oda_automation_batch')).toEqual([]);
  });
});
