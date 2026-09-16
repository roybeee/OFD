import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createDemoRepository, DEMO_IDS, PostgresRepository } from '../../packages/db/src/index.ts';
import { discoverMigrations, runMigrations } from '../../packages/db/src/migration-runner.ts';
import { buildApp } from '../../apps/api/src/app.ts';

// node --import tsx infra/scripts/oda-automation-api-durable-smoke.mjs
// Isolated disk-backed WASM PostgreSQL over the PG wire protocol. All API reads
// and writes use the real PostgresRepository. Never reads DATABASE_URL and never
// touches external databases. Native PG concurrency/TLS remain separate gates.
const directory = await mkdtemp(join(tmpdir(), 'oda-automation-api-durable-'));
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/automation`;
const password = 'OFD-demo-2026!';
const owner = { 'x-demo-actor-id': DEMO_IDS.owner };
const staff = { 'x-demo-actor-id': DEMO_IDS.staff };
let engine, app, repository, connectionString;
let restarts = 0;

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
const port = await availablePort();
connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;

async function startEngine() {
  const child = fork(new URL('../testing/pglite/server.mjs', import.meta.url), [], {
    env: { ...process.env, APP_MODE: 'test', ODA_TEST_DATA_DIR: directory, ODA_TEST_DB_PORT: String(port) },
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  engine = child;
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PGlite startup timed out: ${diagnostics}`)), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`PGlite exited (${code}): ${diagnostics}`)); });
    child.once('message', message => {
      clearTimeout(timer);
      if (!message?.ready) reject(new Error('PGlite readiness missing')); else resolve();
    });
  });
}
async function stopEngine() {
  if (!engine || engine.exitCode !== null) return;
  const child = engine; engine = undefined;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PGlite graceful shutdown timed out')); }, 10000);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`PGlite shutdown failed (${code})`)); });
    child.send('stop');
  });
}
async function connectApp() {
  repository = PostgresRepository.connect(connectionString, { DB_POOL_MAX: '1' });
  app = await buildApp({ repository, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
}
async function reconnect() {
  await app.close(); app = undefined; repository = undefined;
  await stopEngine(); await startEngine(); await connectApp(); restarts++;
}
async function api(method, url, payload, headers = owner, expected = 200) {
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
try {
  await startEngine();
  const migrationPool = new pg.Pool({ connectionString, max: 1 });
  const client = await migrationPool.connect();
  try { await runMigrations(client, await discoverMigrations(), () => {}); }
  finally { client.release(); await migrationPool.end(); }
  await connectApp();
  const fixtures = createDemoRepository();
  for (const type of ['legal_entity', 'store', 'actor', 'credential']) {
    const values = await fixtures.list(type);
    await repository.commit({ changes: values.map(value => ({ type, id: value.id,
      ...(type === 'store' ? { storeId: value.id } : {}), expectedVersion: null, value })) });
  }
  await fixtures.close();
  const issued = await api('POST', `${base}/tokens`, { name: 'Synthetic persistence test', storeIds: [storeId], kinds: ['revenue', 'expense'], routines: false });
  const headers = { authorization: `Bearer ${issued.token}` };
  const machine = '/api/v2/oda/integration';
  const input = { batchId: randomUUID(), storeId, month: '2026-08',
    source: { system: 'synthetic', accountRef: 'durable-test', url: 'https://example.com/reports', capturedAt: '2026-09-16T00:00:00.000Z' },
    lines: [{ externalRef: 'durable-sale-1', date: '2026-08-31', kind: 'revenue', channel: 'baemin', category: 'sales', description: 'Synthetic sale', amountKrw: 11000, vatKrw: 1000 }] };
  const preview = await api('POST', `${machine}/batches/preview`, input, headers);
  assert.equal(preview.status, 'awaiting_approval'); assert.equal(await repository.get('oda_month', `${storeId}:2026-08`), undefined);
  await reconnect();
  const restored = await api('GET', `${machine}/batches/${preview.id}`, undefined, headers); assert.equal(restored.digest, preview.digest);
  await api('POST', `${machine}/batches/${preview.id}/commit`, { digest: preview.digest }, headers, 409);
  const committed = await api('POST', `${base}/batches/${preview.id}/approve`, { digest: preview.digest, commit: true });
  assert.equal(committed.result.added, 1);
  await reconnect();
  const retry = await api('POST', `${machine}/batches/${preview.id}/commit`, { digest: preview.digest }, headers);
  assert.deepEqual(retry.result, committed.result);
  const record = await repository.get('oda_month', `${storeId}:2026-08`);
  assert.equal(record.lines.length, 1); assert.equal(record.lines[0].amount, 11000);
  const evidence = Object.values(record.evidenceBytes)[0]; assert.ok(Buffer.from(evidence, 'base64').toString().includes(preview.digest));
  const duplicate = await api('POST', `${machine}/batches/preview`, { ...input, batchId: randomUUID() }, headers);
  assert.equal(duplicate.preview.duplicates, 1);
  const conflict = await api('POST', `${machine}/batches/preview`, { ...input, batchId: randomUUID(), lines: [{ ...input.lines[0], amountKrw: 22000 }] }, headers);
  assert.deepEqual(conflict.preview.conflicts, ['durable-sale-1']);
  await api('POST', `${base}/batches/${conflict.id}/approve`, { digest: conflict.digest, commit: true }, owner, 409);
  await api('POST', `${base}/tokens/${issued.connection.id}/revoke`, {});
  await reconnect();
  await api('GET', `${machine}/capabilities`, undefined, headers, 401);
  assert.equal((await repository.get('oda_month', `${storeId}:2026-08`)).lines.length, 1);
  console.log(`PASS: scoped automation preview, approval, real financial rows, evidence, duplicate/conflict identity and revocation survive ${restarts} disk-backed PostgreSQL process restarts`);
} finally {
  if (app) await app.close(); else if (repository) await repository.close();
  await stopEngine(); await rm(directory, { recursive: true, force: true });
}
