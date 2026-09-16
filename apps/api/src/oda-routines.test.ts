import { describe, expect, it } from 'vitest';
import { encryptPosSecret } from '@ofd/integrations';
import { DomainError } from '@ofd/domain';
import { nextRoutineTime, type OdaRoutine, type OdaRoutineRun, type PostgresRoutineStore } from '@ofd/db';
import { OdaRoutineScheduler, makeRoutineRunState, publicRoutine, publicRoutineRun, publicRunnerAddress, routineEndpoint, type RunnerTransport } from './oda-routine-runner.ts';

const key = 'synthetic-encryption-key-32-characters';
const token = 'synthetic-runner-token-do-not-leak';
const instant = new Date('2026-09-16T01:00:00Z');
const routine: OdaRoutine = { id: '11c0d4ed-442a-4988-bf3c-0deea2163ca9', tokenId: 'synthetic-token', storeId: 'synthetic-store',
  definition: { title: 'Synthetic read', prompt: 'Read public synthetic data', timeZone: 'Asia/Seoul', time: '09:00', weekdays: [1, 2, 3, 4, 5], mode: 'report', runnerEndpoint: 'https://hermes.example.com', retentionSeconds: 600, approvalSupported: true },
  runnerSecretEnc: encryptPosSecret(token, key), enabled: true, nextRunAt: instant.toISOString(), lastRunAt: null, version: 1, createdAt: instant.toISOString(), updatedAt: instant.toISOString() };
function fixture() {
  const id = '683bdc0f-65b1-4edc-b9d9-55bdbe093a00';
  const run: OdaRoutineRun = { id, routineId: routine.id, tokenId: routine.tokenId, storeId: routine.storeId,
    scheduledFor: instant.toISOString(), status: 'queued', state: makeRoutineRunState(routine, id, instant.toISOString()),
    runnerSecretEnc: routine.runnerSecretEnc, leaseId: 'lease', createdAt: instant.toISOString(), updatedAt: instant.toISOString() };
  const saved: OdaRoutineRun[] = []; let paused = false;
  const store = { async updateRun(value: OdaRoutineRun) { saved.push(structuredClone(value)); }, async pause() { paused = true; } } as unknown as PostgresRoutineStore;
  return { run, store, saved, paused: () => paused };
}
const capabilities = { object: 'hermes.api_server.capabilities', features: { run_submission: true, run_status: true, run_stop: true, runs_idempotency: { durable: true, retention_seconds: 600 }, run_approval_response: true, approval_events: true } };

describe('server routine scheduling and boundary', () => {
  it('schedules Korean weekdays in UTC and skips missed intervals', () => {
    expect(nextRoutineTime(routine.definition, new Date('2026-09-18T00:01:00Z'))).toBe('2026-09-21T00:00:00.000Z');
  });
  it('skips missing DST wall times and does not repeat an autumn local date', () => {
    const def = { timeZone: 'America/New_York', time: '02:30', weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextRoutineTime(def, new Date('2026-03-08T05:00:00Z'))).toBe('2026-03-09T06:30:00.000Z');
    expect(nextRoutineTime({ ...def, time: '01:30' }, new Date('2026-11-01T05:31:00Z'), '2026-11-01')).toBe('2026-11-02T06:30:00.000Z');
  });
  it('blocks SSRF destinations and credential-bearing URLs', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '100.100.100.200', '169.254.169.254', '172.16.0.2', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1']) expect(publicRunnerAddress(address)).toBe(false);
    expect(publicRunnerAddress('8.8.8.8')).toBe(true);
    for (const endpoint of ['http://example.com', 'https://127.0.0.1', 'https://foo.local', 'https://a:b@example.com', 'https://example.com?token=x', 'https://example.com:8443']) expect(() => routineEndpoint(endpoint)).toThrow();
    expect(routineEndpoint('https://hermes.example.com/profile/v1/')).toBe('https://hermes.example.com/profile');
  });
  it('redacts internal encrypted credentials and request bodies from API results', () => {
    const { run } = fixture();
    expect(JSON.stringify(publicRoutine(routine))).not.toContain(routine.runnerSecretEnc);
    expect(JSON.stringify(publicRoutineRun(run))).not.toContain('OWNER SCHEDULED');
    expect(JSON.stringify(publicRoutineRun(run))).not.toContain(token);
  });
});

describe('durable native run admission', () => {
  it('persists invocation before submission and retries response loss with the SAME key/request', async () => {
    const { run, store, saved } = fixture(); const keys: string[] = []; const requests: unknown[] = []; let first = true;
    const transport: RunnerTransport = async (_config, path, body, idempotencyKey) => {
      if (path === '/v1/capabilities') return capabilities;
      if (path === '/v1/runs') {
        expect(saved.at(-1)?.state.attemptedAt).toBeTruthy(); expect(saved.at(-1)?.status).toBe('submitting');
        keys.push(idempotencyKey!); requests.push(body);
        if (first) { first = false; throw new Error('synthetic lost reply'); }
        return { run_id: 'run-synthetic' };
      }
      return { object: 'hermes.run', run_id: 'run-synthetic', status: 'completed', output: `done ${token}` };
    };
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, transport, () => instant);
    await scheduler.advance(run); await scheduler.advance(run);
    expect(keys).toEqual([`oda-routine:${run.id}`, `oda-routine:${run.id}`]);
    expect(requests[0]).toEqual(requests[1]); expect(run.status).toBe('completed');
    expect(run.state.output).toBe('done [REDACTED]');
  });
  it('never replays uncertain acceptance outside retention and pauses new occurrences', async () => {
    const { run, store, paused } = fixture(); let requests = 0;
    run.state.attemptedAt = '2026-09-15T01:00:00Z'; run.state.retryUntil = '2026-09-15T02:00:00Z';
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, async () => { requests++; return {}; }, () => instant);
    await scheduler.advance(run); expect(requests).toBe(0); expect(run.status).toBe('unknown'); expect(paused()).toBe(true);
  });
  it('checks issuer/token authorization before all upstream work', async () => {
    const { run, store } = fixture(); let requests = 0;
    const scheduler = new OdaRoutineScheduler(store, key, async () => { throw new DomainError('REVOKED', 'revoked', 401); }, async () => { requests++; return {}; }, () => instant);
    await scheduler.advance(run); expect(requests).toBe(0); expect(run.status).toBe('cancelled');
  });
  it('retries transient authorization-store failure without permanently cancelling the schedule', async () => {
    const { run, store, paused } = fixture(); let requests = 0;
    const scheduler = new OdaRoutineScheduler(store, key, async () => { throw new Error('database unavailable'); }, async () => { requests++; return {}; }, () => instant);
    await scheduler.advance(run); expect(requests).toBe(0); expect(run.status).toBe('queued'); expect(paused()).toBe(false);
  });
  it('exposes native approval without auto-answering and rejects a stale exact request', async () => {
    const { run, store } = fixture(); run.state.runId = 'native'; run.state.attemptedAt = instant.toISOString();
    const calls: string[] = [];
    const transport: RunnerTransport = async (_config, path, body) => {
      calls.push(path);
      if (path.endsWith('/approval')) return { object: 'hermes.run.approval_response', run_id: 'native', request_id: 'approval-1', choice: 'once', resolved: 1 };
      expect(body).toBeUndefined();
      return { object: 'hermes.run', run_id: 'native', status: 'waiting_for_approval', approval: { request_id: 'approval-1', description: 'Synthetic specific action', choices: ['once', 'deny', 'always'] } };
    };
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, transport, () => instant);
    await scheduler.advance(run); expect(calls).toEqual(['/v1/runs/native']);
    expect(run.state.approval?.choices).toEqual(['once', 'deny']);
    await expect(scheduler.advance(run, { kind: 'approval', requestId: 'stale', choice: 'once' })).rejects.toThrow();
    expect(calls.filter(p => p.endsWith('/approval'))).toHaveLength(0);
    await scheduler.advance(run, { kind: 'approval', requestId: 'approval-1', choice: 'once' });
    expect(calls.filter(p => p.endsWith('/approval'))).toHaveLength(1);
  });
  it('stages collected ODA JSON with deterministic ID and never approves or posts it', async () => {
    const { run, store } = fixture(); run.state.mode = 'oda_batch'; run.state.runId = 'native';
    const output = JSON.stringify({ month: '2026-09', source: {}, lines: [] });
    const staged: unknown[] = [];
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, async () => ({ object: 'hermes.run', run_id: 'native', status: 'completed', output }), () => instant,
      async (value, text) => { staged.push({ id: value.id, storeId: value.storeId, output: text }); return value.id; });
    await scheduler.advance(run);
    expect(staged).toEqual([{ id: run.id, storeId: routine.storeId, output }]);
    expect(run.state.batchId).toBe(run.id); expect(run.status).toBe('completed');
    await scheduler.advance(run); expect(staged).toHaveLength(1);
  });
  it('preserves invalid financial output for review with no fake posted result', async () => {
    const { run, store } = fixture(); run.state.mode = 'oda_batch'; run.state.runId = 'native';
    const output = '{"blocked":"No source account is logged in"}';
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, async () => ({ object: 'hermes.run', run_id: 'native', status: 'completed', output }), () => instant,
      async () => { throw new Error('Synthetic schema validation'); });
    await scheduler.advance(run);
    expect(run.status).toBe('needs_review'); expect(run.state.batchId).toBeUndefined();
    expect(run.state.output).toBe(output); expect(run.state.error).toContain('입력 형식');
  });
  it('does not blindly retransmit an approval after response loss', async () => {
    const { run, store } = fixture(); run.state.runId = 'native'; run.state.attemptedAt = instant.toISOString(); let approvals = 0;
    const scheduler = new OdaRoutineScheduler(store, key, async () => {}, async (_config, path) => {
      if (path.endsWith('/approval')) { approvals++; throw new Error('Synthetic approval lost reply'); }
      return { object: 'hermes.run', run_id: 'native', status: 'waiting_for_approval', approval: { request_id: 'specific', choices: ['once', 'deny'] } };
    }, () => instant);
    await expect(scheduler.advance(run, { kind: 'approval', requestId: 'specific', choice: 'once' })).rejects.toThrow();
    await expect(scheduler.advance(run, { kind: 'approval', requestId: 'specific', choice: 'once' })).rejects.toThrow();
    expect(approvals).toBe(1); expect(run.state.uncertainApproval).toBe('specific');
  });
});
