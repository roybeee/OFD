import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductionEnv } from './validate-production-env.mjs';

const safeProduction = {
  NODE_ENV: 'production',
  APP_MODE: 'production',
  DATABASE_URL: 'postgresql://ofd:strong-password@db.internal/ofd',
  SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz-session',
  ENCRYPTION_KEY: Buffer.alloc(32, 0xa5).toString('base64'),
  PUBLIC_APP_URL: 'https://workstation.example.kr',
  WEB_ORIGIN: 'https://workstation.example.kr',
  SESSION_COOKIE_SECURE: 'true',
  STORAGE_MODE: 's3',
  S3_REGION: 'ap-northeast-2',
  S3_BUCKET: 'ofd-production-documents',
  S3_ACCESS_KEY_ID: 'AKIATESTVALUE',
  S3_SECRET_ACCESS_KEY: 'strong-production-value',
  S3_KMS_KEY_ID: 'alias/ofd-production',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.kr',
  EMAIL_FROM: 'no-reply@ofd.example.kr',
  PROVIDER_MODE: 'mock',
  POPBILL_PRODUCTION_ENABLED: 'false',
  POPBILL_TAX_INVOICE_ENABLED: 'false',
  POPBILL_BANK_SYNC_ENABLED: 'false',
  POPBILL_SMS_ENABLED: 'false'
};

const popbillCommon = {
  PROVIDER_MODE: 'production',
  POPBILL_PRODUCTION_ENABLED: 'true',
  POPBILL_LINK_ID: 'ofd-production-link',
  POPBILL_SECRET_KEY: 'popbill-production-key',
  POPBILL_CORP_NUM: '1234567890',
  POPBILL_USER_ID: 'ofd-master',
  POPBILL_WEBHOOK_API_KEY: 'popbill-webhook-api-key'
};

test('permits a production deployment while external providers remain disabled', () => {
  assert.deepEqual(validateProductionEnv(safeProduction), []);
});

test('rejects demo or missing app mode in a production process', () => {
  const missing = { ...safeProduction };
  delete missing.APP_MODE;
  assert.ok(validateProductionEnv(missing).includes('APP_MODE must be production when NODE_ENV=production'));
  assert.ok(validateProductionEnv({ ...safeProduction, APP_MODE: 'demo' })
    .includes('APP_MODE must be production when NODE_ENV=production'));
});

test('requires ENCRYPTION_KEY to decode to exactly 32 bytes', () => {
  const errors = validateProductionEnv({ ...safeProduction, ENCRYPTION_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789-encryption' });
  assert.ok(errors.includes('ENCRYPTION_KEY must be base64 for exactly 32 bytes'));
});

test('rejects the historical encryption key that was published in the example environment', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
  });
  assert.ok(errors.includes('ENCRYPTION_KEY uses a known development key'));
});

test('requires real object storage and SMTP independently of Popbill', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    STORAGE_MODE: 'mock',
    EMAIL_PROVIDER: 'mock',
    SMTP_HOST: '',
    EMAIL_FROM: ''
  });

  assert.ok(errors.includes('STORAGE_MODE must be s3 when NODE_ENV=production'));
  assert.ok(errors.includes('EMAIL_PROVIDER must be smtp when NODE_ENV=production'));
  assert.ok(errors.includes('production: SMTP_HOST is required'));
  assert.ok(errors.includes('production: EMAIL_FROM is required'));
});

test('allows AWS workload identity but requires credentials for an explicit S3-compatible endpoint', () => {
  const workloadIdentity = { ...safeProduction };
  delete workloadIdentity.S3_ACCESS_KEY_ID;
  delete workloadIdentity.S3_SECRET_ACCESS_KEY;
  assert.deepEqual(validateProductionEnv(workloadIdentity), []);

  const errors = validateProductionEnv({ ...workloadIdentity, S3_ENDPOINT: 'https://minio.internal' });
  assert.ok(errors.includes('S3-compatible endpoint: S3_ACCESS_KEY_ID is required'));
  assert.ok(errors.includes('S3-compatible endpoint: S3_SECRET_ACCESS_KEY is required'));
});

test('fails closed when Popbill is requested without every operational gate', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    PROVIDER_MODE: 'production',
    POPBILL_PRODUCTION_ENABLED: 'true',
    POPBILL_TAX_INVOICE_ENABLED: 'true'
  });

  assert.ok(errors.some((error) => error.includes('POPBILL_LINK_ID')));
  assert.ok(errors.some((error) => error.includes('POPBILL_CERTIFICATE_CONFIGURED')));
  assert.ok(!errors.some((error) => error.includes('POPBILL_BANK_ACCOUNT_AUTHORIZED')));
});

test('permits Popbill only after credentials, certificate and bank authorization are complete', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    ...popbillCommon,
    POPBILL_TAX_INVOICE_ENABLED: 'true',
    POPBILL_BANK_SYNC_ENABLED: 'true',
    POPBILL_SMS_ENABLED: 'true',
    POPBILL_CERTIFICATE_CONFIGURED: 'true',
    POPBILL_BANK_ACCOUNT_AUTHORIZED: 'true',
    POPBILL_BANK_CODE: '004',
    POPBILL_BANK_ACCOUNT: '000000000000',
    POPBILL_SMS_SENDER: '0212345678'
  });
  assert.deepEqual(errors, []);
});

test('tax invoice can be enabled without bank or SMS authorization', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    ...popbillCommon,
    POPBILL_TAX_INVOICE_ENABLED: 'true',
    POPBILL_CERTIFICATE_CONFIGURED: 'true'
  });
  assert.deepEqual(errors, []);
});

test('bank sync requires only its account authorization and account identity', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    ...popbillCommon,
    POPBILL_BANK_SYNC_ENABLED: 'true',
    POPBILL_BANK_ACCOUNT_AUTHORIZED: 'true',
    POPBILL_BANK_CODE: '004',
    POPBILL_BANK_ACCOUNT: '000000000000'
  });
  assert.deepEqual(errors, []);
});

test('SMS requires an approved sender but not tax certificate or bank authorization', () => {
  const errors = validateProductionEnv({
    ...safeProduction,
    ...popbillCommon,
    POPBILL_SMS_ENABLED: 'true',
    POPBILL_SMS_SENDER: '0212345678'
  });
  assert.deepEqual(errors, []);
});

test('rejects production provider mode without the explicit kill-switch release', () => {
  const errors = validateProductionEnv({ ...safeProduction, PROVIDER_MODE: 'production' });
  assert.ok(errors.includes('PROVIDER_MODE=production requires POPBILL_PRODUCTION_ENABLED=true'));
});

test('does not enforce production secrets for local development', () => {
  assert.deepEqual(validateProductionEnv({ NODE_ENV: 'development' }), []);
});

test('accepts both official libpq schemes — Render fromDatabase provides postgres://', () => {
  /* 2026-08-07 배포 장애 회귀 방지: Render의 connectionString은 postgres:// 스킴이고
   * pg 라이브러리는 둘 다 받는다. 검증이 postgresql://만 고집하면 pre-deploy가 스스로 실패한다. */
  assert.deepEqual(validateProductionEnv({ ...safeProduction, DATABASE_URL: 'postgres://ofd:pw@dpg-abc123-a/ofd' }), []);
  assert.deepEqual(validateProductionEnv({ ...safeProduction, DATABASE_URL: '  postgresql://ofd:pw@db.internal/ofd  ' }), []);
});

test('reports only the scheme when DATABASE_URL is wrong — never the value itself', () => {
  const wrong = validateProductionEnv({ ...safeProduction, DATABASE_URL: 'mysql://root:secret@db/ofd' });
  assert.ok(wrong.some((error) => error.includes('found: scheme "mysql"')));
  assert.ok(!wrong.join(' ').includes('secret'), '자격증명은 어떤 오류 메시지에도 나오면 안 된다');
  const missing = validateProductionEnv({ ...safeProduction, DATABASE_URL: '' });
  assert.ok(missing.some((error) => error.includes('found: missing')));
  const pasted = validateProductionEnv({ ...safeProduction, DATABASE_URL: 'dpg-abc123-not-a-url' });
  assert.ok(pasted.some((error) => error.includes('found: no scheme')));
  assert.ok(!pasted.join(' ').includes('dpg-abc123'), '스킴 없는 값도 그대로 노출하지 않는다');
});
