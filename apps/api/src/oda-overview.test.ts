import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import { createOdaMonth, calculateOdaMonth, parseOdaCsv, type Actor, type Store } from '@ofd/domain';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const month = '2026-08';
const url = `/api/v2/oda/overview?month=${month}`;
const master = { 'x-demo-actor-id': DEMO_IDS.master };
async function setup(brand = 'oda') {
  const repository = createDemoRepository();
  const app = await buildApp({ repository, logger: false, env: { APP_MODE: 'test', WORKSTATION_BRAND: brand, PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' } });
  apps.push(app); return { repository, app };
}
function record(storeId = DEMO_IDS.storeDoksan, at = month) {
  const result = createOdaMonth(storeId, at); result.version = 1;
  result.policy.vatBasis = 'gross';
  result.lines = parseOdaCsv(`날짜,유형,내용,금액,부가세,분류,채널,거래ID\n${at}-01,매출,월매출,11000000,1000000,매출,pos,P1`, { sourceId: 'source', kind: 'revenue', channel: 'pos' }).lines;
  result.sources = [{ id: 'source', fileName: 'sales.csv', kind: 'pos', sha256: 'private-hash', sizeBytes: 999999, rowCount: 1, mimeType: 'text/csv', uploadedAt: new Date().toISOString(), uploadedBy: 'operator' }];
  return { ...result, evidenceBytes: { source: 'PRIVATE ORIGINAL FILE' } };
}
it('returns missing data as unknown, filters inactive stores, and never creates a monthly record on read', async () => {
  const { app, repository } = await setup();
  const closed = (await repository.get<Store>('store', DEMO_IDS.storeHapjeong))!;
  await repository.commit({ changes: [{ type: 'store', id: closed.id, storeId: closed.id, expectedVersion: closed.version, value: { ...closed, active: false, version: closed.version + 1 } }] });
  const response = await app.inject({ method: 'GET', url, headers: master });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rows).toHaveLength(2);
  expect(response.json().rows.some((row: { storeId: string }) => row.storeId === closed.id)).toBe(false);
  expect(response.json().rows[0]).toMatchObject({ status: 'not_started', revenue: null, profit: null, nextAction: '자료 넣기' });
  expect(await repository.list('oda_month')).toEqual([]);
});
it('honors assigned scope and month, rejects invalid parameters and unsupported roles, and stays absent on OFD', async () => {
  const { app, repository } = await setup();
  const finance = (await repository.get<Actor>('actor', DEMO_IDS.finance))!;
  await repository.commit({ changes: [{ type: 'actor', id: finance.id, expectedVersion: 1, value: { ...finance, storeIds: [DEMO_IDS.storeHapjeong] } }] });
  for (const [actor, storeId] of [[DEMO_IDS.owner, DEMO_IDS.storeDoksan], [finance.id, DEMO_IDS.storeHapjeong]]) {
    const response = await app.inject({ method: 'GET', url, headers: { 'x-demo-actor-id': actor } });
    expect(response.json().rows.map((row: { storeId: string }) => row.storeId)).toEqual([storeId]);
  }
  expect((await app.inject({ method: 'GET', url, headers: { 'x-demo-actor-id': DEMO_IDS.staff } })).statusCode).toBe(403);
  for (const query of ['month=2026-13', 'month=2026-08&page=0', 'month=2026-08&storeIds=foreign'])
    expect((await app.inject({ method: 'GET', url: '/api/v2/oda/overview?' + query, headers: master })).statusCode).toBe(422);
  const other = await setup('ofd'); expect((await other.app.inject({ method: 'GET', url, headers: master })).statusCode).toBe(404);
});
it('uses the confirmed snapshot for locked amounts, strips original bytes and line details, and uses current draft amounts after reopening', async () => {
  const { app, repository } = await setup();
  const data = record();
  const frozen = { ...calculateOdaMonth(data), revenue: 42000000, profit: 32000000, payableB: 15950000 };
  data.history.push({ id: 'snapshot', version: 1, reason: '월 정산 확정', summary: frozen, lines: [], sources: [], policy: data.policy, actorId: 'a', actorName: 'private operator', at: new Date().toISOString() });
  data.status = 'finalized';
  await repository.commit({ changes: [{ type: 'oda_month', id: data.id, storeId: data.storeId, expectedVersion: null, value: data }] });
  let response = await app.inject({ method: 'GET', url, headers: master });
  expect(response.json().rows.find((row: { storeId: string }) => row.storeId === data.storeId)).toMatchObject({ status: 'finalized', revenue: 42000000, profit: 32000000, payableB: 15950000, nextAction: '지급 기록하기' });
  for (const secret of ['PRIVATE ORIGINAL', 'private-hash', 'private operator', 'evidenceBytes', 'sales.csv']) expect(response.body).not.toContain(secret);
  const projection = await repository.listOdaOverviewMonths(month, [data.storeId]);
  expect(projection[0]).not.toHaveProperty('evidenceBytes'); expect(projection[0]).not.toHaveProperty('history');
  data.status = 'draft'; data.version = 2;
  await repository.commit({ changes: [{ type: 'oda_month', id: data.id, storeId: data.storeId, expectedVersion: 1, value: data }] });
  response = await app.inject({ method: 'GET', url, headers: master });
  expect(response.json().rows.find((row: { storeId: string }) => row.storeId === data.storeId).revenue).toBe(11000000);
  const otherMonth = await app.inject({ method: 'GET', url: '/api/v2/oda/overview?month=2026-07', headers: master });
  expect(otherMonth.json().rows.every((row: { status: string }) => row.status === 'not_started')).toBe(true);
});
it('bounds each response to twenty stores with stable pages and isolates a broken confirmation to its own row', async () => {
  const { app, repository } = await setup();
  const template = (await repository.get<Store>('store', DEMO_IDS.storeDoksan))!;
  const changes = Array.from({ length: 23 }, (_, index) => { const id = `overview-${index}`; return { type: 'store' as const, id, storeId: id, expectedVersion: null, value: { ...template, id, code: id, name: `매장 ${String(index).padStart(2, '0')}`, version: 1 } }; });
  await repository.commit({ changes });
  const broken = record(); broken.status = 'finalized';
  await repository.commit({ changes: [{ type: 'oda_month', id: broken.id, storeId: broken.storeId, expectedVersion: null, value: broken }] });
  const pages = await Promise.all([1, 2].map(page => app.inject({ method: 'GET', url: `${url}&page=${page}`, headers: master })));
  expect(pages[0]!.json().rows).toHaveLength(20); expect(pages[1]!.json().rows).toHaveLength(6);
  const rows = pages.flatMap(page => page.json().rows);
  expect(new Set(rows.map(row => row.storeId)).size).toBe(26);
  expect(rows.find(row => row.storeId === broken.storeId)).toMatchObject({ status: 'error', profit: null });
});
