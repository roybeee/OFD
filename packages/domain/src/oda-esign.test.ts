import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DomainError } from './errors.ts';
import {
  NATIVE_ESIGN_CONSENT_VERSION, applyNativeContract, cancelNativeContract, createNativeContract,
  createNativeEmployer, declineNativeContract, isValidKoreanBusinessNumber, recordNativeContractDelivery,
  renderNativeContractDocument, requestNativeContract, signNativeContract, updateNativeContract,
  updateNativeEmployer, validateNativeContractTerms, validateNativeSignatureStrokes,
  verifyNativeContractIntegrity, nativeEsignCanonicalJson, type NativeContract, type NativeEsignContext,
} from './oda-esign.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const strokes = [[{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.6 }, { x: 0.5, y: 0.1 }]];
function fixture() {
  let id = 0;
  const now = '2026-09-16T00:00:00.000Z';
  const owner: NativeEsignContext = { actorId: 'owner', manager: true, now, id: () => `esign-${++id}`, hash, authMethod: 'password_reauthentication', reauthenticatedAt: now, ip: '127.0.0.1', userAgent: 'test' };
  const employee: NativeEsignContext = { ...owner, actorId: 'employee-account', manager: false };
  const stranger: NativeEsignContext = { ...owner, actorId: 'stranger', manager: true };
  const employerInput = { storeId: 'store-a', legalName: '테스트 고용주', businessNumber: '220-81-62517', representativeName: '대표자', signerName: '서명담당자', signerActorId: 'owner', address: '서울특별시 성동구 테스트로 10', active: true };
  const employer = createNativeEmployer(employerInput, owner);
  const terms = { employmentType: 'part_time', payType: 'hourly', basePay: 12000, effectiveDate: '2026-09-16', endDate: '', jobTitle: '매장 조리 및 고객 응대', workplace: '서울특별시 성동구 테스트로 10 1층', workDays: '월요일, 수요일, 금요일', dailyWorkHours: '월·수·금 각 8시간', workStart: '09:00', workEnd: '18:00', breakMinutes: 60, payday: '매월 10일', payCalculation: '기본급은 시급 × 실제 근로시간. 해당하는 주휴수당과 연장·야간·휴일근로수당은 별도 산정하여 지급한다.', payMethod: '근로자 본인 명의 계좌로 이체', holidays: '주휴일은 일요일로 하며 법정 휴일을 보장한다.', annualLeave: '관계 법령에 따라 부여한다.', additionalTerms: '휴게시간은 13:00~14:00로 정한다.' };
  const input = { storeId: 'store-a', employeeId: 'employee-record', employeeActorId: employee.actorId, employeeName: '근로자', title: '단시간 근로계약서', templateKey: 'part-time-v1', terms };
  const draft = createNativeContract(input, employer, owner);
  const request = (contract = draft) => requestNativeContract(contract, { expectedVersion: contract.version, expiresAt: '2026-09-23T00:00:00.000Z' }, owner);
  const sign = (contract: NativeContract, role: 'employer' | 'employee', ctx = role === 'employer' ? owner : employee, extra = {}) => signNativeContract(contract, { expectedVersion: contract.version, role, typedName: role === 'employer' ? employer.signerName : input.employeeName, documentHash: contract.documentHash, consent: true, consentVersion: NATIVE_ESIGN_CONSENT_VERSION, strokes, ...extra }, ctx);
  const completed = () => sign(sign(request(), 'employee'), 'employer');
  return { owner, employee, stranger, employerInput, employer, terms, input, draft, request, sign, completed };
}

test('고용주는 검증번호가 유효한 사업자등록번호를 저장하며 매장별로 여러 사업자를 독립 관리한다', () => {
  const { owner, employerInput, employer, employee } = fixture();
  assert.equal(employer.businessNumber, '2208162517');
  assert.equal(isValidKoreanBusinessNumber('2208162517'), true);
  for (const value of ['220-81-62518', '0000000000', '1111111111', '22081a62517', '220816251', '22081625170']) assert.equal(isValidKoreanBusinessNumber(value), false);
  assert.throws(() => createNativeEmployer({ ...employerInput, businessNumber: '2208162518' }, owner), code('ESIGN_BUSINESS_NUMBER'));
  assert.throws(() => createNativeEmployer(employerInput, employee), code('ESIGN_FORBIDDEN'));
  const another = createNativeEmployer({ ...employerInput, storeId: 'store-b', legalName: '다른 사업장' }, owner);
  assert.notEqual(another.id, employer.id); assert.equal(another.storeId, 'store-b'); assert.equal(employer.legalName, '테스트 고용주');
  const revised = updateNativeEmployer(employer, { ...employerInput, expectedVersion: employer.version, legalName: '상호 변경' }, owner);
  assert.equal(revised.version, employer.version + 1); assert.equal(employer.legalName, '테스트 고용주');
  assert.throws(() => updateNativeEmployer(revised, { ...employerInput, expectedVersion: employer.version }, owner), code('ESIGN_VERSION_CONFLICT'));
});

test('계약 당사자를 다른 매장에서 가져오거나 같은 계정에 양쪽 서명을 배정할 수 없다', () => {
  const { owner, employer, input } = fixture();
  assert.throws(() => createNativeContract({ ...input, storeId: 'store-b' }, employer, owner), code('ESIGN_EMPLOYER_SCOPE'));
  assert.throws(() => createNativeContract({ ...input, employeeActorId: owner.actorId }, employer, owner), code('ESIGN_SIGNER_CONFLICT'));
  assert.throws(() => createNativeContract(input, { ...employer, active: false }, owner), code('ESIGN_EMPLOYER_INACTIVE'));
});

test('동결 문서에 임금 계산·지급·근로일별 시간·휴일·연차와 모든 중요 조건이 포함된다', () => {
  const { draft, request, employer, terms } = fixture(); const pending = request();
  assert.equal(draft.status, 'draft'); assert.equal(draft.documentHash, '');
  assert.equal(pending.documentHash, hash(pending.documentText));
  for (const value of [employer.legalName, employer.businessNumber, employer.address, employer.representativeName, employer.signerName, ...Object.values(terms).filter(value => typeof value === 'string' && !['part_time', 'hourly', ''].includes(value))]) assert.ok(pending.documentText.includes(String(value)), String(value));
  assert.equal(pending.documentText, renderNativeContractDocument(pending));
  assert.equal(verifyNativeContractIntegrity(pending, hash), true);
  employer.legalName = '사후 변경';
  assert.equal(pending.employer.legalName, '테스트 고용주');
});

test('중요 조건 누락·잘못된 기간·휴게시간·금액을 거절한다', () => {
  const { terms } = fixture();
  for (const key of ['jobTitle', 'workplace', 'workDays', 'dailyWorkHours', 'payday', 'payCalculation', 'payMethod', 'holidays', 'annualLeave']) assert.throws(() => validateNativeContractTerms({ ...terms, [key]: '' }));
  for (const input of [{ employmentType: 'contract', endDate: '' }, { endDate: '2026-09-01' }, { effectiveDate: '2026-02-30' }, { workStart: '25:00' }, { breakMinutes: 540 }, { basePay: 0 }, { basePay: Infinity }, { basePay: '12000' }]) assert.throws(() => validateNativeContractTerms({ ...terms, ...input }));
  assert.equal(validateNativeContractTerms({ ...terms, workStart: '22:00', workEnd: '07:00' }).workEnd, '07:00');
});

test('서명 요청 이후 본문 수정·중복 요청을 차단하고 수정 실패로 원본을 변경하지 않는다', () => {
  const { draft, input, employer, owner, request } = fixture();
  const updated = updateNativeContract(draft, { ...input, expectedVersion: draft.version, title: '수정된 근로계약서' }, employer, owner);
  assert.equal(draft.title, '단시간 근로계약서'); assert.equal(updated.title, '수정된 근로계약서');
  const pending = request(updated), before = structuredClone(pending);
  assert.throws(() => updateNativeContract(pending, { ...input, expectedVersion: pending.version }, employer, owner), code('ESIGN_LOCKED'));
  assert.throws(() => request(pending), code('ESIGN_STATE')); assert.deepEqual(pending, before);
});

test('관리자라도 근로자를 대신하여 서명할 수 없고 정확한 서명 담당자만 자기 역할을 서명한다', () => {
  const { request, sign, stranger, owner } = fixture(); const pending = request();
  assert.throws(() => sign(pending, 'employee', owner), code('ESIGN_FORBIDDEN'));
  assert.throws(() => sign(pending, 'employer', stranger), code('ESIGN_FORBIDDEN'));
  const signed = sign(pending, 'employer', { ...owner, manager: false });
  assert.equal(signed.signatures[0]!.actorId, owner.actorId); assert.equal(signed.status, 'pending');
  assert.throws(() => sign(signed, 'employer'), code('ESIGN_ALREADY_SIGNED'));
});

test('서명은 최신 버전·읽은 원문 해시·정확한 이름·현재 동의와 서버 비밀번호 재인증이 모두 필요하다', () => {
  const { request, sign, employee } = fixture(); const pending = request();
  for (const [extra, error] of [[{ expectedVersion: pending.version - 1 }, 'ESIGN_VERSION_CONFLICT'], [{ documentHash: '0'.repeat(64) }, 'ESIGN_DOCUMENT_MISMATCH'], [{ typedName: '다른 근로자' }, 'ESIGN_NAME_MISMATCH'], [{ consent: false }, 'ESIGN_CONSENT_REQUIRED'], [{ consentVersion: 'old' }, 'ESIGN_CONSENT_REQUIRED']] as const) assert.throws(() => sign(pending, 'employee', employee, extra), code(error));
  const { authMethod: _authMethod, reauthenticatedAt: _reauthenticatedAt, ...withoutAuth } = employee;
  assert.throws(() => sign(pending, 'employee', withoutAuth), code('ESIGN_REAUTH_REQUIRED'));
  assert.throws(() => sign(pending, 'employee', { ...employee, reauthenticatedAt: '2026-09-15T23:54:59.000Z' }), code('ESIGN_REAUTH_REQUIRED'));
  assert.throws(() => sign(pending, 'employee', { ...employee, reauthenticatedAt: '2026-09-16T00:00:01.000Z' }), code('ESIGN_REAUTH_REQUIRED'));
  assert.equal(sign(pending, 'employee', { ...employee, reauthenticatedAt: '2026-09-15T23:55:00.000Z' }).signatures.length, 1);
});

test('정규화된 실제 서명 획을 요구하고 비정상 좌표·빈 서명·과대 입력을 거절한다', () => {
  for (const value of [[], [[{ x: 0, y: 0 }]], [[{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]], [[{ x: NaN, y: 0 }]], [[{ x: Infinity, y: 0 }]], [[{ x: -0.1, y: 0 }]], [[{ x: 0, y: 1.1 }]], Array.from({ length: 81 }, () => strokes[0]), [Array.from({ length: 4001 }, () => ({ x: 0.1, y: 0.1 }))]]) assert.throws(() => validateNativeSignatureStrokes(value), code('ESIGN_SIGNATURE_INVALID'));
  const result = validateNativeSignatureStrokes(strokes); assert.deepEqual(result, strokes); assert.notEqual(result, strokes);
});

test('서명 기한 경계에서 서명을 막으며 만료 계약을 취소하고 새 계약으로 진행할 수 있다', () => {
  const { request, sign, employee, owner } = fixture(); const pending = request();
  const expired = { ...employee, now: pending.expiresAt, reauthenticatedAt: pending.expiresAt };
  assert.throws(() => sign(pending, 'employee', expired), code('ESIGN_EXPIRED'));
  const cancelled = cancelNativeContract(pending, { expectedVersion: pending.version, reason: '기한 만료 후 재발급' }, { ...owner, now: pending.expiresAt });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(verifyNativeContractIntegrity(cancelled, hash), true);
});

test('양 당사자 서명 후에만 체결되며 완료 문서는 취소·거절·수정이 불가능하다', () => {
  const { request, sign, owner, employee, stranger, completed } = fixture();
  const pending = request(); assert.throws(() => declineNativeContract(pending, { expectedVersion: pending.version, reason: '반려' }, stranger), code('ESIGN_FORBIDDEN'));
  const declined = declineNativeContract(pending, { expectedVersion: pending.version, reason: '근로시간 수정 요청' }, employee);
  assert.equal(declined.status, 'declined'); assert.equal(verifyNativeContractIntegrity(declined, hash), true);
  const reopened = structuredClone(declined); reopened.status = 'pending';
  assert.equal(verifyNativeContractIntegrity(reopened, hash), false);
  const done = completed(); assert.equal(done.status, 'completed'); assert.equal(done.signatures.length, 2); assert.equal(verifyNativeContractIntegrity(done, hash), true);
  assert.throws(() => cancelNativeContract(done, { expectedVersion: done.version, reason: '수정' }, owner), code('ESIGN_STATE'));
  assert.throws(() => declineNativeContract(done, { expectedVersion: done.version, reason: '수정' }, employee), code('ESIGN_STATE'));
  assert.throws(() => sign(done, 'employee'), code('ESIGN_STATE'));
});

test('완료·내려받기·교부·인사반영을 분리하며 다른 사람의 다운로드를 직원 수령으로 기록하지 않는다', () => {
  const { completed, owner, employee } = fixture(); const done = completed();
  assert.deepEqual(done.deliveries, []); assert.equal(done.appliedAt, undefined);
  assert.throws(() => recordNativeContractDelivery(done, { expectedVersion: done.version, method: 'employee_download' }, owner), code('ESIGN_FORBIDDEN'));
  const downloaded = recordNativeContractDelivery(done, { expectedVersion: done.version, method: 'employee_download' }, employee);
  assert.equal(downloaded.deliveries[0]!.method, 'employee_download'); assert.equal(verifyNativeContractIntegrity(downloaded, hash), true);
  assert.throws(() => recordNativeContractDelivery(downloaded, { expectedVersion: downloaded.version, method: 'manual_handover', evidenceNote: '' }, owner));
  const handed = recordNativeContractDelivery(downloaded, { expectedVersion: downloaded.version, method: 'manual_handover', evidenceNote: '2026-09-16 근로자에게 출력본 직접 전달. 수령 확인 기록 보관.' }, owner);
  assert.equal(handed.deliveries.length, 2); assert.equal(verifyNativeContractIntegrity(handed, hash), true);
  const applied = applyNativeContract(handed, { expectedVersion: handed.version }, owner);
  assert.equal(applied.appliedBy, owner.actorId); assert.equal(verifyNativeContractIntegrity(applied, hash), true);
  assert.throws(() => applyNativeContract(applied, { expectedVersion: applied.version }, owner), code('ESIGN_ALREADY_APPLIED'));
});

test('미래 계약은 한국 날짜 기준 적용일까지 기다리며 직원은 인사정보 반영을 할 수 없다', () => {
  const { completed, owner, employee } = fixture(); const done = completed();
  assert.throws(() => applyNativeContract(done, { expectedVersion: done.version }, { ...owner, now: '2026-09-15T14:59:59.000Z' }), code('ESIGN_NOT_EFFECTIVE'));
  assert.equal(applyNativeContract(done, { expectedVersion: done.version }, { ...owner, now: '2026-09-15T15:00:00.000Z' }).appliedAt, '2026-09-15T15:00:00.000Z');
  assert.throws(() => applyNativeContract(done, { expectedVersion: done.version }, employee), code('ESIGN_FORBIDDEN'));
});

test('문서·조건·서명 획·서명자·감사 이벤트·기한·완료 상태 변조를 무결성 검사로 검출한다', () => {
  const { completed, request, owner } = fixture(); const done = completed();
  const tamper: Array<(value: NativeContract) => void> = [
    value => { value.documentText += '\n변조'; }, value => { value.terms.basePay = 1; },
    value => { value.signatures[0]!.strokes[0]![0]!.x = 0.9; }, value => { value.signatures[0]!.actorId = owner.actorId; },
    value => { value.audit[0]!.actorId = 'attacker'; }, value => { value.expiresAt = '2099-01-01T00:00:00.000Z'; },
    value => { value.signatures.pop(); }, value => { value.audit.splice(1, 1); },
  ];
  for (const change of tamper) { const altered = structuredClone(done); change(altered); assert.equal(verifyNativeContractIntegrity(altered, hash), false); }
  const fakeComplete = request(); fakeComplete.status = 'completed'; assert.equal(verifyNativeContractIntegrity(fakeComplete, hash), false);
  const altered = structuredClone(done); altered.terms.basePay = 1;
  assert.throws(() => applyNativeContract(altered, { expectedVersion: altered.version }, owner), code('ESIGN_INTEGRITY'));
});

test('과거 렌더러의 동결 문서는 현재 서식과 달라도 보관된 해시와 고정된 조건으로 검증한다', () => {
  const { request, sign } = fixture(); const archived = request();
  // Construct a historical fixture whose original renderer included this heading.
  archived.documentText = `과거 서식의 보관용 머리말\n${archived.documentText}`;
  archived.documentHash = hash(archived.documentText);
  let previousHash = '';
  archived.audit = archived.audit.map(event => {
    const { hash: _oldHash, ...unsigned } = event;
    if (unsigned.documentHash) unsigned.documentHash = archived.documentHash;
    unsigned.previousHash = previousHash;
    const digest = hash(nativeEsignCanonicalJson(unsigned)); previousHash = digest;
    return { ...unsigned, hash: digest };
  });
  assert.notEqual(renderNativeContractDocument(archived), archived.documentText);
  assert.equal(verifyNativeContractIntegrity(archived, hash), true);
  const complete = sign(sign(archived, 'employee'), 'employer');
  assert.equal(complete.documentText, archived.documentText);
  assert.equal(verifyNativeContractIntegrity(complete, hash), true);
  complete.terms.payMethod = '변경된 지급방법';
  assert.equal(verifyNativeContractIntegrity(complete, hash), false);
});
