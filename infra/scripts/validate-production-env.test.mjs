import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductionEnv } from './validate-production-env.mjs';

const safeProduction = {
  NODE_ENV: 'production',
  APP_MODE: 'production',
  DATABASE_URL: 'postgresql://ofd:strong-password@db.internal/ofd',
  SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz-session',
  ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
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
