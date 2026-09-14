import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createOdaDemoRepository, DEMO_IDS, PostgresRepository } from '../../packages/db/src/index.ts';
import { discoverMigrations, runMigrations } from '../../packages/db/src/migration-runner.ts';
import { buildApp } from '../../apps/api/src/app.ts';

// Run with node --import tsx infra/scripts/oda-durable-smoke.mjs [--postgres].
// Native mode only accepts an explicitly supplied, disposable, empty test database.
// PGlite is a test-only single-connection WASM engine. It is not a substitute for
// the native PostgreSQL concurrency, TLS, crash recovery, or production CI gates.
const native = process.argv.includes('--postgres');
if (process.argv.slice(2).some((arg) => arg !== '--postgres')) throw new Error('Unknown test argument');
if (native && (process.env.APP_MODE !== 'test' || !/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? ''))) {
  throw new Error('--postgres requires APP_MODE=test and DATABASE_URL for an empty, disposable test database');
}

let directory;
let engine;
let app;
let repository;
let connectionString = process.env.DATABASE_URL;
let port;
const mode = native ? 'native PostgreSQL / API and repository reconnect' : 'PGlite WASM / full database process restart';
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${storeId}/2026-08`;
const owner = { 'x-demo-actor-id': DEMO_IDS.owner };
const finance = { 'x-demo-actor-id': DEMO_IDS.finance };
const sales = '날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,매출,월 마감,33000000,3000000,매출,pos,S-01';
const expenses = '날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,비용,8월 임차료,11000000,1000000,임차료,manual,E-01';
let restarts = 0;

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const assigned = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return assigned;
}

async function startEngine() {
  const child = fork(new URL('../testing/pglite/server.mjs', import.meta.url), [], {
    env: { ...process.env, APP_MODE: 'test', ODA_TEST_DATA_DIR: directory, ODA_TEST_DB_PORT: String(port) },
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  engine = child;
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PGlite startup timed out: ${diagnostics}`)), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`PGlite exited (${code}): ${diagnostics}`)); });
    child.once('message', (message) => {
      clearTimeout(timer);
      if (!message?.ready) { reject(new Error('PGlite did not report readiness')); return; }
      resolve();
    });
  });
}

async function stopEngine() {
  if (!engine || engine.exitCode !== null) return;
  const child = engine;
  engine = undefined;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PGlite graceful shutdown timed out')); }, 10_000);
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`PGlite shutdown failed (${code})`)); });
    child.send('stop');
  });
}

async function connectApp() {
  repository = PostgresRepository.connect(connectionString, { DB_POOL_MAX: native ? '4' : '1' });
  app = await buildApp({ repository, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
}

async function reconnect() {
  await app.close(); // This also drains and closes the pg repository pool.
  app = undefined;
  repository = undefined;
  if (!native) { await stopEngine(); await startEngine(); }
  await connectApp();
  restarts += 1;
}

async function get(suffix = '', headers = owner) {
  const response = await app.inject({ method: 'GET', url: `${base}${suffix}`, headers });
  assert.equal(response.statusCode, 200, response.body);
  return response;
}

async function post(suffix, payload, headers = owner, expectedStatus = 200) {
  const response = await app.inject({ method: 'POST', url: `${base}${suffix}`, headers, payload });
  assert.equal(response.statusCode, expectedStatus, `${suffix}: ${response.body}`);
  return response.json();
}

async function assertEvidence(evidence) {
  for (const source of evidence) {
    const expected = source.fileName === 'sales.csv' ? sales : expenses;
    const bytes = Buffer.from(expected);
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual((await get(`/evidence/${source.id}`)).rawPayload, bytes);
  }
}

try {
  console.log(`ODA durable integration: ${mode}`);
  if (!native) {
    directory = await mkdtemp(join(tmpdir(), 'oda-durable-'));
    port = await availablePort();
    connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    await startEngine();
  }
  const migrationPool = new pg.Pool({ connectionString, max: 1 });
  const client = await migrationPool.connect();
  const migrations = await discoverMigrations();
  try {
    const existing = await client.query("SELECT to_regclass('public.aggregate_snapshots') AS present");
    if (existing.rows[0].present) {
      const count = await client.query('SELECT count(*)::int AS total FROM aggregate_snapshots');
      assert.equal(count.rows[0].total, 0, 'Refusing to seed a database containing application records; use an empty test database');
    }
    const migrated = await runMigrations(client, migrations, () => {});
    assert.equal(migrated.applied.length + migrated.alreadyApplied.length, migrations.length);
  } finally { client.release(); await migrationPool.end(); }
  console.log(`PASS: ${migrations.length} unmodified SQL migrations, pgcrypto, citext, btree_gist`);

  await connectApp();
  const fixtures = createOdaDemoRepository();
  for (const type of ['legal_entity', 'store', 'actor', 'credential']) {
    const values = await fixtures.list(type);
    await repository.commit({ changes: values.map((value) => ({ type, id: value.id,
      ...(type === 'store' ? { storeId: value.id } : {}), expectedVersion: null, value })) });
  }
  await fixtures.close();
  const initial = (await get()).json();
  const { acknowledgements: _acks, ...policy } = initial.data.policy;
  await post('/save', { expectedVersion: 0, policy: { ...policy, attributionBasis: 'accrual', vatBasis: 'net',
    posDeliveryScope: 'excluded', bVatPolicy: 'add10', agreementNote: '갑·을은 발생월, 실제 부가세 제외 손익, 을 지급액 부가세 10% 가산에 합의함.' } });
  await post('/confirm-policy', { expectedVersion: 1 });
  await post('/confirm-policy', { expectedVersion: 2 }, finance);
  await post('/import', { expectedVersion: 3, filename: 'sales.csv', kind: 'pos', content: sales });
  const imported = await post('/import', { expectedVersion: 4, filename: 'expenses.csv', kind: 'expense', content: expenses });
  assert.equal(imported.version, 5);
  assert.equal(imported.summary.profit, 20_000_000);
  assert.equal(imported.summary.payableB, 9_350_000);
  assert.equal(imported.summary.canFinalize, true);
  const importedRead = (await get()).json();
  await reconnect();
  assert.deepEqual((await get()).json(), importedRead);
  await assertEvidence(imported.evidence);
  await post('/comment', { expectedVersion: 4, text: 'stale browser must not overwrite persisted data' }, owner, 409);
  await post('/comment', { expectedVersion: 5, text: 'read-only actor must not write' }, { 'x-demo-actor-id': DEMO_IDS.auditor }, 403);
  console.log('PASS: imported sources, original bytes/SHA-256, two-party acknowledgement, amounts, and stale-version protection after reconnect');

  const finalized = await post('/finalize', { expectedVersion: 5 });
  const firstSnapshot = finalized.history[0];
  assert.ok(firstSnapshot);
  const finalizedRead = (await get()).json();
  await reconnect();
  assert.deepEqual((await get()).json(), finalizedRead);
  await assertEvidence(finalized.evidence);
  await post('/import', { expectedVersion: 6, filename: 'blocked.csv', kind: 'pos', content: sales }, owner, 409);
  const reopened = await post('/reopen', { expectedVersion: 6, reason: '누락 비용 확인 후 재검토' });
  assert.deepEqual(reopened.history[0], firstSnapshot);
  await post('/finalize', { expectedVersion: 7 });
  await post('/paid', { expectedVersion: 8, date: '2026-09-10', reference: 'TEST-TRANSFER-0001', amount: 8_500_000 }, owner, 422);
  const paid = await post('/paid', { expectedVersion: 8, date: '2026-09-10', reference: 'TEST-TRANSFER-0001', amount: 9_350_000 });
  const paidRead = (await get()).json();
  const auditBefore = await repository.listAudit(100, [storeId]);
  assert.ok(auditBefore.length >= 9);
  assert.equal(JSON.stringify(auditBefore).includes('evidenceBytes'), false);
  await reconnect();
  assert.deepEqual((await get()).json(), paidRead);
  assert.deepEqual((await get()).json().history[0], firstSnapshot);
  assert.deepEqual(await repository.listAudit(100, [storeId]), auditBefore);
  await assertEvidence(paid.evidence);
  await post('/reopen', { expectedVersion: 9, reason: '지급 이후 수정 방지 검증' }, owner, 409);
  console.log('PASS: finalized/reopened/refinalized history, exact payment, post-payment lock, and audit events after reconnect');

  await app.close();
  app = undefined;
  repository = undefined;
  const verifyPool = new pg.Pool({ connectionString, max: 1 });
  try {
    const chain = (await verifyPool.query('SELECT previous_hash,event_hash FROM audit_ledger ORDER BY sequence')).rows;
    for (let index = 1; index < chain.length; index += 1) assert.equal(chain[index].previous_hash, chain[index - 1].event_hash);
    assert.equal(chain[0].previous_hash, null);
  } finally { await verifyPool.end(); }
  console.log(`PASS: audit hash-chain links preserved; ${restarts} reconnect(s); ${mode}`);
  if (!native) console.log('LIMIT: WASM single-connection engine; native PostgreSQL locking/concurrency, TLS, and crash recovery remain separate CI gates.');
} finally {
  if (app) await app.close();
  else if (repository) await repository.close();
  if (!native) {
    await stopEngine();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
