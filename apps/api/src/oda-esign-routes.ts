import { createHash, randomUUID } from 'node:crypto';
import type { AggregateChange, StateRepository } from '@ofd/db';
import {
  applyHrCommand, capabilitiesForPages, DomainError,
  createNativeEmployer, updateNativeEmployer, createNativeContract, updateNativeContract,
  requestNativeContract, signNativeContract, declineNativeContract, cancelNativeContract,
  recordNativeContractDelivery, applyNativeContract,
  verifyNativeContractIntegrity, nativeEsignCanonicalJson,
  type Actor, type Store, type HrWorkspace, type HrEmployee, type HrContext,
  type NativeEmployer, type NativeContract, type NativeEsignContext,
} from '@ofd/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from './auth-service.ts';
import { audit } from './events.ts';
import { idempotentMutation } from './idempotency.ts';
import { createNativeContractPdf } from './oda-esign-pdf.ts';
import { ACCESS_POLICY_ID, resolveVisiblePages, type AccessPolicyDocument } from './service.ts';

const paramsSchema = z.object({ storeId: z.string().min(1).max(120), id: z.string().min(1).max(120).optional() });
const bodySchema = z.object({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), id: z.string().min(1).max(120).optional() }).passthrough();
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type PersonnelBaseline = Pick<HrEmployee, 'employmentType' | 'jobTitle' | 'payType' | 'basePay' | 'hireDate'> & { endDate: string };
type StoredContract = NativeContract & { personnelBaseline?: PersonnelBaseline; personnelHistoryLength?: number };
interface ContractArtifact {
  id: string; contractId: string; storeId: string; kind: 'contract' | 'evidence'; version: 1;
  documentHash: string; sha256: string; byteLength: number; base64: string; createdAt: string;
}

function manager(actor: Actor): boolean { return actor.role === 'store_owner' || actor.role === 'hq_master'; }
function requireManager(actor: Actor): void {
  if (!manager(actor)) throw new DomainError('ESIGN_FORBIDDEN', '계약 관리 권한이 없습니다.', 403);
}
function privateResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache');
}
function hasHrPage(actor: Actor, policy: AccessPolicyDocument | undefined): boolean {
  return capabilitiesForPages(actor.role, resolveVisiblePages(actor, policy)).some(value => value === 'oda.hr.read' || value === 'oda.hr.hq.read');
}
function hasStore(actor: Actor, storeId: string): boolean {
  return actor.storeIds.includes(storeId) || (actor.role === 'hq_master' && actor.storeIds.length === 0);
}
async function scope(repository: StateRepository, suppliedActor: Actor, storeId: string): Promise<{ store: Store; actor: Actor }> {
  const actor = await repository.get<Actor>('actor', suppliedActor.id);
  const allowedRole = actor && ['store_owner', 'store_staff', 'hq_master', 'hq_finance', 'auditor'].includes(actor.role);
  const allowedStore = actor && (hasStore(actor, storeId) || (['hq_finance', 'auditor'].includes(actor.role) && actor.storeIds.length === 0));
  const policy = await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID);
  if (!actor?.active || !allowedRole || !allowedStore || !hasHrPage(actor, policy)) {
    throw new DomainError('ESIGN_FORBIDDEN', '이 매장의 전자계약에 접근할 권한이 없습니다.', 403);
  }
  const store = await repository.get<Store>('store', storeId);
  if (!store?.active) throw new DomainError('ESIGN_STORE_NOT_FOUND', '운영 중인 매장을 찾을 수 없습니다.', 404);
  return { store, actor };
}
async function signerAccount(repository: StateRepository, storeId: string, actorId: unknown): Promise<Actor> {
  if (typeof actorId !== 'string') throw new DomainError('ESIGN_SIGNER_REQUIRED', '서명할 계정을 선택해 주세요.', 422);
  const actor = await repository.get<Actor>('actor', actorId);
  const policy = await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID);
  if (!actor?.active || !['store_owner', 'hq_master', 'store_staff'].includes(actor.role) || !hasStore(actor, storeId) || !hasHrPage(actor, policy)) {
    throw new DomainError('ESIGN_SIGNER_UNAVAILABLE', '서명자는 이 매장의 인사관리에 접근 가능한 활성 계정이어야 합니다.', 422);
  }
  return actor;
}
async function workspace(repository: StateRepository, storeId: string): Promise<HrWorkspace> {
  const row = await repository.get<HrWorkspace>('oda_hr', `hr:${storeId}`);
  if (!row || row.storeId !== storeId) throw new DomainError('ESIGN_EMPLOYEE_REQUIRED', '인사관리에서 구성원을 먼저 등록해 주세요.', 422);
  return row;
}
async function employeeFor(repository: StateRepository, storeId: string, employeeId: unknown): Promise<HrEmployee> {
  const hr = await workspace(repository, storeId);
  const employee = hr.employees.find(value => value.id === employeeId && value.status !== 'retired');
  if (!employee?.actorId) throw new DomainError('ESIGN_EMPLOYEE_ACCOUNT_REQUIRED', '계약할 구성원에게 활성 로그인 계정을 연결해 주세요.', 422);
  await signerAccount(repository, storeId, employee.actorId);
  return employee;
}
function baseline(employee: HrEmployee): PersonnelBaseline {
  return { employmentType: employee.employmentType, jobTitle: employee.jobTitle, payType: employee.payType,
    basePay: employee.basePay, hireDate: employee.hireDate, endDate: employee.endDate ?? '' };
}
function context(actor: Actor, request: FastifyRequest, reauthenticatedAt?: string): NativeEsignContext {
  return { actorId: actor.id, manager: manager(actor), now: new Date().toISOString(), id: randomUUID, hash: sha256,
    ip: request.ip, userAgent: String(request.headers['user-agent'] ?? '').slice(0, 500),
    ...(reauthenticatedAt ? { reauthenticatedAt, authMethod: 'password_reauthentication' as const } : {}) };
}
function visible(contract: NativeContract, actor: Actor): boolean {
  if (manager(actor)) return true;
  if (actor.role !== 'store_staff') return false;
  return contract.status !== 'draft' && (contract.employeeActorId === actor.id || contract.employer.signerActorId === actor.id);
}
async function contractFor(repository: StateRepository, storeId: string, id: string, actor: Actor): Promise<StoredContract> {
  const contract = await repository.get<StoredContract>('oda_contract', id);
  if (!contract || contract.storeId !== storeId || !visible(contract, actor)) throw new DomainError('ESIGN_CONTRACT_NOT_FOUND', '접근 가능한 계약을 찾을 수 없습니다.', 404);
  if (!verifyNativeContractIntegrity(contract, sha256)) throw new DomainError('ESIGN_INTEGRITY', '계약 원문 또는 증빙의 무결성을 확인할 수 없습니다.', 503);
  return contract;
}
async function employerFor(repository: StateRepository, storeId: string, id: unknown): Promise<NativeEmployer> {
  if (typeof id !== 'string') throw new DomainError('ESIGN_EMPLOYER_REQUIRED', '계약 사업자를 선택해 주세요.', 422);
  const employer = await repository.get<NativeEmployer>('oda_employer', id);
  if (!employer || employer.storeId !== storeId) throw new DomainError('ESIGN_EMPLOYER_NOT_FOUND', '이 매장에 등록된 계약 사업자를 선택해 주세요.', 404);
  return employer;
}
function summary(contract: StoredContract) {
  const { documentText: _text, personnelBaseline: _baseline, personnelHistoryLength: _history, ...rest } = contract;
  // Stroke vectors and request metadata belong in the authorized detail view only.
  return { ...rest, signatures: rest.signatures.map(({ role, actorId, name, at }) => ({ role, actorId, name, at })), audit: [] };
}
function detail(contract: StoredContract): NativeContract {
  const { personnelBaseline: _baseline, personnelHistoryLength: _history, ...result } = contract;
  return result;
}
async function overview(repository: StateRepository, actor: Actor, storeId: string) {
  const contracts = await repository.list<StoredContract>('oda_contract', [storeId]);
  const employers = manager(actor) ? await repository.list<NativeEmployer>('oda_employer', [storeId]) : [];
  const result = { storeId, employers, contracts: contracts.filter(row => row.storeId === storeId && visible(row, actor)).map(summary),
    permissions: { manage: manager(actor), sign: ['store_owner', 'store_staff', 'hq_master'].includes(actor.role) }, currentActorId: actor.id };
  if (!manager(actor)) return result;
  const policy = await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID);
  const accounts = (await repository.list<Actor>('actor')).filter(row => row.active && ['store_owner', 'hq_master', 'store_staff'].includes(row.role)
    && hasStore(row, storeId) && hasHrPage(row, policy)).map(({ id, name, role }) => ({ id, name, role }));
  return { ...result, accounts };
}
async function persistContract(repository: StateRepository, actor: Actor, contract: StoredContract, previousVersion: number,
  action: string, changes: AggregateChange[] = []): Promise<void> {
  await repository.commit({ changes: [{ type: 'oda_contract', id: contract.id, storeId: contract.storeId,
    expectedVersion: previousVersion === 0 ? null : previousVersion, value: contract }, ...changes],
  audits: [audit(actor, 'oda_contract', contract.id, `esign.${action}`, contract.storeId,
    { version: previousVersion }, { version: contract.version, status: contract.status },
    { documentHash: contract.documentHash ?? null })] });
}

/** Native contracts own their immutable evidence; no third-party signing or delivery is implied. */
export function registerOdaEsignRoutes(app: FastifyInstance, repository: StateRepository, authService: Pick<AuthService, 'stepUp'>): void {
  const base = '/api/v2/oda/:storeId/esign';
  app.get(base, async (request, reply) => {
    privateResponse(reply);
    const { storeId } = paramsSchema.parse(request.params);
    const { actor } = await scope(repository, request.actor, storeId);
    return overview(repository, actor, storeId);
  });
  app.get(`${base}/contracts/:id`, async (request, reply) => {
    privateResponse(reply);
    const { storeId, id } = paramsSchema.parse(request.params);
    const { actor } = await scope(repository, request.actor, storeId);
    return { contract: detail(await contractFor(repository, storeId, id!, actor)) };
  });
  app.post(`${base}/employers`, async (request, reply) => {
    privateResponse(reply);
    const { storeId } = paramsSchema.parse(request.params);
    const { actor } = await scope(repository, request.actor, storeId); requireManager(actor);
    const body = bodySchema.parse(request.body);
    const receipt = await idempotentMutation(request, reply, repository, actor, 200,
      tx => tx.exclusiveTransaction(`oda:hr:${storeId}`, async scoped => {
        const { actor: current } = await scope(scoped, actor, storeId); requireManager(current);
        const signer = await signerAccount(scoped, storeId, body.signerActorId);
        const input = { ...body, storeId, signerName: signer.name };
        const existing = body.id ? await employerFor(scoped, storeId, body.id) : undefined;
        if (!existing && body.expectedVersion !== 0) throw new DomainError('ESIGN_VERSION_CONFLICT', '새 사업자는 버전 0으로 등록해 주세요.', 409);
        const employer = existing ? updateNativeEmployer(existing, input, context(current, request)) : createNativeEmployer(input, context(current, request));
        const duplicate = (await scoped.list<NativeEmployer>('oda_employer', [storeId]))
          .some(row => row.id !== employer.id && row.businessNumber === employer.businessNumber);
        if (duplicate) throw new DomainError('ESIGN_EMPLOYER_DUPLICATE', '이미 등록된 사업자등록번호입니다. 기존 사업자를 선택해 주세요.', 409);
        await scoped.commit({ changes: [{ type: 'oda_employer', id: employer.id, storeId,
          expectedVersion: existing?.version ?? null, value: employer }],
        audits: [audit(current, 'oda_employer', employer.id, 'esign.employer.save', storeId,
          { version: existing?.version ?? 0 }, { version: employer.version })] });
        return { id: employer.id, version: employer.version };
      }));
    const { actor: current } = await scope(repository, actor, storeId); requireManager(current);
    return { ...await overview(repository, current, storeId), employer: await employerFor(repository, storeId, receipt!.id) };
  });
  app.post(`${base}/contracts`, async (request, reply) => {
    privateResponse(reply);
    const { storeId } = paramsSchema.parse(request.params);
    const { actor } = await scope(repository, request.actor, storeId); requireManager(actor);
    const body = bodySchema.parse(request.body);
    const receipt = await idempotentMutation(request, reply, repository, actor, 200,
      tx => tx.exclusiveTransaction(`oda:hr:${storeId}`, async scoped => {
        const { actor: current } = await scope(scoped, actor, storeId); requireManager(current);
        const employer = await employerFor(scoped, storeId, body.employerId);
        const employee = await employeeFor(scoped, storeId, body.employeeId);
        const input = { ...body, storeId, employeeName: employee.name, employeeActorId: employee.actorId };
        const existing = typeof body.id === 'string' ? await contractFor(scoped, storeId, body.id, current) : undefined;
        if (!existing && body.expectedVersion !== 0) throw new DomainError('ESIGN_VERSION_CONFLICT', '새 계약은 버전 0으로 등록해 주세요.', 409);
        if (!existing && (await scoped.list('oda_contract', [storeId])).length >= 5000) throw new DomainError('ESIGN_CONTRACT_LIMIT', '매장별 계약 보관 한도에 도달했습니다.', 422);
        const contract = existing ? updateNativeContract(existing, input, employer, context(current, request)) : createNativeContract(input, employer, context(current, request));
        await persistContract(scoped, current, contract, existing?.version ?? 0, existing ? 'draft.update' : 'draft.create');
        return { id: contract.id, version: contract.version };
      }));
    const { actor: current } = await scope(repository, actor, storeId);
    return { ...await overview(repository, current, storeId), contract: detail(await contractFor(repository, storeId, receipt!.id, current)) };
  });
  for (const action of ['request', 'sign', 'decline', 'cancel', 'delivery', 'apply'] as const) {
    app.post(`${base}/contracts/:id/${action}`, async (request, reply) => {
      privateResponse(reply);
      const { storeId, id } = paramsSchema.parse(request.params);
      const { actor } = await scope(repository, request.actor, storeId);
      if (['request', 'cancel', 'apply'].includes(action)) requireManager(actor);
      const body = bodySchema.parse(request.body);
      let reauthenticatedAt: string | undefined;
      if (action === 'sign') {
        const before = await contractFor(repository, storeId, id!, actor);
        if (before.employeeActorId !== actor.id && before.employer.signerActorId !== actor.id) throw new DomainError('ESIGN_SIGNER_FORBIDDEN', '지정된 당사자만 서명할 수 있습니다.', 403);
        const password = z.string().min(1).max(200).parse(body.password);
        // Outside contract/idempotency transactions: failed-password counters must remain durable on rejection.
        await authService.stepUp(actor, password, request.ip);
        reauthenticatedAt = new Date().toISOString();
      }
      // Never retain a deterministic hash of a password inside the idempotency receipt.
      const { password: _discardPassword, ...safeBody } = body;
      request.body = safeBody;
      delete (request as FastifyRequest & { rawBody?: string }).rawBody;
      await idempotentMutation(request, reply, repository, actor, 200,
        tx => tx.exclusiveTransaction(`oda:hr:${storeId}`, async scoped => {
          const { actor: current } = await scope(scoped, actor, storeId);
          if (action === 'sign' && current.authVersion !== actor.authVersion) throw new DomainError('ESIGN_REAUTH_REQUIRED', '계정 정보가 변경되었습니다. 다시 로그인하고 서명해 주세요.', 401);
          const existing = await contractFor(scoped, storeId, id!, current);
          const ctx = context(current, request, reauthenticatedAt);
          const { password: _password, ...input } = body;
          let contract: StoredContract;
          const additional: AggregateChange[] = [];
          if (action === 'request') {
            requireManager(current);
            const employee = await employeeFor(scoped, storeId, existing.employeeId);
            if (employee.actorId !== existing.employeeActorId || employee.name !== existing.employeeName) throw new DomainError('ESIGN_EMPLOYEE_CHANGED', '구성원 정보가 변경되었습니다. 초안을 다시 저장해 주세요.', 409);
            const employer = await employerFor(scoped, storeId, existing.employer.id);
            if (!employer.active || employer.version !== existing.employer.version) throw new DomainError('ESIGN_EMPLOYER_CHANGED', '사업자 정보가 변경되었습니다. 초안을 다시 저장해 주세요.', 409);
            await signerAccount(scoped, storeId, existing.employer.signerActorId);
            contract = { ...requestNativeContract(existing, input, ctx), personnelBaseline: baseline(employee), personnelHistoryLength: employee.history.length };
          } else if (action === 'sign') {
            await signerAccount(scoped, storeId, current.id);
            if (input.role === 'employee') {
              const employee = await employeeFor(scoped, storeId, existing.employeeId);
              if (employee.actorId !== current.id || existing.employeeActorId !== current.id) throw new DomainError('ESIGN_SIGNER_FORBIDDEN', '계약과 구성원에 연결된 본인 계정으로 서명해 주세요.', 403);
            }
            contract = signNativeContract(existing, input, ctx);
            if (contract.status === 'completed' && existing.status !== 'completed') {
              for (const kind of ['contract', 'evidence'] as const) {
                const bytes = await createNativeContractPdf(contract, kind);
                if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new DomainError('ESIGN_ARTIFACT_FAILED', '완료 문서 보관에 실패했습니다. 다시 시도해 주세요.', 503);
                const artifact: ContractArtifact = { id: `${contract.id}:${kind}`, contractId: contract.id, storeId, kind, version: 1,
                  documentHash: contract.documentHash!, sha256: sha256(bytes), byteLength: bytes.length,
                  base64: bytes.toString('base64'), createdAt: ctx.now };
                additional.push({ type: 'oda_contract_artifact', id: artifact.id, storeId, expectedVersion: null, value: artifact });
              }
              const contractArtifact = additional[0]!.value as ContractArtifact;
              const evidenceArtifact = additional[1]!.value as ContractArtifact;
              contract.artifacts = { contract: { id: contractArtifact.id, sha256: contractArtifact.sha256 },
                evidence: { id: evidenceArtifact.id, sha256: evidenceArtifact.sha256 } };
            }
          } else if (action === 'decline') contract = declineNativeContract(existing, input, ctx);
          else if (action === 'cancel') contract = cancelNativeContract(existing, input, ctx);
          else if (action === 'delivery') {
            // A clicked link or server GET is not evidence that the employee received a durable copy.
            requireManager(current);
            if (input.method !== 'manual_handover') throw new DomainError('ESIGN_DELIVERY_PROOF_REQUIRED', '직원 사본 교부 후 수동 교부 증빙을 기록해 주세요.', 422);
            if (!await scoped.get('oda_contract_artifact', `${existing.id}:contract`)) throw new DomainError('ESIGN_ARTIFACT_MISSING', '보관된 완료 계약서를 먼저 확인해 주세요.', 409);
            contract = recordNativeContractDelivery(existing, input, ctx);
          } else {
            requireManager(current);
            contract = applyNativeContract(existing, input, ctx);
            const hr = await workspace(scoped, storeId);
            const employee = hr.employees.find(row => row.id === existing.employeeId && row.status !== 'retired');
            if (!employee || employee.actorId !== existing.employeeActorId) throw new DomainError('ESIGN_EMPLOYEE_CHANGED', '계약 당사자와 현재 구성원 정보가 일치하지 않습니다.', 409);
            if (!existing.personnelBaseline || nativeEsignCanonicalJson(baseline(employee)) !== nativeEsignCanonicalJson(existing.personnelBaseline)) throw new DomainError('ESIGN_PERSONNEL_CHANGED', '계약 요청 이후 인사조건이 변경되었습니다. 최신 조건을 확인하고 변경계약을 작성해 주세요.', 409);
            const personnelKeys = ['employmentType', 'jobTitle', 'payType', 'basePay', 'hireDate', 'endDate', 'status', 'actorId'];
            if (existing.personnelHistoryLength === undefined || employee.history.slice(existing.personnelHistoryLength)
              .some(row => Object.keys(row.changes).some(key => personnelKeys.includes(key)))) throw new DomainError('ESIGN_PERSONNEL_CHANGED', '계약 요청 이후 다른 인사 변경이 반영되었습니다. 최신 조건으로 변경계약을 작성해 주세요.', 409);
            const effectiveDate = existing.terms.effectiveDate;
            if (effectiveDate < employee.hireDate || employee.history.some(row => row.effectiveDate > effectiveDate)) throw new DomainError('ESIGN_PERSONNEL_ORDER', '현재 인사정보보다 이전 적용일의 계약은 반영할 수 없습니다.', 409);
            if (hr.payroll.runs.some(run => ['locked', 'published'].includes(run.status) && run.month >= effectiveDate.slice(0, 7)
              && run.rows.some(row => row.employeeId === employee.id))) throw new DomainError('ESIGN_PAYROLL_LOCKED', '적용일 이후 확정된 급여가 있습니다. 급여 담당자가 정정 범위를 먼저 검토해 주세요.', 409);
            const beforeVersion = hr.version;
            const hrCtx: HrContext = { actorId: current.id, manager: true, payroll: true, now: ctx.now,
              today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ctx.now)), id: randomUUID };
            applyHrCommand(hr, { type: 'employee.update', input: { id: employee.id, effectiveDate,
              reason: `전자계약 인사정보 반영: ${contract.id}`, changes: { employmentType: existing.terms.employmentType,
                jobTitle: existing.terms.jobTitle, payType: existing.terms.payType, basePay: existing.terms.basePay, endDate: existing.terms.endDate ?? '' } } }, hrCtx);
            additional.push({ type: 'oda_hr', id: hr.id, storeId, expectedVersion: beforeVersion, value: hr });
          }
          await persistContract(scoped, current, contract, body.expectedVersion, action, additional);
          return { id: contract.id, version: contract.version };
        }));
      const { actor: current } = await scope(repository, actor, storeId);
      return { ...await overview(repository, current, storeId), contract: detail(await contractFor(repository, storeId, id!, current)) };
    });
  }
  for (const kind of ['contract', 'evidence'] as const) {
    app.get(`${base}/contracts/:id/${kind === 'contract' ? 'pdf' : 'evidence'}`, async (request, reply) => {
      privateResponse(reply);
      const { storeId, id } = paramsSchema.parse(request.params);
      const { actor } = await scope(repository, request.actor, storeId);
      const contract = await contractFor(repository, storeId, id!, actor);
      let bytes: Buffer;
      if (contract.status === 'completed') {
        const artifact = await repository.get<ContractArtifact>('oda_contract_artifact', `${contract.id}:${kind}`);
        if (!artifact || artifact.storeId !== storeId || artifact.contractId !== contract.id || artifact.documentHash !== contract.documentHash
          || contract.artifacts?.[kind].id !== artifact.id || contract.artifacts[kind].sha256 !== artifact.sha256) throw new DomainError('ESIGN_ARTIFACT_MISSING', '완료 문서가 보관되지 않았습니다. 관리자에게 문의해 주세요.', 503);
        bytes = Buffer.from(artifact.base64, 'base64');
        if (bytes.length !== artifact.byteLength || sha256(bytes) !== artifact.sha256) throw new DomainError('ESIGN_ARTIFACT_INTEGRITY', '보관된 파일의 무결성을 확인할 수 없습니다.', 503);
        reply.header('X-Content-SHA256', artifact.sha256);
      } else {
        bytes = await createNativeContractPdf(contract, kind);
      }
      reply.header('Content-Disposition', `attachment; filename="oda-contract-${contract.id.replace(/[^a-zA-Z0-9_-]/g, '')}-${kind}.pdf"`);
      return reply.type('application/pdf').send(bytes);
    });
  }
}
