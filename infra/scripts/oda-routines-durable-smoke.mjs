import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '../testing/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { encryptPosSecret } from '../../packages/integrations/src/tossplace.ts';
import { PostgresRoutineStore, nextRoutineTime } from '../../packages/db/src/oda-routines.ts';
import { OdaRoutineScheduler, makeRoutineRunState } from '../../apps/api/src/oda-routine-runner.ts';

// Isolated synthetic disk-backed PostgreSQL engine. This script never reads
// DATABASE_URL, never starts a real run, and never changes any owner account.
const directory = await mkdtemp(join(tmpdir(), 'oda-routines-durable-'));
let db = new PGlite(directory);
const adapter = {
  async query(sql, params) { const result = await db.query(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; },
  async connect() { return { query: adapter.query, release() {} }; },
  async end() {},
};
let store = new PostgresRoutineStore(adapter);
const key = 'synthetic-encryption-key-at-least-32-characters';
const now = new Date('2026-09-16T01:00:00Z');
const definition = { title: 'Synthetic durable read', prompt: 'Read synthetic source', timeZone: 'Asia/Seoul', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6], mode: 'report', runnerEndpoint: 'https://hermes.example.com', retentionSeconds: 600, approvalSupported: true };
const routine = { id: randomUUID(), tokenId: 'token-a', storeId: 'store-a', definition,
  runnerSecretEnc: encryptPosSecret('synthetic-runner-token', key), enabled: true, nextRunAt: '2026-09-01T00:00:00.000Z', lastRunAt: null,
  version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
const requests = []; let loseReply = true; let clock = now;
const transport = async (_config, path, body, idempotencyKey) => {
  if (path === '/v1/capabilities') return { object: 'hermes.api_server.capabilities', features: { run_submission: true, run_status: true, run_stop: true, runs_idempotency: { durable: true, retention_seconds: 600 } } };
  if (path === '/v1/runs') {
    const disk = await store.getRun('token-a', idempotencyKey.slice('oda-routine:'.length));
    assert.equal(disk.status, 'submitting'); assert.ok(disk.state.attemptedAt);
    requests.push({ idempotencyKey, body: structuredClone(body) });
    if (loseReply) { loseReply = false; throw new Error('Synthetic network lost AFTER upstream admission'); }
    return { run_id: 'synthetic-native-run' };
  }
  return { object: 'hermes.run', run_id: 'synthetic-native-run', status: 'completed', output: 'Synthetic verified output' };
};
try {
  await db.exec(await readFile(new URL('../../packages/db/migrations/013_oda_routines.sql', import.meta.url), 'utf8'));
  assert.ok(await store.save(routine, null));
  assert.equal((await store.list('token-other')).length, 0);
  assert.equal(await store.get('token-other', routine.id), null);
  await store.enqueueDue(now, makeRoutineRunState);
  const firstList = await store.runs('token-a'); assert.equal(firstList.length, 1);
  assert.equal((await store.get('token-a', routine.id)).nextRunAt, '2026-09-17T00:00:00.000Z');
  assert.equal(firstList[0].scheduledFor, '2026-09-01T00:00:00.000Z');
  console.log('PASS: missed 15 daily slots coalesce into one persisted invocation; token isolation');
  const claims = await Promise.all([store.claim(now), store.claim(now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  let scheduler = new OdaRoutineScheduler(store, key, async () => {}, transport, () => clock);
  await scheduler.advance(claims.find(Boolean));
  const before = await store.getRun('token-a', firstList[0].id);
  assert.equal(before.status, 'submitting'); assert.ok(before.state.retryUntil);
  await db.close(); db = new PGlite(directory); store = new PostgresRoutineStore(adapter);
  clock = new Date(now.getTime() + 20000);
  scheduler = new OdaRoutineScheduler(store, key, async () => {}, transport, () => clock);
  const recovered = await store.claim(clock); assert.equal(recovered.id, firstList[0].id);
  await scheduler.advance(recovered);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal((await store.getRun('token-a', firstList[0].id)).status, 'completed');
  console.log('PASS: single claim, response loss, database restart, SAME durable native idempotency key/request');
  clock = new Date('2026-09-18T01:00:00Z');
  await store.enqueueDue(clock, makeRoutineRunState);
  const second = await store.claim(clock); second.status = 'unknown'; second.state.error = 'Synthetic uncertain admission'; await store.updateRun(second, clock);
  await store.enqueueDue(new Date('2026-09-20T01:00:00Z'), makeRoutineRunState);
  assert.equal((await store.runs('token-a')).length, 2);
  assert.equal(await store.enqueueNow('token-a', routine.id, randomUUID(), clock, makeRoutineRunState), null);
  assert.equal((await store.get('token-a', routine.id)).nextRunAt, '2026-09-21T00:00:00.000Z');
  console.log('PASS: uncertain and overlapping runs never spawn replacements; missed slots bounded');
  const unresolved = await store.claim(new Date('2026-09-20T01:00:00Z'), second.id, 'token-a');
  assert.equal(unresolved.status, 'unknown');
  const resolved = await store.resolveUnknown(unresolved, 'synthetic-owner', 'Checked synthetic upstream; no active native execution.', null, new Date('2026-09-20T01:00:00Z'));
  assert.equal(resolved.status, 'cancelled');
  assert.equal((await adapter.query('SELECT * FROM oda_routine_run_resolutions WHERE run_id=$1', [second.id])).rows.length, 1);
  await assert.rejects(store.resolveUnknown(unresolved, 'synthetic-owner', 'Cannot rewrite original confirmation.', null, new Date('2026-09-20T01:01:00Z')));
  assert.equal((await adapter.query('SELECT note FROM oda_routine_run_resolutions WHERE run_id=$1', [second.id])).rows[0].note, 'Checked synthetic upstream; no active native execution.');
  console.log('PASS: uncertain lock release records immutable owner confirmation; repeated resolution cannot overwrite');
  const paused = await store.get('token-a', routine.id);
  assert.equal(await store.save({ ...paused, enabled: false }, paused.version + 1), null);
  assert.ok(await store.save({ ...paused, enabled: false }, paused.version));
  assert.equal(nextRoutineTime(definition, now), '2026-09-17T00:00:00.000Z');
  const stateJson = JSON.stringify((await adapter.query('SELECT state FROM oda_routine_runs')).rows);
  assert.equal(stateJson.includes('synthetic-runner-token'), false);
  console.log('PASS: optimistic schedule updates and credential separation');
} finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
