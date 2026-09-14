import test from 'node:test';
import assert from 'node:assert/strict';
import { readSharedTarget, assertSharedIsolation } from './deploy/oda-shared-guard.mjs';

const env = () => ({ ODA_SHARED_DATABASE: 'true', WORKSTATION_BRAND: 'oda', APP_MODE: 'production', REPOSITORY_MODE: 'postgres',
  DATABASE_URL: 'postgresql://oda_app:test-password@private-db:5432/oda_production?sslmode=require',
  ODA_DB_NAME: 'oda_production', ODA_DB_ROLE: 'oda_app', ODA_PEER_DB_NAME: 'ofd_postgres',
  ODA_PEER_DB_ROLES: 'ofd_api_runtime,ofd_worker_runtime', DB_POOL_MAX: '3',
  WEB_ORIGIN: 'https://oda.example.com', PUBLIC_APP_URL: 'https://oda.example.com',
  ODA_PEER_WEB_ORIGIN: 'https://ofd.example.com', S3_BUCKET: 'oda-private-evidence' });
const identity = () => ({ database: 'oda_production', role: 'oda_app', schema: 'public',
  rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, has_memberships: false });
const peers = () => ['ofd_api_runtime','ofd_worker_runtime'].map(rolname => ({ rolname, can_connect_oda: false, privileged: false }));
function fakeClient({ own = identity(), otherRoles = peers(), otherDb = { can_connect: false }, connectError } = {}) {
  const calls = [];
  let closed = false;
  const client = { connect: async () => { if (connectError) throw connectError; }, end: async () => { closed = true; },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('current_schema()')) return { rows: own ? [own] : [] };
      if (sql.includes('can_connect_oda')) return { rows: otherRoles };
      if (sql.includes('FROM pg_database')) return { rows: otherDb ? [otherDb] : [] };
      return { rows: [] };
    } };
  return { client, calls, closed: () => closed };
}
test('accepts dedicated production targets and checks both directions without writes', async () => {
  const fake = fakeClient();
  await assertSharedIsolation(env(), () => fake.client);
  assert.equal(fake.calls[0].sql, 'BEGIN READ ONLY');
  assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  assert.ok(fake.calls.every(({sql}) => /^(SELECT|BEGIN READ ONLY|COMMIT)/.test(sql)));
  assert.ok(fake.closed());
});
test('rejects OFD URL, encoded overrides, shared origins, buckets, or unbounded pools before connecting', () => {
  for (const change of [
    { DATABASE_URL: 'postgresql://ofd_user:private@host/ofd_postgres' },
    { DATABASE_URL: env().DATABASE_URL + '&database=ofd_postgres' },
    { DATABASE_URL: env().DATABASE_URL + '&options=-csearch_path%3Dofd' },
    { DATABASE_URL: env().DATABASE_URL.replace('require','disable') },
    { DATABASE_URL: 'postgresql://%ZZ:private@host/oda_production' },
    { WEB_ORIGIN: 'https://ofd.example.com', PUBLIC_APP_URL: 'https://ofd.example.com' },
    { S3_BUCKET: 'ofd-evidence' }, { DB_POOL_MAX: '20' }, { ODA_PEER_DB_ROLES: '' },
    { ODA_DB_NAME: 'ofd_postgres' }, { ODA_SHARED_DATABASE: 'false' },
  ]) assert.throws(() => readSharedTarget({ ...env(), ...change }));
});
test('refuses actual identity drift, elevated roles and role memberships', async () => {
  for (const change of [{database:'ofd_postgres'}, {role:'render_admin'}, {schema:'ofd'},
    {rolsuper:true}, {rolcreaterole:true}, {rolcreatedb:true}, {rolbypassrls:true}, {has_memberships:true}]) {
    const fake = fakeClient({ own: {...identity(), ...change} });
    await assert.rejects(assertSharedIsolation(env(), () => fake.client));
    assert.ok(fake.closed());
    assert.ok(!fake.calls.some(x => x.sql === 'COMMIT'));
  }
});
test('refuses PUBLIC or direct cross-database access, privileged OFD users, and missing peers', async () => {
  for (const config of [{otherDb:{can_connect:true}}, {otherDb:null}, {otherRoles:[]},
    {otherRoles:[{...peers()[0],can_connect_oda:true},peers()[1]]},
    {otherRoles:[{...peers()[0],privileged:true},peers()[1]]}]) {
    const fake = fakeClient(config);
    await assert.rejects(assertSharedIsolation(env(), () => fake.client));
    assert.ok(fake.closed());
  }
});
test('closes failed connections and never reaches migration or application code', async () => {
  const fake = fakeClient({connectError:new Error('unavailable')});
  await assert.rejects(assertSharedIsolation(env(), () => fake.client));
  assert.ok(fake.closed());
  assert.equal(fake.calls.length,0);
});
