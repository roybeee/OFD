import { MemoryRepository } from '@ofd/db';
import type { Actor, Store, UserCredential } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';
import { registerOdaSetup, isOdaSetupEnabled } from './oda-setup.ts';

const origin = 'http://127.0.0.1:4175';
const token = 'setup-key-for-isolated-tests-01234567890123456789';
const password = 'Initial-pass123!';
const env = { APP_MODE: 'local', NODE_ENV: 'production', WORKSTATION_BRAND: 'oda', ODA_LOCAL_ENABLED: 'true',
  REPOSITORY_MODE: 'postgres', DATABASE_URL: 'postgresql://oda:local@db/oda_local', WEB_ORIGIN: origin, PUBLIC_APP_URL: origin,
  SESSION_SECRET: 'local-session-key-for-tests-01234567890123456789', ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  ODA_SETUP_TOKEN: token, PROVIDER_MODE: 'mock', STORAGE_MODE: 'mock', EMAIL_PROVIDER: 'mock', LOG_LEVEL: 'silent' };
const headers = { host: '127.0.0.1:4175', origin };
const business = { businessNumber: '1234567890', legalName: '테스트 본사', representativeName: '홍대표', address: '검증용 주소',
  businessType: '음식점업', businessCategory: '피자', email: 'hq@example.test' };
const payload = () => ({ token, headquarters: business,
  store: { code: 'ODA-TEST', name: '검증 전용 매장', openDate: '2026-08-15', business: { ...business, businessNumber: '9876543210', legalName: '매장 사업자' } },
  master: { name: '관리자', email: 'master@example.test', password },
  operatorA: { name: '운영자', email: 'owner@example.test', password },
  partnerB: { name: '지원자', email: 'partner@example.test', password },
});
const apps: FastifyInstance[] = [];
async function setup() {
  const repository = new MemoryRepository(); // Explicit injection tests API contract; does not claim real PostgreSQL durability.
  const app = await buildApp({ repository, env, logger: false }); apps.push(app); return { app, repository };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

describe('ODA one-time local setup', () => {
  it('provisions distinct parties atomically and requires real login plus first password change', async () => {
    const { app, repository } = await setup();
    const initial = await app.inject({ method: 'GET', url: '/api/v2/oda-setup', headers });
    expect(initial.json()).toEqual({ enabled: true, initialized: false });
    const created = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers, payload: payload() });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toEqual({ created: true, storeName: '검증 전용 매장' });
    expect(created.body).not.toContain(password);
    expect(created.body).not.toContain(token);
    const store = (await repository.list<Store>('store'))[0]!;
    const actors = await repository.list<Actor>('actor');
    expect(store.business.legalName).toBe('매장 사업자');
    expect(actors.find(actor => actor.role === 'hq_finance')?.storeIds).toEqual([store.id]);
    expect(actors.find(actor => actor.role === 'store_owner')?.storeIds).toEqual([store.id]);
    const credentials = await repository.list<UserCredential>('credential');
    expect(credentials).toHaveLength(3);
    expect(credentials.every(item => item.mustChangePassword && item.passwordHash !== password)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v2/oda-setup', headers })).json().initialized).toBe(true);
    const forged = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers: { ...headers, 'x-demo-actor-id': actors[0]!.id } });
    expect(forged.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v2/auth/login', headers,
      payload: { email: 'owner@example.test', password } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const blocked = await app.inject({ method: 'GET', url: `/api/v2/oda/${store.id}/2026-08`, headers: { ...headers, cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await app.inject({ method: 'POST', url: '/api/v2/auth/change-password', headers: { ...headers, cookie },
      payload: { currentPassword: password, newPassword: 'Owner-changed456!' } });
    expect(changed.statusCode, changed.body).toBe(200);
    const session = String(changed.headers['set-cookie']).split(';')[0]!;
    const month = await app.inject({ method: 'GET', url: `/api/v2/oda/${store.id}/2026-08`, headers: { ...headers, cookie: session } });
    expect(month.statusCode, month.body).toBe(200);
    expect(month.json().data.policy.partialMonth).toBe(true);
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v2/bootstrap', headers: { ...headers, cookie: session } });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(JSON.stringify(bootstrap.json())).not.toContain(password);
  });

  it('refuses wrong token, cross-site and missing-origin writes without creating any records', async () => {
    const { app, repository } = await setup();
    for (const [requestHeaders, body] of [
      [headers, { ...payload(), token: 'wrong-key-for-tests-0123456789012345678901' }],
      [{ ...headers, origin: 'https://untrusted.example' }, payload()],
      [{ host: headers.host }, payload()],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: requestHeaders, payload: body });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(password);
    }
    expect(await repository.list('actor')).toHaveLength(0);
    expect(await repository.list('store')).toHaveLength(0);
  });

  it('validates real calendar dates, distinct emails, and password strength before any write', async () => {
    const { app, repository } = await setup();
    for (const input of [
      { ...payload(), store: { ...payload().store, openDate: '2026-02-30' } },
      { ...payload(), partnerB: { ...payload().partnerB, email: 'OWNER@example.test' } },
      { ...payload(), partnerB: { ...payload().partnerB, password: 'weakpasswordonly' } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers, payload: input });
      expect(response.statusCode, response.body).toBe(422);
      expect(await repository.list('actor')).toHaveLength(0);
    }
  });

  it('serializes concurrent first registrations and preserves the first completed accounts', async () => {
    const { app, repository } = await setup();
    const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers, payload: payload() })));
    expect(results.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(await repository.list('actor')).toHaveLength(3);
    expect(await repository.list('credential')).toHaveLength(3);
    expect(await repository.list('store')).toHaveLength(1);
  });

  it('does not expose the initial registration endpoint in test mode', async () => {
    const repository = new MemoryRepository();
    const app = await buildApp({ repository, env: { APP_MODE: 'test', ODA_LOCAL_ENABLED: 'true', ODA_SETUP_TOKEN: token,
      WORKSTATION_BRAND: 'oda', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers, payload: payload() });
    expect([401, 404]).toContain(response.statusCode);
    expect(await repository.list('actor')).toHaveLength(0);
  });
});

describe('ODA authenticated online first setup', () => {
  const cloudToken = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefg';
  const cloudOrigin = 'https://oda.example.test';
  const cloudEnv = { APP_MODE: 'production', ODA_SETTLEMENT_ONLY: 'true', WORKSTATION_BRAND: 'oda',
    WEB_ORIGIN: cloudOrigin, PUBLIC_APP_URL: cloudOrigin, ODA_SETUP_TOKEN: cloudToken,
    ODA_SETUP_EXPIRES_AT: '2031-01-02T03:04:05.000Z' };
  const cloudHeaders = { origin: cloudOrigin, host: 'oda-api.internal', 'x-forwarded-proto': 'https', 'x-oda-setup-token': cloudToken };
  const cloudPayload = () => { const { token: _token, ...details } = payload(); return details; };
  const cloudSetup = (config: NodeJS.ProcessEnv = cloudEnv, repository = new MemoryRepository()) => {
    const messages: string[] = [];
    const app = Fastify({ trustProxy: true, logger: { level: 'info', stream: { write: (message: string) => messages.push(message) } } });
    app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 422)
      .send({ error: { code: (error as { code?: string }).code ?? 'INVALID_REQUEST' } }));
    apps.push(app);
    registerOdaSetup(app, repository, config);
    return { app, repository, messages };
  };

  it('only registers online initialization for the explicit ODA production profile', () => {
    expect(isOdaSetupEnabled(cloudEnv)).toBe(true);
    for (const config of [{ ...cloudEnv, WORKSTATION_BRAND: 'ofd' }, { ...cloudEnv, ODA_SETTLEMENT_ONLY: 'false' },
      { ...cloudEnv, APP_MODE: 'test' }, { ...cloudEnv, ODA_SETUP_TOKEN: '' }]) expect(isOdaSetupEnabled(config)).toBe(false);
    for (const config of [{ ...cloudEnv, ODA_SETUP_TOKEN: 'x'.repeat(43) }, { ...cloudEnv, ODA_SETUP_TOKEN: cloudToken.slice(0, 32) },
      { ...cloudEnv, ODA_SETUP_EXPIRES_AT: '' }, { ...cloudEnv, ODA_SETUP_EXPIRES_AT: '2031-02-30T03:04:05Z' },
      { ...cloudEnv, WEB_ORIGIN: 'http://oda.example.test', PUBLIC_APP_URL: 'http://oda.example.test' },
      { ...cloudEnv, PUBLIC_APP_URL: 'https://other.example.test' }, { ...cloudEnv, WEB_ORIGIN: `${cloudOrigin}/path` }])
      expect(() => cloudSetup(config)).toThrow();
  });

  it('requires the secret header, HTTPS and exact origin; body and URL tokens cannot authorize setup', async () => {
    const { app, repository, messages } = cloudSetup();
    const status = await app.inject({ method: 'GET', url: '/api/v2/oda-setup' });
    expect(status.json()).toEqual({ enabled: true, initialized: false, setupMode: 'online', expiresAt: cloudEnv.ODA_SETUP_EXPIRES_AT, expired: false });
    expect(status.body).not.toContain(cloudToken);
    const { 'x-oda-setup-token': _secret, ...noToken } = cloudHeaders;
    for (const request of [
      { headers: noToken, payload: cloudPayload() },
      { headers: noToken, payload: { ...cloudPayload(), token: cloudToken } },
      { headers: { ...cloudHeaders, 'x-oda-setup-token': 'incorrect' }, payload: cloudPayload() },
      { headers: { ...cloudHeaders, origin: `${cloudOrigin}.attacker.test` }, payload: cloudPayload() },
      { headers: { ...cloudHeaders, origin: '' }, payload: cloudPayload() },
      { headers: { ...cloudHeaders, 'x-forwarded-proto': 'http' }, payload: cloudPayload() },
      { headers: cloudHeaders, payload: { ...cloudPayload(), token: cloudToken } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', ...request });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(cloudToken);
      expect(response.body).not.toContain(password);
    }
    const query = await app.inject({ method: 'POST', url: '/api/v2/oda-setup?setup=not-a-secret', headers: cloudHeaders, payload: cloudPayload() });
    expect(query.statusCode).toBe(400);
    expect(await repository.list('actor')).toHaveLength(0);
    expect(messages.join('')).not.toContain(cloudToken);
    expect(messages.join('')).not.toContain(password);
  });

  it('allows a single atomic registration and never reuses a setup secret after initialization or restart', async () => {
    const { app, repository } = cloudSetup();
    const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: cloudHeaders, payload: cloudPayload() })));
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect(await repository.list('actor')).toHaveLength(3);
    expect(await repository.list('credential')).toHaveLength(3);
    const restarted = cloudSetup({ ...cloudEnv, ODA_SETUP_EXPIRES_AT: '2001-01-01T00:00:00Z' }, repository).app;
    const status = await restarted.inject({ method: 'GET', url: '/api/v2/oda-setup' });
    expect(status.json()).toMatchObject({ initialized: true, expired: false });
    const reused = await restarted.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: cloudHeaders, payload: cloudPayload() });
    expect(reused.statusCode).toBe(409);
    expect(await repository.list('store')).toHaveLength(1);
  });

  it('checks expiry on each submission, including expiry after the wizard was opened', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2031-01-02T03:04:04Z'));
    const { app, repository } = cloudSetup();
    expect((await app.inject({ method: 'GET', url: '/api/v2/oda-setup' })).json().expired).toBe(false);
    clock.mockReturnValue(Date.parse(cloudEnv.ODA_SETUP_EXPIRES_AT));
    const response = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: cloudHeaders, payload: cloudPayload() });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ODA_SETUP_EXPIRED');
    expect(await repository.list('actor')).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/v2/oda-setup' })).json().expired).toBe(true);
  });

  it('runs through production middleware and keeps existing accounts usable after removing the setup key', async () => {
    const repository = new MemoryRepository();
    const productionEnv = { ...cloudEnv, NODE_ENV: 'production', REPOSITORY_MODE: 'postgres',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused', SESSION_COOKIE_SECURE: 'true',
      SESSION_SECRET: 'online-session-test-0123456789012345678901234567', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      PROVIDER_MODE: 'disabled', STORAGE_MODE: 'postgres', EMAIL_PROVIDER: 'disabled', LOG_LEVEL: 'silent' };
    const app = await buildApp({ env: productionEnv, repository, logger: false }); apps.push(app);
    app.addHook('onSend', async (request, _reply, body) => {
      if (request.url === '/api/v2/oda-setup' && request.method === 'POST') {
        expect((request as { rawBody?: string }).rawBody).toBeUndefined();
        expect(request.headers['x-oda-setup-token']).toBeUndefined();
        expect(JSON.stringify(request.body)).not.toContain(cloudToken);
      }
      return body;
    });
    const initial = await app.inject({ method: 'GET', url: '/api/v2/oda-setup' });
    expect(initial.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: cloudHeaders, payload: cloudPayload() });
    expect(created.statusCode, created.body).toBe(201);
    const restarted = await buildApp({ env: { ...productionEnv, ODA_SETUP_TOKEN: '', ODA_SETUP_EXPIRES_AT: '' }, repository, logger: false }); apps.push(restarted);
    const setupClosed = await restarted.inject({ method: 'POST', url: '/api/v2/oda-setup', headers: cloudHeaders, payload: cloudPayload() });
    expect([401, 404]).toContain(setupClosed.statusCode);
    const login = await restarted.inject({ method: 'POST', url: '/api/v2/auth/login', headers: { origin: cloudOrigin },
      payload: { email: 'owner@example.test', password } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);
    expect(String(login.headers['set-cookie'])).toContain('Secure');
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    expect(await repository.list('actor')).toHaveLength(3);
  });
});
