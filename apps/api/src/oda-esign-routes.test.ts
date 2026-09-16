import { createHash, randomUUID } from 'node:crypto';
import { createDemoRepository, DEMO_IDS, type StateRepository } from '@ofd/db';
import { NATIVE_ESIGN_CONSENT_VERSION, type Actor, type NativeContract, type NativeEmployer, type UserCredential } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';
import * as nativePdf from './oda-esign-pdf.ts';

const apps: FastifyInstance[] = [];
const storeId = DEMO_IDS.storeDoksan;
const base = `/api/v2/oda/${storeId}/esign`;
const password = 'OFD-demo-2026!';
const headers = (actor = DEMO_IDS.owner) => ({ 'x-demo-actor-id': actor });
const terms = { employmentType: 'regular', payType: 'monthly', basePay: 3100000, effectiveDate: '2026-01-01', endDate: '',
  jobTitle: '매장 운영', workplace: '서울 테스트 매장', workDays: '월~금', dailyWorkHours: '월~금 각 8시간',
  workStart: '09:00', workEnd: '18:00', breakMinutes: 60, payday: '매월 25일', payCalculation: '기본급 310만원, 연장근로 별도',
  payMethod: '본인 계좌 이체', holidays: '일요일 유급 주휴일', annualLeave: '법정 기준에 따름', additionalTerms: '계약 본문 비밀 842791' };
function businessNumber(firstNine: string): string {
  const digits = [...firstNine].map(Number), weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const sum = weights.reduce((total, weight, i) => total + weight * digits[i]!, 0) + Math.floor(digits[8]! * 5 / 10);
  return firstNine + ((10 - sum % 10) % 10);
}
async function post(app: FastifyInstance, path: string, payload: Record<string, unknown>, actor = DEMO_IDS.owner, key = randomUUID()) {
  return app.inject({ method: 'POST', url: `${base}${path}`, headers: { ...headers(actor), 'idempotency-key': key }, payload });
}
async function setup() {
  const repository = createDemoRepository();
  const app = await buildApp({ repository, env: { APP_MODE: 'test', PROVIDER_MODE: 'mock', LOG_LEVEL: 'silent' }, logger: false });
  apps.push(app);
  const created = await app.inject({ method: 'POST', url: `/api/v2/oda/${storeId}/hr/commands`, headers: { ...headers(), 'idempotency-key': randomUUID() },
    payload: { expectedVersion: 0, type: 'employee.create', input: { employeeNumber: 'ESIGN-01', name: '계약 직원', hireDate: '2026-01-01', basePay: 3000000, actorId: DEMO_IDS.staff } } });
  expect(created.statusCode, created.body).toBe(200);
  const employerResponse = await post(app, '/employers', { expectedVersion: 0, legalName: '계약 사업자', businessNumber: businessNumber('123456789'), representativeName: '대표자',
    address: '서울시 테스트 주소', signerActorId: DEMO_IDS.owner });
  expect(employerResponse.statusCode, employerResponse.body).toBe(200);
  const employer = employerResponse.json().employer as NativeEmployer;
  const response = await post(app, '/contracts', { expectedVersion: 0, employerId: employer.id, employeeId: created.json().workspace.employees[0].id,
    employeeActorId: DEMO_IDS.master, employeeName: '위조된 이름', title: '근로계약서', templateKey: 'monthly-v1', terms });
  expect(response.statusCode, response.body).toBe(200);
  return { app, repository, employer, contract: response.json().contract as NativeContract };
}
async function requestContract(app: FastifyInstance, contract: NativeContract) {
  const response = await post(app, `/contracts/${contract.id}/request`, { expectedVersion: contract.version, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  expect(response.statusCode, response.body).toBe(200); return response.json().contract as NativeContract;
}
function signature(contract: NativeContract, role: 'employee' | 'employer') {
  return { expectedVersion: contract.version, role, typedName: role === 'employer' ? contract.employer.signerName : contract.employeeName,
    documentHash: contract.documentHash, consent: true, consentVersion: NATIVE_ESIGN_CONSENT_VERSION,
    password, strokes: [[{ x: .1, y: .5 }, { x: .4, y: .1 }, { x: .6, y: .8 }, { x: .9, y: .2 }]] };
}
async function complete(app: FastifyInstance, contract: NativeContract) {
  let current = await requestContract(app, contract);
  const first = await post(app, `/contracts/${current.id}/sign`, signature(current, 'employer'));
  expect(first.statusCode, first.body).toBe(200); current = first.json().contract;
  const second = await post(app, `/contracts/${current.id}/sign`, signature(current, 'employee'), DEMO_IDS.staff);
  expect(second.statusCode, second.body).toBe(200); return second.json().contract as NativeContract;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });

describe('native electronic contracts', () => {
  it('stores employer-specific conditions without employee dates or signatures and guards template reuse', async () => {
    const { app, repository, contract, employer } = await setup();
    const payload = { expectedVersion: 0, sourceContractId: contract.id, sourceContractVersion: contract.version, name: '평일 월급 양식' };
    expect((await post(app, '/templates', payload, DEMO_IDS.staff)).statusCode).toBe(403);
    const key = randomUUID();
    const saved = await post(app, '/templates', payload, DEMO_IDS.owner, key);
    expect(saved.statusCode, saved.body).toBe(200);
    const template = saved.json().template;
    expect(template.employerId).toBe(employer.id); expect(template.terms.basePay).toBe(terms.basePay);
    for (const field of ['employeeId', 'employeeActorId', 'employeeName', 'signatures', 'documentText', 'documentHash', 'artifacts']) expect(template).not.toHaveProperty(field);
    expect(template.terms).not.toHaveProperty('effectiveDate'); expect(template.terms).not.toHaveProperty('endDate');
    const replay = await post(app, '/templates', payload, DEMO_IDS.owner, key);
    expect(replay.json().template.id).toBe(template.id);
    expect(await repository.list('oda_contract_template', [storeId])).toHaveLength(1);
    expect((await post(app, '/templates', payload)).statusCode).toBe(409);
    expect((await post(app, '/templates', { ...payload, name: '다른 이름', sourceContractVersion: 999 })).statusCode).toBe(409);
    const staffList = await app.inject({ method: 'GET', url: base, headers: headers(DEMO_IDS.staff) });
    expect(staffList.json().templates).toBeUndefined();
    const create = { expectedVersion: 0, employerId: employer.id, employeeId: contract.employeeId, title: '양식으로 작성', templateKey: 'spoofed', terms, savedTemplateId: template.id, savedTemplateVersion: template.version };
    const created = await post(app, '/contracts', create);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().contract.templateKey).toBe(`saved:${template.id}:v1`);
    expect(created.json().contract.signatures).toEqual([]);
    const other = await post(app, '/employers', { ...employer, id: undefined, expectedVersion: 0, businessNumber: businessNumber('987654321'), legalName: '다른 법인' });
    expect((await post(app, '/contracts', { ...create, employerId: other.json().employer.id })).statusCode).toBe(422);
    const cross = await app.inject({ method: 'POST', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/esign/templates/${template.id}`, headers: { ...headers(DEMO_IDS.master), 'idempotency-key': randomUUID() }, payload: { expectedVersion: 1, active: false } });
    expect(cross.statusCode, cross.body).toBe(404);
    const archived = await post(app, `/templates/${template.id}`, { expectedVersion: 1, active: false, terms: { basePay: 1 } });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().template.terms).toEqual(template.terms);
    expect((await post(app, '/contracts', create)).statusCode).toBe(409);
    expect((await post(app, `/templates/${template.id}`, { expectedVersion: 1, active: true })).statusCode).toBe(409);
    const restored = await post(app, `/templates/${template.id}`, { expectedVersion: 2, active: true });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await post(app, '/contracts', { ...create, savedTemplateVersion: 3 })).statusCode).toBe(200);
    expect(await repository.get('oda_contract', contract.id)).toEqual(contract);
  });
  it('scopes multiple legal employers and binds employee identity to server HR data', async () => {
    const { app, contract, employer } = await setup();
    expect(contract.employeeActorId).toBe(DEMO_IDS.staff); expect(contract.employeeName).toBe('계약 직원');
    const duplicate = await post(app, '/employers', { ...employer, id: undefined, expectedVersion: 0 });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const other = await post(app, '/employers', { ...employer, id: undefined, expectedVersion: 0, businessNumber: businessNumber('987654321'), legalName: '두 번째 법인' });
    expect(other.statusCode, other.body).toBe(200); expect(other.json().employers).toHaveLength(2);
    const managerList = await app.inject({ method: 'GET', url: base, headers: headers() });
    expect(managerList.json().contracts[0].documentText).toBeUndefined();
    const draft = await app.inject({ method: 'GET', url: `${base}/contracts/${contract.id}`, headers: headers(DEMO_IDS.staff) });
    expect(draft.statusCode).toBe(404);
    for (const actor of [DEMO_IDS.finance, DEMO_IDS.auditor]) {
      const list = await app.inject({ method: 'GET', url: base, headers: headers(actor) });
      expect(list.json().contracts).toEqual([]); expect(list.json().employers).toEqual([]);
      expect((await app.inject({ method: 'GET', url: `${base}/contracts/${contract.id}`, headers: headers(actor) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: `/api/v2/oda/${DEMO_IDS.storeHapjeong}/esign/contracts/${contract.id}`, headers: headers(DEMO_IDS.master) })).statusCode).toBe(404);
  });

  it('requires exact assigned signers, current hash, explicit consent and durable password checks', async () => {
    const { app, repository, contract } = await setup(); const pending = await requestContract(app, contract);
    expect((await post(app, `/contracts/${contract.id}/sign`, signature(pending, 'employer'), DEMO_IDS.master)).statusCode).toBe(403);
    const mismatch = await post(app, `/contracts/${contract.id}/sign`, { ...signature(pending, 'employee'), documentHash: '0'.repeat(64) }, DEMO_IDS.staff);
    expect(mismatch.statusCode).toBe(409);
    const noConsent = await post(app, `/contracts/${contract.id}/sign`, { ...signature(pending, 'employee'), consent: false }, DEMO_IDS.staff);
    expect(noConsent.statusCode).toBe(422);
    for (let index = 0; index < 5; index++) {
      const denied = await post(app, `/contracts/${contract.id}/sign`, { ...signature(pending, 'employee'), password: 'incorrect-password' }, DEMO_IDS.staff);
      expect(denied.statusCode, denied.body).toBe(401);
    }
    const credential = (await repository.list<UserCredential>('credential')).find(row => row.actorId === DEMO_IDS.staff)!;
    expect(credential.failedAttempts).toBe(5); expect(credential.lockedUntil).toBeTruthy();
    const locked = await post(app, `/contracts/${contract.id}/sign`, signature(pending, 'employee'), DEMO_IDS.staff);
    expect(locked.statusCode).toBe(423);
    expect((await repository.get<NativeContract>('oda_contract', contract.id))!.signatures).toEqual([]);
  });

  it('stores the exact completed PDFs once and keeps delivery separate from downloads', async () => {
    const { app, repository, contract } = await setup(); const completed = await complete(app, contract);
    expect(completed.status).toBe('completed'); expect(completed.signatures).toHaveLength(2); expect(completed.deliveries).toEqual([]);
    const original = await app.inject({ method: 'GET', url: `${base}/contracts/${contract.id}/pdf`, headers: headers(DEMO_IDS.staff) });
    expect(original.statusCode, original.body.slice(0, 200)).toBe(200); expect(original.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const artifacts = await repository.list<{ sha256: string; base64: string }>('oda_contract_artifact', [storeId]); expect(artifacts).toHaveLength(2);
    expect(original.headers['x-content-sha256']).toBe(createHash('sha256').update(original.rawPayload).digest('hex'));
    expect((await repository.get<NativeContract>('oda_contract', contract.id))!.deliveries).toEqual([]);
    const delivered = await post(app, `/contracts/${contract.id}/delivery`, { expectedVersion: completed.version, method: 'manual_handover', evidenceNote: '직원에게 완료본 출력 1부 전달, 수령 확인' });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const after = await app.inject({ method: 'GET', url: `${base}/contracts/${contract.id}/pdf`, headers: headers(DEMO_IDS.staff) });
    expect(after.rawPayload.equals(original.rawPayload)).toBe(true);
    const applied = await post(app, `/contracts/${contract.id}/apply`, { expectedVersion: delivered.json().contract.version });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await repository.get<any>('oda_hr', `hr:${storeId}`)).employees[0].basePay).toBe(terms.basePay);
    expect((await post(app, `/contracts/${contract.id}/apply`, { expectedVersion: applied.json().contract.version })).statusCode).toBe(409);
  });

  it('replays only a receipt, excludes passwords from retry hashes and never duplicates signature evidence', async () => {
    const { app, repository, contract } = await setup(); const pending = await requestContract(app, contract); const key = randomUUID();
    const payload = signature(pending, 'employer');
    const first = await post(app, `/contracts/${contract.id}/sign`, payload, DEMO_IDS.owner, key);
    expect(first.statusCode, first.body).toBe(200);
    const repeated = await post(app, `/contracts/${contract.id}/sign`, payload, DEMO_IDS.owner, key);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.headers['idempotency-replayed']).toBe('true');
    expect(repeated.json().contract.signatures).toHaveLength(1);
    const receipt = await repository.getIdempotency(DEMO_IDS.owner, key);
    expect(receipt?.response).toEqual({ id: contract.id, version: first.json().contract.version });
    const { password: _password, ...safeBody } = payload;
    expect(receipt?.requestHash).toBe(createHash('sha256').update(JSON.stringify({ method: 'POST', url: `${base}/contracts/${contract.id}/sign`, body: safeBody })).digest('hex'));
    const actor = (await repository.get<Actor>('actor', DEMO_IDS.owner))!;
    await repository.commit({ changes: [{ type: 'actor', id: actor.id, expectedVersion: actor.authVersion, value: { ...actor, active: false, authVersion: actor.authVersion + 1 } }] });
    expect((await post(app, `/contracts/${contract.id}/sign`, payload, DEMO_IDS.owner, key)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses stale personnel application even if an intervening edit preserves the same salary', async () => {
    const { app, repository, contract } = await setup(); const completed = await complete(app, contract);
    const hr = (await repository.get<any>('oda_hr', `hr:${storeId}`))!;
    const changed = await app.inject({ method: 'POST', url: `/api/v2/oda/${storeId}/hr/commands`, headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: { expectedVersion: hr.version, type: 'employee.update', input: { id: contract.employeeId, effectiveDate: '2026-01-01', reason: '다른 인사 변경 확인', changes: { basePay: 3000000 } } } });
    expect(changed.statusCode, changed.body).toBe(200);
    const denied = await post(app, `/contracts/${contract.id}/apply`, { expectedVersion: completed.version });
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('ESIGN_PERSONNEL_CHANGED');
    expect((await repository.get<NativeContract>('oda_contract', contract.id))!.appliedAt).toBeUndefined();
  });

  it('rolls back the second signature if completed document generation fails, then safely retries', async () => {
    const { app, repository, contract } = await setup(); const pending = await requestContract(app, contract);
    const first = await post(app, `/contracts/${contract.id}/sign`, signature(pending, 'employer'));
    expect(first.statusCode, first.body).toBe(200); const oneSigned = first.json().contract as NativeContract;
    const render = vi.spyOn(nativePdf, 'createNativeContractPdf').mockRejectedValueOnce(new Error('simulated storage preparation failure'));
    const key = randomUUID(), payload = signature(oneSigned, 'employee');
    const failed = await post(app, `/contracts/${contract.id}/sign`, payload, DEMO_IDS.staff, key);
    expect(failed.statusCode).toBe(500); expect(render).toHaveBeenCalledOnce();
    const stored = (await repository.get<NativeContract>('oda_contract', contract.id))!;
    expect(stored.status).toBe('pending'); expect(stored.signatures).toHaveLength(1); expect(stored.version).toBe(oneSigned.version);
    expect(await repository.list('oda_contract_artifact', [storeId])).toEqual([]);
    expect(await repository.getIdempotency(DEMO_IDS.staff, key)).toBeUndefined();
    const retried = await post(app, `/contracts/${contract.id}/sign`, payload, DEMO_IDS.staff, key);
    expect(retried.statusCode, retried.body).toBe(200); expect(retried.json().contract.status).toBe('completed');
    expect(await repository.list('oda_contract_artifact', [storeId])).toHaveLength(2);
  });
});
