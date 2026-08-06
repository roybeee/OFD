import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateDeploymentEnv } from './deploy/preflight.mjs';

const root = new URL('../../', import.meta.url);
async function text(path) {
  try { return await readFile(new URL(path, root), 'utf8'); } catch { return ''; }
}

const safe = {
  NODE_ENV: 'production', APP_MODE: 'production', REPOSITORY_MODE: 'postgres', SERVICE_ROLE: 'api',
  DATABASE_URL: 'postgresql://ofd:password@private-db:5432/ofd_v2',
  SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz-session',
  ENCRYPTION_KEY: Buffer.alloc(32, 0xa5).toString('base64'),
  PUBLIC_APP_URL: 'https://workstation.example.kr', WEB_ORIGIN: 'https://workstation.example.kr',
  SESSION_COOKIE_SECURE: 'true', STORAGE_MODE: 's3', S3_REGION: 'ap-northeast-2',
  S3_BUCKET: 'ofd-production-documents', S3_KMS_KEY_ID: 'alias/ofd-production',
  EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.kr', EMAIL_FROM: 'no-reply@ofd.example.kr',
  PROVIDER_MODE: 'mock', POPBILL_PRODUCTION_ENABLED: 'false', POPBILL_TAX_INVOICE_ENABLED: 'false',
  POPBILL_BANK_SYNC_ENABLED: 'false', POPBILL_SMS_ENABLED: 'false',
  API_HOST: '0.0.0.0', API_PORT: '4100', RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
};

test('deployment preflight requires a production Postgres/S3 runtime and a known role', () => {
  assert.deepEqual(validateDeploymentEnv(safe, 'api'), []);
  assert.ok(validateDeploymentEnv({ ...safe, DATABASE_URL: 'memory://demo' }, 'api').some((error) => /Postgres/i.test(error)));
  assert.ok(validateDeploymentEnv({ ...safe, APP_MODE: 'test' }, 'api').some((error) => /APP_MODE/i.test(error)));
  assert.ok(validateDeploymentEnv({ ...safe, REPOSITORY_MODE: 'memory' }, 'api').some((error) => /REPOSITORY_MODE/i.test(error)));
  assert.ok(validateDeploymentEnv(safe, 'unknown').some((error) => /SERVICE_ROLE/i.test(error)));
});

test('deployment preflight refuses unsupported per-store cutover flags instead of pretending they freeze writes', () => {
  const errors = validateDeploymentEnv({ ...safe, CUTOVER_STORE_IDS: 'store-1', WRITE_FREEZE_STORE_IDS: 'store-2' }, 'api');
  assert.ok(errors.some((error) => error.includes('CUTOVER_STORE_IDS')));
  assert.ok(errors.some((error) => error.includes('WRITE_FREEZE_STORE_IDS')));
});

test('Render blueprint defines Web proxy, private API, worker, managed Postgres, and API predeploy migration', async () => {
  const manifest = await text('render.yaml');
  assert.match(manifest, /type:\s*web[\s\S]*dockerfilePath:\s*\.\/infra\/docker\/web\.Dockerfile/);
  assert.match(manifest, /type:\s*pserv[\s\S]*dockerfilePath:\s*\.\/infra\/docker\/api\.Dockerfile/);
  assert.match(manifest, /preDeployCommand:[^\n]*preflight\.mjs migrate[^\n]*node packages\/db\/dist\/migrate\.js/);
  assert.match(manifest, /type:\s*worker[\s\S]*dockerfilePath:\s*\.\/infra\/docker\/worker\.Dockerfile/);
  assert.match(manifest, /type:\s*worker[\s\S]*preDeployCommand:[^\n]*preflight\.mjs worker/);
  assert.match(manifest, /fromDatabase:[\s\S]*property:\s*connectionString/);
  assert.match(manifest, /fromService:[\s\S]*property:\s*hostport/);
  assert.match(manifest, /healthCheckPath:\s*\/readyz/);
  assert.match(manifest, /key:\s*REPOSITORY_MODE\s*\n\s*value:\s*postgres/);
  /* 자동배포는 켠다 — 꺼두면 푸시가 라이브에 반영되지 않아 서비스 간 버전 스큐가 생긴다(2026-08 장애 재발 방지) */
  assert.match(manifest, /autoDeployTrigger:\s*commit/);
  assert.doesNotMatch(manifest, /autoDeployTrigger:\s*off/);
  assert.match(manifest, /databases:[\s\S]*postgresMajorVersion:\s*['"]16['"][\s\S]*ipAllowList:\s*\[\]/);
  assert.match(manifest, /key:\s*SESSION_SECRET\s*\n\s*sync:\s*false/);
  assert.match(manifest, /key:\s*ENCRYPTION_KEY\s*\n\s*sync:\s*false/);
  assert.doesNotMatch(manifest, /generateValue:\s*true/);
  assert.doesNotMatch(manifest, /server\/public\/v2|build:render/);
});

test('Docker runtimes use exact Web, API, and worker commands with health contracts', async () => {
  const [web, api, worker, nginx] = await Promise.all([
    text('infra/docker/web.Dockerfile'), text('infra/docker/api.Dockerfile'), text('infra/docker/worker.Dockerfile'), text('infra/nginx/default.conf.template'),
  ]);
  assert.match(web, /CMD \["nginx", "-g", "daemon off;"\]/);
  assert.match(api, /CMD \["node", "apps\/api\/dist\/server\.js"\]/);
  assert.match(worker, /CMD \["node", "apps\/worker\/dist\/main\.js"\]/);
  assert.match(web, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(api, /HEALTHCHECK[\s\S]*\/api\/v2\/health/);
  assert.match(worker, /HEALTHCHECK/);
  const readinessLocation = nginx.match(/location = \/readyz[\s\S]*?\n\s*}/)?.[0] ?? '';
  assert.match(readinessLocation, /\/api\/v2\/ready/);
  assert.doesNotMatch(readinessLocation, /\/api\/v2\/health/);
  assert.match(nginx, /location \/api\/v2\/[\s\S]*proxy_pass http:\/\/\$\{API_UPSTREAM_HOSTPORT\}/);
});

test('CI separates fail-closed production preflight from a real PostgreSQL test-mode smoke', async () => {
  const [workflow, deployScript, deployModule, rollbackScript, smokeScript] = await Promise.all([
    text('.github/workflows/v2.yml'),
    text('infra/scripts/deploy/trigger-render-deploy.mjs'),
    text('infra/scripts/deploy/render-release.mjs'),
    text('infra/scripts/deploy/rollback-render-deploy.mjs'),
    text('infra/scripts/deploy/smoke-postgres-runtime.mjs'),
  ]);
  assert.match(workflow, /env:\s*\n\s*NODE_ENV:\s*test\s*\n\s*APP_MODE:\s*test/);
  assert.match(workflow, /Production fail-closed preflight[\s\S]*NODE_ENV:\s*production[\s\S]*APP_MODE:\s*production[\s\S]*STORAGE_MODE:\s*s3[\s\S]*EMAIL_PROVIDER:\s*smtp/);
  assert.match(workflow, /npm run migrate -w @ofd\/db/);
  assert.match(workflow, /Smoke-test compiled test-mode API against migrated PostgreSQL[\s\S]*smoke-postgres-runtime\.mjs[\s\S]*APP_MODE:\s*test[\s\S]*REPOSITORY_MODE:\s*postgres/);
  assert.doesNotMatch(workflow, /smoke-production-runtime\.mjs/);
  assert.match(workflow, /environment:[\s\S]*name:\s*production/);
  assert.match(workflow, /trigger-render-deploy\.mjs/);
  assert.match(workflow, /timeout-minutes:\s*55/);
  assert.match(workflow, /render-deploy-manifest\.json[\s\S]*upload-artifact/);
  assert.doesNotMatch(workflow, /APP_MODE:\s*demo|server\/public\/v2|build:render|publish-render-assets/);
  assert.match(deployScript, /deployReleaseFromEnv/);
  assert.match(deployModule, /\['api',[\s\S]*\['worker',[\s\S]*\['web'/);
  assert.match(deployModule, /response\.status !== 201 && response\.status !== 202/);
  assert.match(deployModule, /actualCommitId !== commitId/);
  assert.match(deployModule, /previousLiveDeployId/);
  assert.match(rollbackScript, /rollbackReleaseFromEnv/);
  assert.match(smokeScript, /\/api\/v2\/ready/);
  assert.match(smokeScript, /database\.mode !== 'postgres'/);
  assert.match(smokeScript, /migrations\.applied !== migrationFiles\.length/);
});
