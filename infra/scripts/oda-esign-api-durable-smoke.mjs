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

// node --import tsx infra/scripts/oda-esign-api-durable-smoke.mjs
// Isolated disk-backed WASM PostgreSQL over the PG wire protocol. All API reads
// and writes use the real PostgresRepository. Never reads DATABASE_URL and never
// touches external databases. Native PG concurrency/TLS remain separate gates.
const directory = await mkdtemp(join(tmpdir(), 'oda-esign-api-durable-'));
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${storeId}/esign`;
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
async function post(path, payload, headers = owner, expected = 200, key = randomUUID()) {
  const response = await app.inject({ method: 'POST', url: `${base}${path}`, headers: { ...headers, 'idempotency-key': key }, payload });
  assert.equal(response.statusCode, expected, `${path}: ${response.body}`); return response;
}
async function get(path = '', headers = owner, expected = 200) {
  const response = await app.inject({ method: 'GET', url: `${base}${path}`, headers });
  assert.equal(response.statusCode, expected, `${path}: ${response.body.slice(0, 300)}`); return response;
}
function signature(contract, role) {
  return { expectedVersion: contract.version, role, typedName: role === 'employee' ? contract.employeeName : contract.employer.signerName,
    documentHash: contract.documentHash, consent: true, consentVersion: contract.consentVersion, password,
    strokes: [[{ x: .1, y: .5 }, { x: .4, y: .1 }, { x: .6, y: .8 }, { x: .9, y: .2 }]] };
}
function businessNumber(firstNine) {
  const digits = [...firstNine].map(Number), weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const sum = weights.reduce((total, weight, index) => total + weight * digits[index], 0) + Math.floor(digits[8] * 5 / 10);
  return firstNine + ((10 - sum % 10) % 10);
}
async function directQueries(run) {
  // PGlite is a single-connection engine. Release the API pool before a separate
  // test-control connection; reopen it after the direct SQL checks finish.
  await app.close(); app = undefined; repository = undefined;
  const pool = new pg.Pool({ connectionString, max: 1 });
  try { await run(pool); } finally { await pool.end(); await connectApp(); }
}

try {
  await startEngine();
  const migrationPool = new pg.Pool({ connectionString, max: 1 });
  const client = await migrationPool.connect();
  try {
    const migrations = await discoverMigrations();
    const result = await runMigrations(client, migrations, () => {});
    assert.equal(result.applied.length, migrations.length);
    console.log(`PASS: ${migrations.length} unmodified SQL migrations applied through pg wire protocol`);
  } finally { client.release(); await migrationPool.end(); }
  await connectApp();
  const fixtures = createDemoRepository();
  for (const type of ['legal_entity', 'store', 'actor', 'credential']) {
    const values = await fixtures.list(type);
    await repository.commit({ changes: values.map(value => ({ type, id: value.id,
      ...(type === 'store' ? { storeId: value.id } : {}), expectedVersion: null, value })) });
  }
  await fixtures.close();
  const hrResponse = await app.inject({ method: 'POST', url: `/api/v2/oda/${storeId}/hr/commands`,
    headers: { ...owner, 'idempotency-key': randomUUID() }, payload: { expectedVersion: 0, type: 'employee.create',
      input: { employeeNumber: 'ESIGN-PG-01', name: '영속검증 직원', actorId: DEMO_IDS.staff, hireDate: '2026-01-01', payType: 'monthly', basePay: 3000000 } } });
  assert.equal(hrResponse.statusCode, 200, hrResponse.body);
  const employeeId = hrResponse.json().workspace.employees[0].id;
  const employerInput = { expectedVersion: 0, legalName: '전자계약 검증 사업자', businessNumber: businessNumber('123456789'), representativeName: '테스트 대표', address: '서울 합성 주소', signerActorId: DEMO_IDS.owner };
  const employer = (await post('/employers', employerInput)).json().employer;
  await post('/employers', employerInput, owner, 409);
  const secondEmployer = (await post('/employers', { ...employerInput, legalName: '두 번째 사업자', businessNumber: businessNumber('987654321') })).json().employer;
  assert.notEqual(employer.id, secondEmployer.id); assert.equal((await get()).json().employers.length, 2);
  const terms = { employmentType: 'regular', payType: 'monthly', basePay: 3200000, effectiveDate: '2026-01-01', endDate: '',
    jobTitle: '매장 운영', workplace: '서울 합성 매장', workDays: '월~금', dailyWorkHours: '월~금 각 8시간', workStart: '09:00', workEnd: '18:00', breakMinutes: 60,
    payday: '매월 25일', payCalculation: '기본급 320만원, 연장근로 별도', payMethod: '본인 계좌 이체', holidays: '일요일 유급 주휴일', annualLeave: '법정 기준', additionalTerms: '영속 검증용 문구 582374' };
  let contract = (await post('/contracts', { expectedVersion: 0, employerId: employer.id, employeeId, title: '근로계약서 영속검증', templateKey: 'monthly-v1', terms })).json().contract;
  await get(`/contracts/${contract.id}`, staff, 404);
  contract = (await post(`/contracts/${contract.id}/request`, { expectedVersion: contract.version, expiresAt: new Date(Date.now() + 86400000).toISOString() })).json().contract;
  assert.equal(contract.status, 'pending');
  const pendingVersion = contract.version;
  contract = (await post(`/contracts/${contract.id}/sign`, signature(contract, 'employer'))).json().contract;
  assert.equal(contract.status, 'pending'); assert.equal(contract.signatures.length, 1);
  await reconnect();
  const restored = (await get(`/contracts/${contract.id}`, staff)).json().contract;
  assert.deepEqual(restored, contract);
  assert.equal((await repository.list('oda_contract_artifact', [storeId])).length, 0);
  console.log('PASS: requested contract and initial employer signature persist across full DB process restart');

  const finalKey = randomUUID(); const finalPayload = signature(restored, 'employee');
  contract = (await post(`/contracts/${contract.id}/sign`, finalPayload, staff, 200, finalKey)).json().contract;
  assert.equal(contract.status, 'completed'); assert.equal(contract.signatures.length, 2);
  assert.equal(contract.version, pendingVersion + 2); assert.ok(contract.artifacts?.contract.sha256); assert.ok(contract.artifacts?.evidence.sha256);
  const originalContract = await get(`/contracts/${contract.id}/pdf`, staff);
  const originalEvidence = await get(`/contracts/${contract.id}/evidence`, staff);
  for (const response of [originalContract, originalEvidence]) {
    assert.equal(response.rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal(response.headers['x-content-sha256'], createHash('sha256').update(response.rawPayload).digest('hex'));
  }
  const records = await repository.list('oda_contract_artifact', [storeId]); assert.equal(records.length, 2);
  assert.equal(contract.deliveries.length, 0);
  const completedSnapshot = structuredClone(contract);
  await reconnect();
  assert.deepEqual((await get(`/contracts/${contract.id}`, staff)).json().contract, completedSnapshot);
  assert.deepEqual((await get(`/contracts/${contract.id}/pdf`, staff)).rawPayload, originalContract.rawPayload);
  assert.deepEqual((await get(`/contracts/${contract.id}/evidence`, staff)).rawPayload, originalEvidence.rawPayload);
  const replay = await post(`/contracts/${contract.id}/sign`, finalPayload, staff, 200, finalKey);
  assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.equal(replay.json().contract.signatures.length, 2);
  assert.equal((await repository.list('oda_contract_artifact', [storeId])).length, 2);
  console.log('PASS: final signature, immutable PDF/evidence bytes, hashes and idempotency survive second DB restart');

  await directQueries(async pool => {
    const rejectUpdate = (field, json) => assert.rejects(() => pool.query(
      "UPDATE aggregate_snapshots SET payload=jsonb_set(payload,$1::text[],$2::jsonb) WHERE aggregate_type='oda_contract' AND aggregate_id=$3",
      [[field], JSON.stringify(json), contract.id]), error => error.code === '23514');
    await rejectUpdate('documentText', '변조된 본문');
    await rejectUpdate('employeeActorId', DEMO_IDS.master);
    await rejectUpdate('signatures', []);
    await rejectUpdate('artifacts', {});
    await assert.rejects(() => pool.query("UPDATE aggregate_snapshots SET store_id=$1 WHERE aggregate_type='oda_contract' AND aggregate_id=$2", [DEMO_IDS.storeHapjeong, contract.id]), error => error.code === '23514');
    await assert.rejects(() => pool.query("DELETE FROM aggregate_snapshots WHERE aggregate_type='oda_contract' AND aggregate_id=$1", [contract.id]), error => error.code === '23514');
    await assert.rejects(() => pool.query("UPDATE aggregate_snapshots SET payload='{}' WHERE aggregate_type='oda_contract_artifact' AND aggregate_id=$1", [`${contract.id}:contract`]), error => error.code === '23514');
    await assert.rejects(() => pool.query("DELETE FROM aggregate_snapshots WHERE aggregate_type='oda_contract_artifact' AND aggregate_id=$1", [`${contract.id}:contract`]), error => error.code === '23514');
  });
  const delivered = (await post(`/contracts/${contract.id}/delivery`, { expectedVersion: contract.version, method: 'manual_handover', evidenceNote: '합성 테스트: 완료본 출력 교부 후 수령 확인' })).json().contract;
  assert.equal(delivered.deliveries.length, 1);
  const applied = (await post(`/contracts/${contract.id}/apply`, { expectedVersion: delivered.version })).json().contract;
  assert.ok(applied.appliedAt);
  assert.equal((await repository.get('oda_hr', `hr:${storeId}`)).employees[0].basePay, 3200000);
  assert.deepEqual((await get(`/contracts/${contract.id}/pdf`, staff)).rawPayload, originalContract.rawPayload);
  assert.deepEqual((await get(`/contracts/${contract.id}/evidence`, staff)).rawPayload, originalEvidence.rawPayload);
  await reconnect();
  assert.deepEqual((await get(`/contracts/${contract.id}`, staff)).json().contract, applied);
  assert.equal((await repository.get('oda_hr', `hr:${storeId}`)).employees[0].basePay, 3200000);
  assert.deepEqual((await get(`/contracts/${contract.id}/pdf`, staff)).rawPayload, originalContract.rawPayload);
  console.log('PASS: direct SQL tampering blocked; delivery and atomic HR application work without rewriting completed PDFs');
  console.log(`PASS: full electronic contract API lifecycle through PostgresRepository, ${restarts} complete disk-backed PGlite process restarts`);
} finally {
  if (app) await app.close(); else if (repository) await repository.close();
  await stopEngine(); await rm(directory, { recursive: true, force: true });
}
