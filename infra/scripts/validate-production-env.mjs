import { pathToFileURL } from 'node:url';

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const KNOWN_DEVELOPMENT_ENCRYPTION_KEYS = new Set([
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
]);

export function isEnabled(value) {
  return TRUE.has(String(value ?? '').trim().toLowerCase());
}

function required(errors, env, names, context) {
  for (const name of names) {
    if (!String(env[name] ?? '').trim()) {
      errors.push(`${context}: ${name} is required`);
    }
  }
}

function rejectPlaceholder(errors, env, name) {
  const value = String(env[name] ?? '');
  if (/local|change|example|invalid|secret/i.test(value)) {
    errors.push(`${name} contains a development placeholder`);
  }
}

export function validateProductionEnv(env) {
  const errors = [];
  if (env.NODE_ENV !== 'production') return errors;

  if (env.APP_MODE !== 'production') {
    errors.push('APP_MODE must be production when NODE_ENV=production');
  }
  if (env.STORAGE_MODE !== 's3') {
    errors.push('STORAGE_MODE must be s3 when NODE_ENV=production');
  }
  if (env.EMAIL_PROVIDER !== 'smtp') {
    errors.push('EMAIL_PROVIDER must be smtp when NODE_ENV=production');
  }

  required(errors, env, [
    'DATABASE_URL',
    'SESSION_SECRET',
    'ENCRYPTION_KEY',
    'PUBLIC_APP_URL',
    'WEB_ORIGIN',
    'S3_REGION',
    'S3_BUCKET',
    'S3_KMS_KEY_ID',
    'SMTP_HOST',
    'EMAIL_FROM'
  ], 'production');

  if (String(env.S3_ENDPOINT ?? '').trim()) {
    required(errors, env, ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], 'S3-compatible endpoint');
  }

  for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
    if (String(env[name] ?? '').length < 32) {
      errors.push(`${name} must be at least 32 characters`);
    }
    rejectPlaceholder(errors, env, name);
  }
  const encryptionKey = String(env.ENCRYPTION_KEY ?? '');
  if (KNOWN_DEVELOPMENT_ENCRYPTION_KEYS.has(encryptionKey)) {
    errors.push('ENCRYPTION_KEY uses a known development key');
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32) {
    errors.push('ENCRYPTION_KEY must be base64 for exactly 32 bytes');
  }

  if (env.SESSION_SECRET && env.SESSION_SECRET === env.ENCRYPTION_KEY) {
    errors.push('SESSION_SECRET and ENCRYPTION_KEY must be different');
  }
  if (!String(env.DATABASE_URL ?? '').startsWith('postgresql://')) {
    errors.push('DATABASE_URL must use postgresql://');
  }
  for (const name of ['PUBLIC_APP_URL', 'WEB_ORIGIN']) {
    if (!String(env[name] ?? '').startsWith('https://')) {
      errors.push(`${name} must use https:// in production`);
    }
  }
  if (!isEnabled(env.SESSION_COOKIE_SECURE)) {
    errors.push('SESSION_COOKIE_SECURE must be true in production');
  }

  const featureFlags = [
    'POPBILL_TAX_INVOICE_ENABLED',
    'POPBILL_BANK_SYNC_ENABLED',
    'POPBILL_SMS_ENABLED'
  ];
  const popbillRequested = isEnabled(env.POPBILL_PRODUCTION_ENABLED)
    || featureFlags.some((name) => isEnabled(env[name]));

  if (popbillRequested) {
    if (env.PROVIDER_MODE !== 'production') {
      errors.push('PROVIDER_MODE must be production when a Popbill production feature is enabled');
    }
    if (!isEnabled(env.POPBILL_PRODUCTION_ENABLED)) {
      errors.push('POPBILL_PRODUCTION_ENABLED must be explicitly true');
    }
    required(errors, env, [
      'POPBILL_LINK_ID',
      'POPBILL_SECRET_KEY',
      'POPBILL_CORP_NUM',
      'POPBILL_USER_ID',
      'POPBILL_WEBHOOK_API_KEY'
    ], 'Popbill production');

    if (isEnabled(env.POPBILL_TAX_INVOICE_ENABLED) && !isEnabled(env.POPBILL_CERTIFICATE_CONFIGURED)) {
      errors.push('POPBILL_CERTIFICATE_CONFIGURED must be true');
    }
    if (isEnabled(env.POPBILL_BANK_SYNC_ENABLED)) {
      if (!isEnabled(env.POPBILL_BANK_ACCOUNT_AUTHORIZED)) {
        errors.push('POPBILL_BANK_ACCOUNT_AUTHORIZED must be true');
      }
      required(errors, env, ['POPBILL_BANK_CODE', 'POPBILL_BANK_ACCOUNT'], 'Popbill bank sync');
    }
    if (isEnabled(env.POPBILL_SMS_ENABLED)) {
      required(errors, env, ['POPBILL_SMS_SENDER'], 'Popbill SMS');
    }
  } else if (env.PROVIDER_MODE === 'production') {
    errors.push('PROVIDER_MODE=production requires POPBILL_PRODUCTION_ENABLED=true');
  }

  return errors;
}

export function runPreflight(env = process.env) {
  const errors = validateProductionEnv(env);
  if (errors.length > 0) {
    console.error('OFD V2 production preflight failed:');
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  const mode = env.NODE_ENV === 'production' ? 'production' : 'non-production';
  console.log(`OFD V2 ${mode} environment preflight passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPreflight();
}
