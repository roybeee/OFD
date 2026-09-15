import { randomUUID } from 'node:crypto';
import type { StateRepository } from '@ofd/db';
import { applyHrCommand, capabilitiesForPages, createHrWorkspace, DomainError, projectHrWorkspace,
  type Actor, type HrContext, type HrResponse, type HrWorkspace, type Store } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from './events.ts';
import { idempotentMutation } from './idempotency.ts';
import { ACCESS_POLICY_ID, resolveVisiblePages, type AccessPolicyDocument } from './service.ts';

const paramsSchema = z.object({ storeId: z.string().trim().min(1).max(120) }).strict();
const commandSchema = z.object({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  type: z.string().regex(/^[a-z][a-zA-Z0-9_.-]{1,100}$/), input: z.record(z.string(), z.unknown()) }).strict();
const linkableRoles = ['store_owner', 'store_staff', 'hq_master', 'hq_finance'];

async function scope(repository: StateRepository, actor: Actor, storeId: string): Promise<Store> {
  if (!actor.active || !['store_owner', 'store_staff', 'hq_master', 'hq_finance', 'auditor'].includes(actor.role)
    || (['store_owner', 'store_staff'].includes(actor.role) && !actor.storeIds.includes(storeId))
    || (actor.storeIds.length > 0 && !actor.storeIds.includes(storeId))) {
    throw new DomainError('HR_FORBIDDEN', '이 매장의 인사관리를 조회할 권한이 없습니다.', 403);
  }
  const policy = await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID);
  const capabilities = capabilitiesForPages(actor.role, resolveVisiblePages(actor, policy));
  if (!capabilities.some(value => value === 'oda.hr.read' || value === 'oda.hr.hq.read')) throw new DomainError('HR_FORBIDDEN', '인사관리 접근 권한이 없습니다.', 403);
  const store = await repository.get<Store>('store', storeId);
  if (!store?.active) throw new DomainError('HR_STORE_NOT_FOUND', '운영 중인 매장을 찾을 수 없습니다.', 404);
  return store;
}
function context(actor: Actor, workspace: HrWorkspace): HrContext {
  const employee = actor.role === 'auditor' ? undefined : workspace.employees.find(row => row.actorId === actor.id && row.status !== 'retired');
  const now = new Date().toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return { actorId: actor.id, ...(employee ? { employeeId: employee.id } : {}), manager: ['store_owner', 'hq_master'].includes(actor.role),
    payroll: ['store_owner', 'hq_master', 'hq_finance'].includes(actor.role), today, now, id: randomUUID };
}
async function load(repository: StateRepository, store: Store): Promise<HrWorkspace> {
  const result = await repository.get<HrWorkspace>('oda_hr', `hr:${store.id}`);
  if (result && result.storeId !== store.id) throw new DomainError('HR_SCOPE_CORRUPT', '인사관리의 매장 범위를 확인할 수 없습니다.', 503);
  return result ?? createHrWorkspace(store.id, store.name, new Date().toISOString());
}
async function validateActorLink(repository: StateRepository, workspace: HrWorkspace, command: z.infer<typeof commandSchema>, currentActor: Actor): Promise<void> {
  if (command.type !== 'employee.create' && command.type !== 'employee.update') return;
  const input = command.type === 'employee.create' ? command.input : command.input.changes as Record<string, unknown>;
  if (typeof input.actorId !== 'string' || !input.actorId.trim()) return;
  const actor = await repository.get<Actor>('actor', input.actorId.trim());
  if (!actor?.active || !linkableRoles.includes(actor.role) || (!actor.storeIds.includes(workspace.storeId) && !(actor.id === currentActor.id && actor.role === 'hq_master'))) throw new DomainError('HR_ACTOR_SCOPE', '이 매장에 배정된 활성 인사관리 계정만 구성원에게 연결할 수 있습니다.', 422);
}
async function response(repository: StateRepository, workspace: HrWorkspace, actor: Actor, store: Store): Promise<HrResponse> {
  const ctx = context(actor, workspace); const result = projectHrWorkspace(workspace, ctx);
  result.storeAddress = store.roadAddress || store.business.address || '';
  if (ctx.manager) result.accounts = (await repository.list<Actor>('actor')).filter(row => row.active && linkableRoles.includes(row.role)
    && (row.storeIds.includes(workspace.storeId) || (row.id === actor.id && row.role === 'hq_master')))
    .map(row => ({ id: row.id, name: row.name, role: row.role }));
  return result;
}
async function validateWorkflowActors(repository: StateRepository, workspace: HrWorkspace, command: z.infer<typeof commandSchema>, currentActor: Actor): Promise<void> {
  let ids: string[] = []; let creatorId: string | undefined;
  if (command.type === 'workflow.template.save') {
    const template = command.input.id ? workspace.workflow.templates.find(row => row.id === command.input.id) : workspace.workflow.templates.at(-1);
    ids = template?.steps.flatMap(step => step.approverIds) ?? []; creatorId = template?.createdBy;
  } else if (command.type === 'workflow.submit' || command.type === 'workflow.approve' || command.type === 'workflow.reject') {
    const row = workspace.workflow.requests.find(item => item.id === command.input.id);
    creatorId = workspace.workflow.templates.find(template => template.id === row?.templateId)?.createdBy;
    ids = command.type === 'workflow.submit' ? row?.steps.flatMap(step => step.approverIds) ?? []
      : [row?.decisions.at(-1)?.approverId ?? '', currentActor.id];
  } else if (command.type === 'workflow.delegation.save') {
    ids = [String(command.input.fromActorId ?? ''), String(command.input.toActorId ?? '')];
  }
  const policy = ids.length ? await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID) : undefined;
  for (const id of new Set(ids)) {
    const actor = await repository.get<Actor>('actor', id);
    const manager = actor && ['store_owner', 'hq_master'].includes(actor.role);
    const creator = Boolean(manager && (id === creatorId || id === currentActor.id));
    const linked = workspace.employees.some(employee => employee.actorId === id && employee.status === 'active');
    const allowedScope = actor && (actor.storeIds.includes(workspace.storeId) || (actor.role === 'hq_master' && actor.storeIds.length === 0));
    const allowedPage = actor && capabilitiesForPages(actor.role, resolveVisiblePages(actor, policy)).some(value => value === 'oda.hr.read' || value === 'oda.hr.hq.read');
    if (!actor?.active || actor.role === 'auditor' || !allowedScope || !allowedPage || (!creator && !linked)) {
      throw new DomainError('HR_APPROVER_UNAVAILABLE', '결재·대결 대상의 활성 계정과 매장 배정, 재직 상태를 확인해 주세요.', 422);
    }
  }
}
/** One store aggregate keeps employee/approval/payroll invariants atomic in both repository backends. */
export function registerOdaHrRoutes(app: FastifyInstance, repository: StateRepository): void {
  const base = '/api/v2/oda/:storeId/hr';
  app.get(base, async request => {
    const { storeId } = paramsSchema.parse(request.params);
    const store = await scope(repository, request.actor, storeId);
    const workspace = await load(repository, store);
    return response(repository, workspace, request.actor, store);
  });
  app.post(`${base}/commands`, async (request, reply) => {
    const { storeId } = paramsSchema.parse(request.params);
    const store = await scope(repository, request.actor, storeId);
    if (request.actor.role === 'auditor') throw new DomainError('HR_READ_ONLY', '감사 계정은 조회만 할 수 있습니다.', 403);
    const command = commandSchema.parse(request.body);
    // Keep only a non-sensitive receipt in the retry cache. Always re-project current data below.
    await idempotentMutation(request, reply, repository, request.actor, 200, tx => tx.exclusiveTransaction(`oda:hr:${storeId}`, async scoped => {
      const workspace = await load(scoped, store);
      if (workspace.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다. 최신 인사관리를 불러온 뒤 다시 시도해 주세요.', 409);
      const ctx = context(request.actor, workspace);
      if (request.actor.role === 'store_staff' && !ctx.employeeId) throw new DomainError('HR_EMPLOYEE_LINK_REQUIRED', '관리자가 구성원 정보에 계정을 연결한 뒤 사용할 수 있습니다.', 403);
      applyHrCommand(workspace, { type: command.type, input: command.input }, ctx);
      await validateActorLink(scoped, workspace, command, request.actor);
      await validateWorkflowActors(scoped, workspace, command, request.actor);
      if (Buffer.byteLength(JSON.stringify(workspace), 'utf8') > 30 * 1024 * 1024) throw new DomainError('HR_WORKSPACE_LIMIT', '인사관리 보관 용량 한도에 도달했습니다. 관리자에게 문의해 주세요.', 422);
      await scoped.commit({ changes: [{ type: 'oda_hr', id: workspace.id, storeId, expectedVersion: command.expectedVersion === 0 ? null : command.expectedVersion, value: workspace }],
        audits: [audit(request.actor, 'oda_hr', workspace.id, `hr.${command.type}`, storeId,
          { version: command.expectedVersion }, { version: workspace.version }, { commandType: command.type })] });
      return { version: workspace.version };
    }));
    const currentStore = await scope(repository, request.actor, storeId);
    const current = await load(repository, currentStore);
    return response(repository, current, request.actor, currentStore);
  });
}
