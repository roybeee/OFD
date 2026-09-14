import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryRepository } from '@ofd/db';
import type { Actor, Store } from '@ofd/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { registerOdaAdminRoutes } from './oda-admin-routes.ts';

const path = '/api/v2/oda/admin/stores';
const business = { businessNumber: '1234567890', legalName: '검증매장', representativeName: '검증대표', address: '검증주소',
  businessType: '음식점업', businessCategory: '피자', email: 'business@example.test' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup() {
  const repository = new MemoryRepository();
  const master: Actor = { id: 'master', name: '관리자', role: 'hq_master', storeIds: [], active: true,
    mfaVerified: true, mfaVerifiedAt: new Date().toISOString() };
  const actors: Record<string, Actor> = {
    master,
    owner: { ...master, id: 'owner', role: 'store_owner', storeIds: ['assigned'] },
    partner: { ...master, id: 'partner', role: 'hq_finance', storeIds: ['assigned'] },
    auditor: { ...master, id: 'auditor', role: 'auditor' },
    scopedMaster: { ...master, id: 'scoped-master', storeIds: ['assigned'] },
    inactive: { ...master, id: 'inactive', active: false },
    stale: { ...master, id: 'stale', mfaVerifiedAt: new Date(Date.now() - 6 * 60_000).toISOString() },
  };
  const app = Fastify({ logger: false }); apps.push(app);
  // Isolated route tests inject the actor after authentication; production sessions are covered by app integration tests.
  app.addHook('preHandler', async request => {
    const actor = actors[String(request.headers['x-test-actor'] ?? '')];
    if (actor) request.actor = actor;
  });
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 422)
    .send({ error: { code: (error as { code?: string }).code ?? 'VALIDATION_ERROR' } }));
  registerOdaAdminRoutes(app, repository);
  return { app, repository };
}
const headers = (key: string, actor = 'master') => ({ 'x-test-actor': actor, 'idempotency-key': key });

describe('ODA global master store administration', () => {
  it('denies unauthenticated, assigned, inactive and non-master actors for every admin route', async () => {
    const { app, repository } = await setup();
    for (const actor of ['', 'owner', 'partner', 'auditor', 'scopedMaster', 'inactive']) {
      for (const method of ['GET', 'POST', 'PATCH'] as const) {
        const response = await app.inject({ method, url: path, headers: headers('denied-mutation', actor),
          ...(method === 'GET' ? {} : { payload: { name: '읽으면안되는매장' } }) });
        expect(response.statusCode).toBe(actor ? 403 : 401);
      }
    }
    expect(await repository.list('store')).toHaveLength(0);
  });

  it('allows a read-only master session but requires recent step-up and idempotency for changes', async () => {
    const { app, repository } = await setup();
    expect((await app.inject({ method: 'GET', url: path, headers: headers('read-only-test', 'stale') })).statusCode).toBe(200);
    const stale = await app.inject({ method: 'POST', url: path, headers: headers('stale-auth-test', 'stale'), payload: { name: '검증매장' } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('STEP_UP_REQUIRED');
    const noKey = await app.inject({ method: 'POST', url: path, headers: { 'x-test-actor': 'master' }, payload: { name: '검증매장' } });
    expect(noKey.statusCode).toBe(428);
    expect(await repository.list('store')).toHaveLength(0);
  });

  it('creates a named workspace without business information and replays retries without duplicating stores', async () => {
    const { app, repository } = await setup();
    const input = { method: 'POST' as const, url: path, headers: headers('create-one-workspace'), payload: { name: '검증 작업공간' } };
    const created = await app.inject(input);
    expect(created.statusCode, created.body).toBe(201);
    const store = created.json().store as Store;
    expect(store).toMatchObject({ name: '검증 작업공간', active: true, version: 1, odaWorkspace: true });
    expect(store.code).toMatch(/^ODA_[A-F0-9]{16}$/);
    expect(Object.values(store.business)).toEqual(['', '', '', '', '', '', '']);
    const replay = await app.inject(input);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().store.id).toBe(store.id);
    const conflicting = await app.inject({ ...input, payload: { name: '다른작업공간' } });
    expect(conflicting.statusCode).toBe(409);
    expect(await repository.list('store')).toHaveLength(1);
    expect(await repository.list('legal_entity')).toHaveLength(0);
    expect((await repository.listAudit()).filter(event => event.action === 'oda.store_created')).toHaveLength(1);
    const listing = await app.inject({ method: 'GET', url: path, headers: headers('read-workspaces') });
    expect(listing.json().stores).toEqual([store]);
  });

  it('validates optional business information completely and refuses ambiguous partial updates', async () => {
    const { app, repository } = await setup();
    for (const [index, payload] of [{ name: '' }, { name: '매장', code: 'A B' }, { name: '매장', business: { legalName: '부분상호' } },
      { name: '매장', business: { ...business, businessNumber: '' } }, { name: '매장', openDate: '2026-02-30' }].entries()) {
      const response = await app.inject({ method: 'POST', url: path, headers: headers(`invalid-store-${index}`), payload });
      expect(response.statusCode).toBe(422);
    }
    expect(await repository.list('store')).toHaveLength(0);
    const response = await app.inject({ method: 'POST', url: path, headers: headers('valid-business-store'),
      payload: { name: '검증매장', code: 'ODA-REAL', business, openDate: '2026-09-14' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().store).toMatchObject({ odaWorkspace: false, business, roadAddress: business.address, openDate: '2026-09-14' });
  });

  it('serializes case-insensitive duplicate codes and optimistic updates while preserving audit versions', async () => {
    const { app, repository } = await setup();
    const results = await Promise.all(['oda-test', 'ODA-TEST'].map((code, index) => app.inject({ method: 'POST', url: path,
      headers: headers(`concurrent-code-${index}`), payload: { name: '동시등록매장', code } })));
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    const [original] = await repository.list<Store>('store');
    const changed = await app.inject({ method: 'PATCH', url: path, headers: headers('update-store-business'),
      payload: { id: original!.id, expectedVersion: 1, name: '실정보입력매장', business } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().store).toMatchObject({ version: 2, odaWorkspace: false, name: '실정보입력매장', business });
    const stale = await app.inject({ method: 'PATCH', url: path, headers: headers('stale-store-version'),
      payload: { id: original!.id, expectedVersion: 1, name: '덮어쓰기실패' } });
    expect(stale.statusCode).toBe(409);
    const next = await app.inject({ method: 'PATCH', url: path, headers: headers('deactivate-store-record'),
      payload: { id: original!.id, expectedVersion: 2, active: false } });
    expect(next.json().store).toMatchObject({ version: 3, active: false, business, name: '실정보입력매장' });
    const audits = (await repository.listAudit()).filter(event => event.action === 'oda.store_updated');
    expect(audits).toHaveLength(2);
    expect(audits.find(event => (event.after as Store).version === 2)!.before).toMatchObject({ version: 1, odaWorkspace: true });
    expect(audits.find(event => (event.after as Store).version === 2)!.after).toMatchObject({ version: 2, odaWorkspace: false });
  });
});
