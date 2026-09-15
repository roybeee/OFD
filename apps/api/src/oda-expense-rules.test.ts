import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import { createOdaMonth, type OdaLine, type OdaMonth } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from './app.ts';
const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${storeId}/2026-09`;
const rulesPath = `/api/v2/oda/${storeId}/expense-rules`;
const owner = { 'x-demo-actor-id': DEMO_IDS.owner };
function row(id: string, description = 'ABC 매장'): OdaLine { return { id, description, date: '2026-09-01', kind: 'expense', amount: 11000, vat: 1000, category: 'uncategorized', channel: 'manual', sourceId: '', sourceRow: 0, externalId: '', note: '', reviewed: false }; }
async function setup(lines = [row('one'), row('two', 'ＡＢＣ  매장')]) {
  const repository = createDemoRepository();
  const data = { ...createOdaMonth(storeId, '2026-09'), id: `${storeId}:2026-09`, version: 1, lines, evidenceBytes: {} };
  await repository.commit({ changes: [{ type: 'oda_month', id: data.id, storeId, expectedVersion: null, value: data }] });
  const app = await buildApp({ repository, logger: false, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' } }); apps.push(app);
  return { app, repository, data };
}
const remember = (app: FastifyInstance, expectedVersion = 1, expectedExpenseRulesVersion = 0, category = 'supplies') => app.inject({ method: 'POST', url: `${base}/expenses/batch`, headers: owner,
  payload: { expectedVersion, lineIds: ['one', 'two'], changes: { category }, rememberCategory: true, expectedExpenseRulesVersion } });
const file = { filename: '비용.csv', kind: 'expense', content: 'date,description,amount,vat\n2026-09-12,ABC 매장,22000,2000\n' };
const preview = (app: FastifyInstance) => app.inject({ method: 'POST', url: `${base}/import/preview`, headers: owner, payload: { ...file, useExpenseRules: true } });
const rules = async (app: FastifyInstance) => (await app.inject({ method: 'GET', url: rulesPath, headers: owner })).json();
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

it('remembers only with explicit opt-in, merges normalized contents and exposes no monthly private data', async () => {
  const { app, repository, data } = await setup();
  expect(await rules(app)).toEqual({ version: 0, rules: [] }); expect(await repository.list('oda_expense_rules', [storeId])).toHaveLength(0);
  const manual = await app.inject({ method: 'POST', url: `${base}/expenses/batch`, headers: owner, payload: { expectedVersion: 1, lineIds: ['one'], changes: { category: 'supplies' } } });
  expect(manual.statusCode).toBe(200); expect(await rules(app)).toEqual({ version: 0, rules: [] });
  const result = await remember(app, 2);
  expect(result.statusCode, result.body).toBe(200); expect(result.json().expenseRules).toMatchObject({ version: 1, rules: [{ description: 'ABC 매장', category: 'supplies' }] });
  expect((await rules(app)).rules).toHaveLength(1); expect(JSON.stringify(await rules(app))).not.toMatch(/amount|evidenceBytes|sourceId/);
  expect((await repository.get<OdaMonth>('oda_month', data.id))?.version).toBe(3);
  expect((await repository.listAudit(100, [storeId])).some(event => event.action === 'ODA 비용 분류 기억')).toBe(true);
});
it('requires a current rules version and keeps both monthly classification and rules unchanged on conflict', async () => {
  const { app, repository, data } = await setup(); await remember(app);
  const result = await remember(app, 2, 0, 'labor');
  expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('ODA_RULES_VERSION_CONFLICT');
  expect((await rules(app)).rules[0].category).toBe('supplies');
  expect((await repository.get<OdaMonth>('oda_month', data.id))?.version).toBe(2);
  const bad = await app.inject({ method: 'POST', url: `${base}/expenses/batch`, headers: owner, payload: { expectedVersion: 2, lineIds: ['one'], changes: { category: 'labor' }, rememberCategory: true } });
  expect(bad.statusCode).toBe(422);
});
it('rolls back remembered rules if any existing monthly row fails validation after the rule save', async () => {
  const { app, repository, data } = await setup([row('one'), row('two'), { ...row('bad'), date: '2026-08-01' }]);
  const result = await remember(app); expect(result.statusCode).toBe(422);
  expect(await rules(app)).toEqual({ version: 0, rules: [] }); expect((await repository.get<OdaMonth>('oda_month', data.id))?.version).toBe(1);
  expect(await repository.listAudit(100, [storeId])).toHaveLength(0);
});
it('rejects generic descriptions without partially remembering other selected rows', async () => {
  const { app, repository, data } = await setup([row('one'), row('two', '비용')]);
  const result = await remember(app); expect(result.json().error.code).toBe('ODA_RULE_DESCRIPTION');
  expect(await rules(app)).toEqual({ version: 0, rules: [] }); expect((await repository.get<OdaMonth>('oda_month', data.id))?.version).toBe(1);
});
it('applies the displayed rule snapshot on import, retains review work and never mutates the uploaded original', async () => {
  const { app, repository, data } = await setup(); await remember(app);
  const shown = await preview(app); expect(shown.statusCode).toBe(200); expect(shown.json()).toMatchObject({ expenseRulesVersion: 1, lines: [{ category: 'supplies', reviewed: false, categoryRule: { version: 1 } }] });
  const result = await app.inject({ method: 'POST', url: `${base}/import`, headers: owner, payload: { ...file, expectedVersion: 2, expectedExpenseRulesVersion: 1 } });
  expect(result.statusCode, result.body).toBe(200); expect(result.json().data.lines.at(-1)).toMatchObject({ amount: 22000, vat: 2000, category: 'supplies', reviewed: false, categoryRule: { description: 'ABC 매장', version: 1 } });
  const stored = await repository.get<OdaMonth & { evidenceBytes: Record<string,string> }>('oda_month', data.id);
  expect(Buffer.from(Object.values(stored!.evidenceBytes)[0]!, 'base64').toString()).toBe(file.content);
});
it('does not silently apply unseen rules for legacy callers which omitted a preview rules version', async () => {
  const { app } = await setup(); await remember(app);
  const legacyPreview = await app.inject({ method: 'POST', url: `${base}/import/preview`, headers: owner, payload: file });
  expect(legacyPreview.json().expenseRulesVersion).toBeUndefined(); expect(legacyPreview.json().lines[0].categoryRule).toBeUndefined();
  const result = await app.inject({ method: 'POST', url: `${base}/import`, headers: owner, payload: { ...file, expectedVersion: 2 } });
  expect(result.statusCode).toBe(200); expect(result.json().data.lines.at(-1).categoryRule).toBeUndefined();
});
it('deletion is scoped, versioned and idempotent, invalidates old previews and preserves saved costs', async () => {
  const { app, repository, data } = await setup(); await remember(app); const original = await repository.get<OdaMonth>('oda_month', data.id);
  const before = await rules(app); const ruleId = before.rules[0].id;
  const denied = await app.inject({ method: 'POST', url: `${rulesPath}/${ruleId}/remove`, headers: { 'x-demo-actor-id': DEMO_IDS.auditor }, payload: { expectedVersion: 1 } });
  expect(denied.statusCode).toBe(403);
  const crossStore = await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/expense-rules`, headers: owner }); expect(crossStore.statusCode).toBe(403);
  const request = { method: 'POST' as const, url: `${rulesPath}/${ruleId}/remove`, headers: { ...owner, 'idempotency-key': 'remove-expense-rule-test-1234' }, payload: { expectedVersion: 1 } };
  const removed = await app.inject(request); expect(removed.statusCode, removed.body).toBe(200); expect(removed.json()).toEqual({ version: 2, rules: [] });
  expect((await app.inject(request)).json()).toEqual(removed.json()); expect(await repository.get('oda_month', data.id)).toEqual(original);
  const stale = await app.inject({ method: 'POST', url: `${base}/import`, headers: owner, payload: { ...file, expectedVersion: 2, expectedExpenseRulesVersion: 1 } });
  expect(stale.json().error.code).toBe('ODA_RULES_VERSION_CONFLICT'); expect(await repository.get('oda_month', data.id)).toEqual(original);
  expect((await preview(app)).json().expenseRulesVersion).toBe(2);
  const fresh = await app.inject({ method: 'POST', url: `${base}/import`, headers: owner, payload: { ...file, expectedVersion: 2, expectedExpenseRulesVersion: 2 } }); expect(fresh.statusCode).toBe(200); expect(fresh.json().data.lines.at(-1).categoryRule).toBeUndefined();
});
