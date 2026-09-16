import { PostgresRoutineStore, nextRoutineTime, type OdaRoutine, type StateRepository } from '@ofd/db';
import { DomainError } from '@ofd/domain';
import { decryptPosSecret, encryptPosSecret } from '@ofd/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { previewOdaBatch, requireOdaAutomationStore, requireOdaIntegration, validateOdaIntegrationToken, type IntegrationToken } from './oda-automation.ts';
import { OdaRoutineScheduler, makeRoutineRunState, publicRoutine, publicRoutineRun, routineEndpoint, runnerRequest, verifyProtectedRoutineRunner } from './oda-routine-runner.ts';

const base = '/api/v2/oda/integration';
const uuid = z.uuid();
const definition = z.object({ id: uuid, title: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(16000),
  storeId: z.string().min(1).max(120), timeZone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'IANA 시간대를 입력해 주세요.'),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(v => new Set(v).size === v.length),
  enabled: z.boolean(), mode: z.enum(['report', 'oda_batch']), expectedVersion: z.number().int().positive().optional(),
  runner: z.object({ endpoint: z.string().max(2000), token: z.string().min(16).max(4096).regex(/^[^\r\n]+$/) }).strict(),
}).strict();
const versionBody = z.object({ expectedVersion: z.number().int().positive() }).strict();
function scope(token: IntegrationToken, storeId?: string) {
  if (!token.routines || storeId && !token.storeIds.includes(storeId)) throw new DomainError('ODA_ROUTINE_SCOPE', '이 연결에 해당 매장의 예약 실행 권한이 없습니다.', 403);
}
function boundedListing<T extends { routines?: unknown[]; runs: unknown[] }>(value: T) {
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(value), 'utf8') > 900000) {
    if (value.runs.length > 1) value.runs.pop();
    else if (value.routines && value.routines.length > 1) value.routines.pop();
    else break;
    truncated = true;
  }
  return { ...value, truncated };
}

export function registerOdaRoutineRoutes(app: FastifyInstance, repository: StateRepository, env: NodeJS.ProcessEnv) {
  const durable = !!env.DATABASE_URL && (env.REPOSITORY_MODE === 'postgres' || env.APP_MODE === 'production');
  const configured = durable && !!env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length >= 32;
  const store = configured ? PostgresRoutineStore.fromEnv(env) : null;
  const authorize = async (tokenId: string, storeId: string) => {
    const { token, actor } = await validateOdaIntegrationToken(repository, tokenId);
    scope(token, storeId); await requireOdaAutomationStore(repository, actor, storeId, true);
  };
  const scheduler = store ? new OdaRoutineScheduler(store, env.ENCRYPTION_KEY!, authorize, undefined, undefined, async (run, output) => {
    let input: unknown;
    try { input = JSON.parse(output); } catch { throw new DomainError('ODA_BATCH_JSON', '수집 결과가 JSON 형식이 아닙니다. 원본 결과를 확인해 주세요.', 422); }
    const parsed = z.object({ month: z.unknown(), source: z.unknown(), lines: z.unknown() }).strict().safeParse(input);
    if (!parsed.success) throw new DomainError('ODA_BATCH_FORMAT', '수집 결과에 정산월·출처·거래 목록이 없거나 추가 지시가 포함되어 있습니다. 원본 결과를 확인해 주세요.', 422);
    const { token } = await validateOdaIntegrationToken(repository, run.tokenId);
    const batch = await previewOdaBatch(repository, token, { ...parsed.data, batchId: run.id, storeId: run.storeId });
    return batch.id;
  }) : null;
  const ready = () => {
    if (!store || !scheduler) throw new DomainError('ODA_ROUTINE_UNAVAILABLE', '지속 저장소와 암호화 키가 구성된 ODA 서버가 필요합니다.', 503);
    return { store, scheduler };
  };
  const auth = async (request: FastifyRequest) => { const context = await requireOdaIntegration(request, repository); scope(context.token); return context; };
  const getRoutine = async (request: FastifyRequest) => {
    const { token, actor } = await auth(request), id = uuid.parse((request.params as { id: string }).id);
    const value = await ready().store.get(token.id, id);
    if (!value) throw new DomainError('ODA_ROUTINE_NOT_FOUND', '예약을 찾을 수 없습니다.', 404);
    scope(token, value.storeId); await requireOdaAutomationStore(repository, actor, value.storeId, true);
    return { token, value };
  };
  app.get(`${base}/routines`, async request => {
    const { token } = await auth(request);
    if (!store) return { routines: [], runs: [], runner: { available: false, kind: 'hermes-server', pcRequired: false } };
    return boundedListing({ routines: (await store.list(token.id)).filter(value => token.storeIds.includes(value.storeId)).map(value => ({ ...publicRoutine(value), prompt: value.definition.prompt.slice(0, 1000), promptTruncated: value.definition.prompt.length > 1000 })),
      runs: (await store.runs(token.id)).filter(value => token.storeIds.includes(value.storeId)).slice(0, 20).map(value => publicRoutineRun(value, true)),
      runner: { available: true, kind: 'hermes-server', pcRequired: false } });
  });
  app.get(`${base}/routines/:id`, async request => ({ routine: publicRoutine((await getRoutine(request)).value) }));
  app.post(`${base}/routines`, async request => {
    const { token, actor } = await auth(request), body = definition.parse(request.body), { store } = ready();
    scope(token, body.storeId); await requireOdaAutomationStore(repository, actor, body.storeId, true);
    const existing = await store.get(token.id, body.id);
    const endpoint = routineEndpoint(body.runner.endpoint);
    if (existing && body.expectedVersion === undefined) {
      const original = existing.definition;
      const same = existing.storeId === body.storeId && existing.enabled === body.enabled && original.title === body.title
        && original.prompt === body.prompt && original.timeZone === body.timeZone && original.time === body.time
        && JSON.stringify(original.weekdays) === JSON.stringify([...body.weekdays].sort()) && original.mode === body.mode
        && original.runnerEndpoint === endpoint && decryptPosSecret(existing.runnerSecretEnc, env.ENCRYPTION_KEY!) === body.runner.token;
      if (same) return { routine: publicRoutine(existing) };
    }
    if (existing && (existing.version !== body.expectedVersion || existing.storeId !== body.storeId)) throw new DomainError('ODA_ROUTINE_CHANGED', '예약이 변경되었습니다. 새로 확인해 주세요.', 409);
    if (!existing && (await store.list(token.id)).length >= 100) throw new DomainError('ODA_ROUTINE_LIMIT', '연결별 예약 한도 100개에 도달했습니다.', 409);
    const caps = await verifyProtectedRoutineRunner({ endpoint, token: body.runner.token });
    const now = new Date().toISOString();
    const value: OdaRoutine = { id: body.id, tokenId: token.id, storeId: body.storeId,
      definition: { title: body.title, prompt: body.prompt, timeZone: body.timeZone, time: body.time, weekdays: [...body.weekdays].sort(), mode: body.mode, runnerEndpoint: endpoint, ...caps },
      runnerSecretEnc: encryptPosSecret(body.runner.token, env.ENCRYPTION_KEY!), enabled: body.enabled,
      nextRunAt: body.enabled ? nextRoutineTime(body, new Date(now)) : null, lastRunAt: existing?.lastRunAt ?? null,
      version: existing?.version ?? 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
    const saved = await store.save(value, existing?.version ?? null);
    if (!saved) throw new DomainError('ODA_ROUTINE_CHANGED', '예약이 변경되었습니다. 새로 확인해 주세요.', 409);
    return { routine: publicRoutine(saved) };
  });
  for (const action of ['pause', 'resume'] as const) {
    app.post(`${base}/routines/:id/${action}`, async request => {
      const { value } = await getRoutine(request), body = versionBody.parse(request.body);
      if (body.expectedVersion !== value.version) throw new DomainError('ODA_ROUTINE_CHANGED', '예약이 변경되었습니다.', 409);
      const enabled = action === 'resume', now = new Date();
      const saved = await ready().store.save({ ...value, enabled, nextRunAt: enabled ? nextRoutineTime(value.definition, now) : null, updatedAt: now.toISOString() }, value.version);
      if (!saved) throw new DomainError('ODA_ROUTINE_CHANGED', '예약이 변경되었습니다.', 409);
      return { routine: publicRoutine(saved) };
    });
  }
  app.post(`${base}/routines/:id/run`, async request => {
    const { token, value } = await getRoutine(request), body = z.object({ id: uuid }).strict().parse(request.body);
    const run = await ready().store.enqueueNow(token.id, value.id, body.id, new Date(), makeRoutineRunState);
    if (!run) throw new DomainError('ODA_ROUTINE_ACTIVE', '이 예약의 실행 또는 확인이 필요한 이전 실행이 남아 있습니다.', 409);
    return { run: publicRoutineRun(run) };
  });
  app.get(`${base}/runs`, async request => {
    const { token } = await auth(request);
    return boundedListing({ runs: (await ready().store.runs(token.id)).filter(value => token.storeIds.includes(value.storeId)).slice(0, 20).map(value => publicRoutineRun(value, true)) });
  });
  app.get(`${base}/runs/:id`, async request => {
    const { token, actor } = await auth(request), id = uuid.parse((request.params as { id: string }).id);
    const value = await ready().store.getRun(token.id, id);
    if (!value) throw new DomainError('ODA_ROUTINE_NOT_FOUND', '실행을 찾을 수 없습니다.', 404);
    scope(token, value.storeId); await requireOdaAutomationStore(repository, actor, value.storeId, true);
    return { run: publicRoutineRun(value) };
  });
  app.post(`${base}/runs/:id/resolve`, async request => {
    const { token, actor } = await auth(request), id = uuid.parse((request.params as { id: string }).id);
    const body = z.object({ confirmedStopped: z.literal(true), note: z.string().trim().min(10).max(2000) }).strict().parse(request.body);
    const { store } = ready(), initial = await store.getRun(token.id, id);
    if (!initial) throw new DomainError('ODA_ROUTINE_NOT_FOUND', '실행을 찾을 수 없습니다.', 404);
    scope(token, initial.storeId); await requireOdaAutomationStore(repository, actor, initial.storeId, true);
    if (initial.status !== 'unknown') throw new DomainError('ODA_ROUTINE_RESOLVE_STATE', '실행 확인이 필요한 상태에만 종료 확인을 기록할 수 있습니다.', 409);
    const value = await store.claim(new Date(), id, token.id);
    if (!value || value.status !== 'unknown') throw new DomainError('ODA_ROUTINE_BUSY', '실행 상태가 변경되었습니다. 다시 확인해 주세요.', 409);
    try {
      let nativeStatus: string | null = null;
      if (value.state.runId) {
        const native = await runnerRequest({ endpoint: value.state.runnerEndpoint, token: decryptPosSecret(value.runnerSecretEnc, env.ENCRYPTION_KEY!) }, `/v1/runs/${value.state.runId}`);
        if (native.object !== 'hermes.run' || native.run_id !== value.state.runId || !['completed', 'failed', 'cancelled', 'interrupted'].includes(native.status))
          throw new DomainError('ODA_ROUTINE_STILL_ACTIVE', 'Hermes에서 이 실행이 종료되었는지 확인되지 않았습니다. 먼저 실행을 중지해 주세요.', 409);
        nativeStatus = native.status;
      }
      return { run: publicRoutineRun(await store.resolveUnknown(value, actor.id, body.note, nativeStatus, new Date())) };
    } catch (error) { await store.updateRun(value, new Date()); throw error; }
  });
  for (const action of ['stop', 'approval'] as const) {
    app.post(`${base}/runs/:id/${action}`, async request => {
      const { token, actor } = await auth(request), id = uuid.parse((request.params as { id: string }).id);
      const { store, scheduler } = ready(), value = await store.getRun(token.id, id);
      if (!value) throw new DomainError('ODA_ROUTINE_NOT_FOUND', '실행을 찾을 수 없습니다.', 404);
      scope(token, value.storeId); await requireOdaAutomationStore(repository, actor, value.storeId, true);
      const control = action === 'stop'
        ? (z.object({}).strict().parse(request.body), { kind: 'stop' as const })
        : { kind: 'approval' as const, ...z.object({ requestId: z.string().min(1).max(200), choice: z.enum(['once', 'deny']) }).strict().parse(request.body) };
      return { run: publicRoutineRun(await scheduler.control(token.id, id, control)) };
    });
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  // Startup registration is a code capability, not permission to create jobs.
  // Only explicitly saved enabled routines or explicit /run calls enqueue work.
  const tick = () => {
    if (inFlight || !scheduler) return;
    inFlight = scheduler.tick().catch(() => { app.log.warn({ code: 'ODA_ROUTINE_TICK_FAILED' }, '예약 실행 상태를 확인하지 못했습니다. 다음 주기에 재확인합니다.'); }).finally(() => { inFlight = undefined; });
  };
  app.addHook('onReady', async () => { if (scheduler) { tick(); timer = setInterval(tick, 15000); timer.unref(); } });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); await inFlight; await store?.close(); });
}
