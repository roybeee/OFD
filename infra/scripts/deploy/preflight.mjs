import { pathToFileURL } from 'node:url';
import { validateProductionEnv } from '../validate-production-env.mjs';

const ROLES = new Set(['api', 'worker', 'migrate']);

export function validateDeploymentEnv(env, requestedRole) {
  const role = String(requestedRole ?? env.SERVICE_ROLE ?? '').trim();
  const errors = [...validateProductionEnv(env)];
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production for a deployment');
  if (env.APP_MODE !== 'production') errors.push('APP_MODE must be production for a deployment');
  if (env.REPOSITORY_MODE !== 'postgres') errors.push('REPOSITORY_MODE must be postgres for a deployment');
  if (!ROLES.has(role)) errors.push('SERVICE_ROLE must be api, worker, or migrate');
  if (!/^postgresql:\/\//.test(String(env.DATABASE_URL ?? ''))) errors.push('DATABASE_URL must point to Postgres');
  if (env.STORAGE_MODE !== 's3') errors.push('STORAGE_MODE must be s3 for a deployment');
  if (!/^[0-9a-f]{40}$/i.test(String(env.RELEASE_SHA ?? ''))) errors.push('RELEASE_SHA must be a 40-character Git commit SHA');
  if (role === 'api') {
    if (env.API_HOST !== '0.0.0.0') errors.push('API_HOST must be 0.0.0.0 in the API container');
    const port = Number(env.API_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('API_PORT must be a valid TCP port');
  }
  for (const flag of ['CUTOVER_STORE_IDS', 'WRITE_FREEZE_STORE_IDS']) {
    if (String(env[flag] ?? '').trim()) errors.push(`${flag} is not supported by the application core; use the documented database-backed cutover procedure`);
  }
  return [...new Set(errors)];
}

export function runDeploymentPreflight(env = process.env, role = process.argv[2] ?? env.SERVICE_ROLE) {
  const errors = validateDeploymentEnv(env, role);
  if (errors.length === 0) {
    console.log(`OFD deployment preflight passed for ${role}.`);
    return 0;
  }
  console.error(`OFD deployment preflight failed for ${role || 'unknown role'}:`);
  for (const error of errors) console.error(`- ${error}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runDeploymentPreflight();
}
