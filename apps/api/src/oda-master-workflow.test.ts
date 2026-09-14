import { MemoryRepository } from '@ofd/db';
import type { Actor, Store, UserCredential } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const origin = 'https://oda.example.test';
const token = 'MasterSetup-test-ABCdef1234567890_zyxwvutsrqponmlk';
const password = 'Master-self-chosen-123!';
const env = { NODE_ENV: 'production', APP_MODE: 'production', WORKSTATION_BRAND: 'oda',
  REPOSITORY_MODE: 'postgres', ODA_SETTLEMENT_ONLY: 'true', PROVIDER_MODE: 'disabled',
  STORAGE_MODE: 'postgres', EMAIL_PROVIDER: 'disabled', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  WEB_ORIGIN: origin, PUBLIC_APP_URL: origin, SESSION_COOKIE_SECURE: 'true',
  SESSION_SECRET: 'master-workflow-test-session-secret-32characters', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ODA_SETUP_TOKEN: token, ODA_SETUP_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(), LOG_LEVEL: 'silent' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

it('registers only a master and uses real production authentication, settlement, evidence and exports without a business entity', async () => {
  // Explicit memory injection verifies the HTTP workflow; native durability is a separate deployment check.
  const repository = new MemoryRepository();
  const app = await buildApp({ repository, env, logger: false }); apps.push(app);
  const created = await app.inject({ method: 'POST', url: '/api/v2/oda-setup',
    headers: { origin, 'x-forwarded-proto': 'https', 'x-oda-setup-token': token },
    payload: { mode: 'master-only', master: { name: '마스터 검증', email: 'master@example.test', password } } });
  expect(created.statusCode, created.body).toBe(201);
  expect(await repository.list('legal_entity')).toEqual([]);
  const actors = await repository.list<Actor>('actor');
  expect(actors).toHaveLength(1); expect(actors[0]?.role).toBe('hq_master');
  const credential = (await repository.list<UserCredential>('credential'))[0]!;
  expect(credential.mustChangePassword).toBe(false);
  expect(credential.passwordHash).not.toBe(password);
  const workspace = (await repository.list<Store>('store'))[0]!;
  expect(Object.values(workspace.business).every(value => value === '')).toBe(true);
  const login = await app.inject({ method: 'POST', url: '/api/v2/auth/login', headers: { origin },
    payload: { email: 'master@example.test', password } });
  expect(login.statusCode, login.body).toBe(200);
  const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  expect(bootstrap.json().headquarters).toBeNull();
  expect(bootstrap.json().capabilities).toContain('oda.master.manage');
  expect(bootstrap.json().stores[0].id).toBe(workspace.id);
  const base = `/api/v2/oda/${workspace.id}/2026-08`;
  const month = await app.inject({ method: 'GET', url: base, headers });
  expect(month.statusCode).toBe(200);
  expect(month.json().capabilities).toMatchObject({ edit: true, finalize: true, pay: true, reopen: true, confirmParty: null });
  const content = '날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,매출,첫 매출,110000,10000,매출,pos,M-01';
  const imported = await app.inject({ method: 'POST', url: `${base}/import`, headers,
    payload: { expectedVersion: 0, filename: 'master-sales.csv', kind: 'pos', content } });
  expect(imported.statusCode, imported.body).toBe(200);
  const overview = await app.inject({ method: 'GET', url: '/api/v2/oda/overview?month=2026-08', headers });
  expect(overview.statusCode, overview.body).toBe(200);
  expect(overview.json().rows[0]).toMatchObject({ storeId: workspace.id, month: '2026-08', sourceCount: 1 });
  expect(overview.body).not.toContain(content);
  const source = imported.json().evidence[0];
  const evidence = await app.inject({ method: 'GET', url: `${base}/evidence/${source.id}`, headers });
  expect(evidence.statusCode).toBe(200); expect(evidence.body).toBe(content);
  const report = await app.inject({ method: 'GET', url: `${base}/export.xlsx`, headers });
  expect(report.statusCode, report.body.slice(0, 100)).toBe(200);
  expect(report.headers['content-type']).toContain('spreadsheetml');
  expect(report.rawPayload.subarray(0, 2).toString()).toBe('PK');
  const stepUp = await app.inject({ method: 'POST', url: '/api/v2/auth/step-up', headers, payload: { password } });
  expect(stepUp.statusCode, stepUp.body).toBe(200);
  const adminHeaders = { origin, cookie: String(stepUp.headers['set-cookie']).split(';')[0]! };
  const accounts = await app.inject({ method: 'GET', url: '/api/v2/admin/actors', headers: adminHeaders });
  expect(accounts.statusCode, accounts.body).toBe(200);
  expect(accounts.body).not.toContain(credential.passwordHash);
  // Business details remain absent after genuine settlement writes and downloads.
  expect(await repository.list('legal_entity')).toEqual([]);
  expect(Object.values((await repository.get<Store>('store', workspace.id))!.business).every(value => value === '')).toBe(true);
});

it('keeps OFD bootstrap dependent on its real headquarters registration', async () => {
  const repository = new MemoryRepository();
  const actor: Actor = { id: 'ofd-test-master', name: 'OFD 검증', role: 'hq_master', storeIds: [], active: true, authVersion: 1 };
  await repository.commit({ changes: [{ type: 'actor', id: actor.id, value: actor, expectedVersion: null }] });
  const app = await buildApp({ repository, logger: false, env: { APP_MODE: 'test', WORKSTATION_BRAND: 'ofd', PROVIDER_MODE: 'mock' } }); apps.push(app);
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers: { 'x-demo-actor-id': actor.id } });
  expect(bootstrap.statusCode).toBe(503);
  expect(bootstrap.json().error.code).toBe('HQ_BUSINESS_MISSING');
  const admin = await app.inject({ method: 'GET', url: '/api/v2/oda/admin/stores', headers: { 'x-demo-actor-id': actor.id } });
  expect(admin.statusCode).not.toBe(200);
});
