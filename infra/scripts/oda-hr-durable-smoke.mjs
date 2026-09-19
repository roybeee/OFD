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

// Run with node --import tsx infra/scripts/oda-hr-durable-smoke.mjs [--postgres].
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
const base = `/api/v2/oda/${storeId}/hr`;
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
    directory = await mkdtemp(join(tmpdir(), 'oda-hr-durable-'));
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
  const fixtures = createDemoRepository();
  for (const type of ['legal_entity', 'store', 'actor', 'credential']) {
    const values = await fixtures.list(type);
    await repository.commit({ changes: values.map((value) => ({ type, id: value.id,
      ...(type === 'store' ? { storeId: value.id } : {}), expectedVersion: null, value })) });
  }
  await fixtures.close();

  let version = 0;
  const hrCommand = async (type, input, headers = owner, expectedStatus = 200, key = randomUUID(), expectedVersion = version) => {
    const result = await app.inject({method:'POST',url:`${base}/commands`,headers:{...headers,'idempotency-key':key},payload:{type,input,expectedVersion}});
    assert.equal(result.statusCode,expectedStatus,result.body);
    if (result.statusCode===200) version=result.json().workspace.version;
    return result;
  };
  const empty=(await get()).json();
  assert.equal(empty.workspace.version,0);
  assert.equal(await repository.get('oda_hr',`hr:${storeId}`),undefined);
  let saved=(await hrCommand('employee.create',{employeeNumber:'HR-001',name:'영속검증 직원',actorId:DEMO_IDS.staff,hireDate:'2026-01-01',payType:'monthly',basePay:3000000})).json();
  const employeeId=saved.workspace.employees[0].id;
  await hrCommand('leave.grant',{employeeId,typeId:'annual',effectiveFrom:'2026-01-01',expiresOn:'2026-12-31',minutes:480,note:'합성 테스트 부여'});
  const staff={'x-demo-actor-id':DEMO_IDS.staff};
  saved=(await hrCommand('leave.request',{employeeId,typeId:'annual',startDate:'2026-09-15',endDate:'2026-09-15',startTime:'09:00',endTime:'18:00',minutesPerDay:480,note:'합성 테스트 휴가'},staff)).json();
  assert.equal(saved.workspace.attendance.leaveRequests.length,1);
  await hrCommand('operations.check', { date: '2026-01-02', phase: 'open', taskKey: 'open_clean', done: true }, staff);
  const photoBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4UcAAAAASUVORK5CYII=';
  const photoKey = randomUUID(), photoVersion = version;
  const photoInput = { date: '2026-01-02', body: '합성 냉장고 점검', category: 'facility', photo: { base64: photoBase64, mimeType: 'image/png' } };
  const photoSaved = (await hrCommand('operations.handover.create', photoInput, staff, 200, photoKey, photoVersion)).json();
  const handoverId = photoSaved.workspace.operations.handovers[0].id;
  assert.equal(JSON.stringify(await repository.get('oda_hr', `hr:${storeId}`)).includes(photoBase64), false);
  const initialRead=(await get()).json();
  const audits=await repository.listAudit(100,[storeId]);
  await reconnect();
  assert.deepEqual((await get()).json(),initialRead);
  assert.deepEqual(await repository.listAudit(100,[storeId]),audits);
  const photoDownloaded = await get(`/handovers/${handoverId}/photo`, staff);
  assert.deepEqual(photoDownloaded.rawPayload, Buffer.from(photoBase64, 'base64'));
  assert.equal((await repository.getHrPhoto(storeId, handoverId)).sha256, createHash('sha256').update(Buffer.from(photoBase64, 'base64')).digest('hex'));
  const photoReplay = await hrCommand('operations.handover.create', photoInput, staff, 200, photoKey, photoVersion);
  assert.equal(photoReplay.headers['idempotency-replayed'], 'true');
  assert.equal(photoReplay.json().workspace.operations.handovers.length, 1);
  assert.equal(photoReplay.json().workspace.operations.checks[0].completedBy, DEMO_IDS.staff);
  const forbiddenPhoto = await app.inject({ url: `${base}/handovers/${handoverId}/photo`, headers: finance });
  assert.equal(forbiddenPhoto.statusCode, 403);
  console.log('PASS: checklist, immutable binary photo and idempotency persist after database restart; finance photo access denied');

  await hrCommand('settings.update',{companyName:'덮어쓰기'},owner,409,randomUUID(),0);
  await hrCommand('settings.update',{companyName:'감사 계정쓰기'}, {'x-demo-actor-id':DEMO_IDS.auditor},403);
  console.log('PASS: HR employees, grant/use ledger and audit persist after full database restart; stale and forbidden writes rejected');
  const requestId=saved.workspace.attendance.leaveRequests[0].id;
  await hrCommand('leave.cancel',{id:requestId,expectedRevision:1,note:'합성 테스트 취소'},staff);
  const ledger=(await get()).json().workspace.attendance.leaveLedger;
  assert.equal(ledger.reduce((sum,row)=>sum+row.minutes,0),480);
  const retryKey=randomUUID(),expectedVersion=version;
  await hrCommand('settings.update',{companyName:'영속검증 ODA'},owner,200,retryKey,expectedVersion);
  const before=(await get()).json();
  await reconnect();
  const replay=await hrCommand('settings.update',{companyName:'영속검증 ODA'},owner,200,retryKey,expectedVersion);
  assert.equal(replay.headers['idempotency-replayed'],'true');
  assert.deepEqual((await get()).json(),before);
  assert.equal((await get('',staff)).json().workspace.employees[0].id,employeeId);
  const privateAudit=JSON.stringify(await repository.listAudit(100,[storeId]));
  assert.equal(privateAudit.includes('3000000'),false);
  assert.equal(privateAudit.includes('영속검증 직원'),false);
  console.log('PASS: cancellation restores original leave lot; replay after restart adds no employee/ledger/audit duplicate; no salary in audit');
  console.log(`PASS: ${restarts} reconnects with ${mode}`);
} finally {
  if(app) await app.close(); else if(repository) await repository.close();
  if(!native){ await stopEngine(); if(directory) await rm(directory,{recursive:true,force:true}); }
}
