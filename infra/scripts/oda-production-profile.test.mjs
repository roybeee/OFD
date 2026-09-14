import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionEnv } from './validate-production-env.mjs';
import { validateDeploymentEnv } from './deploy/preflight.mjs';
import { readSharedTarget } from './deploy/oda-shared-guard.mjs';

const env = { NODE_ENV: 'production', APP_MODE: 'production', WORKSTATION_BRAND: 'oda', REPOSITORY_MODE: 'postgres',
  ODA_SETTLEMENT_ONLY: 'true', PROVIDER_MODE: 'disabled', STORAGE_MODE: 'postgres', EMAIL_PROVIDER: 'disabled',
  DATABASE_URL: 'postgresql://oda_app:unused@private-db/oda_production', WEB_ORIGIN: 'https://oda.example.com', PUBLIC_APP_URL: 'https://oda.example.com',
  SESSION_COOKIE_SECURE: 'true', SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz-session', ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ODA_SHARED_DATABASE: 'true', ODA_DB_NAME: 'oda_production', ODA_DB_ROLE: 'oda_app', ODA_PEER_DB_NAME: 'ofd_postgres',
  ODA_PEER_DB_ROLES: 'ofd_api_runtime', ODA_PEER_WEB_ORIGIN: 'https://ofd.example.com', DB_POOL_MAX: '3',
  RELEASE_SHA: 'a'.repeat(40), API_HOST: '0.0.0.0', API_PORT: '4100', SERVICE_ROLE: 'api' };

test('explicit ODA profile deploys without unrelated S3/SMTP but keeps every general production check', () => {
  assert.deepEqual(validateProductionEnv(env), []);
  assert.deepEqual(validateDeploymentEnv(env, 'api'), []);
  assert.doesNotThrow(() => readSharedTarget(env));
  for (const changed of [{ WORKSTATION_BRAND: 'ofd' }, { APP_MODE: 'local' }, { NODE_ENV: 'development' }, { REPOSITORY_MODE: 'memory' },
    { PROVIDER_MODE: 'mock' }, { STORAGE_MODE: 'mock' }, { EMAIL_PROVIDER: 'mock' }, { WEB_ORIGIN: 'http://oda.example.com' },
    { PUBLIC_APP_URL: 'https://other.example.com' }, { SESSION_COOKIE_SECURE: 'false' }, { SESSION_SECRET: 'short' },
    { ENCRYPTION_KEY: 'bad' }, { POPBILL_BANK_SYNC_ENABLED: 'true' }, { RELEASE_SHA: '' }, { ODA_SETTLEMENT_ONLY: undefined }]) {
    assert.ok(validateDeploymentEnv({ ...env, ...changed }, 'api').length > 0, JSON.stringify(changed));
  }
});

test('ODA profile cannot start a worker, select OFD credentials or omit peer isolation settings', () => {
  assert.ok(validateDeploymentEnv(env, 'worker').some(x => x.includes('worker')));
  for (const changed of [{ DATABASE_URL: 'postgresql://ofd_postgres_user:unused@private-db/ofd_postgres' },
    { ODA_PEER_DB_ROLES: '' }, { ODA_DB_ROLE: 'ofd_postgres_user' }, { ODA_PEER_WEB_ORIGIN: env.WEB_ORIGIN },
    { DB_POOL_MAX: '20' }, { PROVIDER_MODE: 'mock' }, { EMAIL_PROVIDER: 'smtp' }, { SERVICE_ROLE: 'worker' }]) {
    assert.throws(() => readSharedTarget({ ...env, ...changed }), JSON.stringify(changed));
  }
});
