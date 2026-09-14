/** Run ONLY against the disposable PostgreSQL service in ODA CI. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertSharedIsolation } from './deploy/oda-shared-guard.mjs';

const url = new URL(process.env.DATABASE_URL ?? 'https://invalid');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.ODA_ISOLATION_TEST !== 'true'
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/oda_ci') {
  throw new Error('Isolation test requires the explicitly enabled disposable localhost oda_ci GitHub Actions database');
}
const admin = new pg.Client({ connectionString: url.href });
const password = randomBytes(32).toString('hex');
const createdDatabases = [], createdRoles = [];
await admin.connect();
try {
  // Refuse existing names before creating anything; never reuse live resources.
  const existing = await admin.query(`SELECT datname FROM pg_database WHERE datname = ANY($1)
    UNION ALL SELECT rolname FROM pg_roles WHERE rolname = ANY($2)`,
  [['oda_production','ofd_guard_test'],['oda_app','ofd_guard_runtime']]);
  assert.equal(existing.rows.length, 0, 'Disposable test names must be absent');
  // Password is random hexadecimal generated above, never provided by users or logged.
  await admin.query(`CREATE ROLE oda_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
  createdRoles.push('oda_app');
  await admin.query('CREATE ROLE ofd_guard_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
  createdRoles.push('ofd_guard_runtime');
  await admin.query('CREATE DATABASE oda_production OWNER oda_app'); createdDatabases.push('oda_production');
  await admin.query('CREATE DATABASE ofd_guard_test OWNER ofd_guard_runtime'); createdDatabases.push('ofd_guard_test');
  const appUrl = new URL(url); appUrl.pathname='/oda_production'; appUrl.username='oda_app'; appUrl.password=password;
  const env = { ODA_SHARED_DATABASE:'true',WORKSTATION_BRAND:'oda',APP_MODE:'production',REPOSITORY_MODE:'postgres',
    DATABASE_URL:appUrl.href,ODA_DB_NAME:'oda_production',ODA_DB_ROLE:'oda_app',ODA_PEER_DB_NAME:'ofd_guard_test',
    ODA_PEER_DB_ROLES:'ofd_guard_runtime',DB_POOL_MAX:'3',WEB_ORIGIN:'https://oda.example.com',
    PUBLIC_APP_URL:'https://oda.example.com',ODA_PEER_WEB_ORIGIN:'https://ofd.example.com',S3_BUCKET:'oda-ci-evidence' };
  await assert.rejects(assertSharedIsolation(env), /OFD runtime roles can access/);
  await admin.query('REVOKE CONNECT ON DATABASE oda_production FROM PUBLIC');
  await assert.rejects(assertSharedIsolation(env), /ODA can connect to OFD/);
  await admin.query('REVOKE CONNECT ON DATABASE ofd_guard_test FROM PUBLIC');
  await assertSharedIsolation(env);
  await admin.query('ALTER ROLE oda_app CREATEROLE');
  await assert.rejects(assertSharedIsolation(env), /least-privilege/);
  await admin.query('ALTER ROLE oda_app NOCREATEROLE');
  await admin.query('ALTER ROLE ofd_guard_runtime CREATEDB');
  await assert.rejects(assertSharedIsolation(env), /OFD runtime roles can access/);
  await admin.query('ALTER ROLE ofd_guard_runtime NOCREATEDB');
  await assertSharedIsolation(env);
  console.log('Native PostgreSQL isolation passed: PUBLIC access blocked in both directions; elevated runtime roles rejected.');
} finally {
  try {
    for (const database of createdDatabases.reverse()) await admin.query(`DROP DATABASE "${database}"`);
    for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  } finally { await admin.end(); }
}
