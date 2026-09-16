import { DomainError } from './errors.ts';

/** Hashing and authentication are supplied by the server, never accepted from request bodies. */
export interface NativeEsignContext {
  actorId: string;
  manager: boolean;
  now: string;
  id: () => string;
  hash: (canonical: string) => string;
  ip?: string;
  userAgent?: string;
  authMethod?: 'password_reauthentication';
  reauthenticatedAt?: string;
}
export interface NativeEmployer {
  id: string; storeId: string; version: number;
  legalName: string; businessNumber: string; representativeName: string; address: string;
  signerActorId: string; signerName: string; active: boolean;
  createdAt: string; createdBy: string; updatedAt: string;
}
export interface NativeEmployerSnapshot {
  id: string; version: number; legalName: string; businessNumber: string; representativeName: string;
  address: string; signerActorId: string; signerName: string;
}
export interface NativeContractTerms {
  employmentType: 'regular' | 'contract' | 'part_time';
  payType: 'monthly' | 'hourly'; basePay: number;
  effectiveDate: string; endDate: string; jobTitle: string; workplace: string;
  /** Human-readable agreed days and each day's hours; stored verbatim in the frozen document. */
  workDays: string; dailyWorkHours: string;
  workStart: string; workEnd: string; breakMinutes: number;
  payday: string; payCalculation: string; payMethod: string; holidays: string; annualLeave: string;
  additionalTerms: string;
}
export type NativeSignatureRole = 'employer' | 'employee';
export interface NativeSignaturePoint { x: number; y: number; }
export type NativeSignatureStroke = NativeSignaturePoint[];
export interface NativeContractSignature {
  id: string; role: NativeSignatureRole; actorId: string; name: string; at: string;
  documentHash: string; authMethod: 'password_reauthentication'; reauthenticatedAt: string;
  ip: string; userAgent: string; consentVersion: string; intentText: string;
  strokes: NativeSignatureStroke[];
}
export interface NativeContractAuditEvent {
  id: string; sequence: number; at: string; actorId: string; action: string;
  documentHash: string; details: Record<string, string | number | boolean>;
  previousHash: string; hash: string;
}
export interface NativeContractDelivery {
  id: string; at: string; actorId: string;
  /** Download is an access receipt, not proof that a copy was legally delivered. */
  method: 'employee_download' | 'manual_handover'; evidenceNote: string; documentHash: string;
}
export interface NativeContract {
  id: string; storeId: string; version: number;
  employeeId: string; employeeActorId: string; employeeName: string;
  employer: NativeEmployerSnapshot;
  title: string; templateKey: string; terms: NativeContractTerms;
  consentVersion: string; intentText: string;
  documentText: string; documentHash: string;
  status: 'draft' | 'pending' | 'completed' | 'declined' | 'cancelled';
  expiresAt: string; createdAt: string; createdBy: string; updatedAt: string;
  requestedAt?: string; completedAt?: string; closedAt?: string; closeReason?: string;
  signatures: NativeContractSignature[]; audit: NativeContractAuditEvent[]; deliveries: NativeContractDelivery[];
  appliedAt?: string; appliedBy?: string;
  artifacts?: { contract: { id: string; sha256: string }; evidence: { id: string; sha256: string } };
}

export const NATIVE_ESIGN_CONSENT_VERSION = 'oda-esign-v1-2026-09';
export const NATIVE_ESIGN_INTENT_TEXT = '계약서 전체 내용을 확인하였고, 본인 의사에 따라 전자서명하여 이 계약을 체결합니다. 전자문서로 계약서 사본을 제공받는 데 동의합니다.';

function fail(message: string, code = 'ESIGN_VALIDATION', status = 422): never { throw new DomainError(code, message, status); }
function manager(ctx: NativeEsignContext): void { if (!ctx.manager) fail('계약 관리 권한이 필요합니다.', 'ESIGN_FORBIDDEN', 403); }
function text(input: Record<string, unknown>, key: string, max = 300, optional = false): string {
  const value = input[key];
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${key}: 1~${max}자 이내의 값을 입력해 주세요.`);
  return value.trim().normalize('NFC');
}
function number(input: Record<string, unknown>, key: string, min: number, max: number, integer = false): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${key}: 올바른 숫자를 입력해 주세요.`);
  return value;
}
function enumValue<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[]): T {
  if (typeof input[key] !== 'string' || !values.includes(input[key] as T)) fail(`${key}: 올바른 항목을 선택해 주세요.`);
  return input[key] as T;
}
function date(input: Record<string, unknown>, key: string, optional = false): string {
  const value = text(input, key, 10, optional); if (!value && optional) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${key}: 실제 날짜를 입력해 주세요.`);
  return value;
}
function instant(value: string, label: string): number {
  const result = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(result)) fail(`${label}: 유효한 시각이 필요합니다.`);
  return result;
}
function expected(current: {version: number}, input: Record<string, unknown>): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== current.version) fail('계약 정보가 변경되었습니다. 새로고침 후 다시 진행해 주세요.', 'ESIGN_VERSION_CONFLICT', 409);
}
function sha(ctx: NativeEsignContext, value: string): string {
  const digest = ctx.hash(value);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('서버 문서 해시 설정을 확인해 주세요.', 'ESIGN_HASH_CONFIGURATION', 500);
  return digest;
}
/** Sorted serialization is stable across JSON transport and server restarts. */
export function nativeEsignCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(nativeEsignCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${nativeEsignCanonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('증빙에 직렬화할 수 없는 값이 있습니다.', 'ESIGN_INVALID_EVIDENCE');
  return encoded;
}
export function isValidKoreanBusinessNumber(value: string): boolean {
  if (!/^[\d -]+$/.test(value)) return false;
  const normalized = value.replace(/[ -]/g, '');
  if (!/^\d{10}$/.test(normalized) || /^(\d)\1{9}$/.test(normalized)) return false;
  const digits = [...normalized].map(Number), weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const total = weights.reduce((sum, weight, index) => sum + digits[index]! * weight, 0) + Math.floor(digits[8]! * 5 / 10);
  return (10 - total % 10) % 10 === digits[9];
}
function employerValues(input: Record<string, unknown>) {
  const raw = text(input, 'businessNumber', 14);
  if (!isValidKoreanBusinessNumber(raw)) fail('사업자등록번호 10자리와 검증번호를 확인해 주세요.', 'ESIGN_BUSINESS_NUMBER');
  if (input.active !== undefined && typeof input.active !== 'boolean') fail('사용 여부를 확인해 주세요.');
  return { legalName: text(input, 'legalName'), businessNumber: raw.replace(/[ -]/g, ''), representativeName: text(input, 'representativeName', 100), address: text(input, 'address', 500), signerActorId: text(input, 'signerActorId', 120), signerName: text(input, 'signerName', 100), active: input.active !== false };
}
export function createNativeEmployer(input: Record<string, unknown>, ctx: NativeEsignContext): NativeEmployer {
  manager(ctx); instant(ctx.now, '현재 시각');
  return { id: ctx.id(), storeId: text(input, 'storeId', 120), version: 1, ...employerValues(input), createdAt: ctx.now, createdBy: ctx.actorId, updatedAt: ctx.now };
}
export function updateNativeEmployer(current: NativeEmployer, input: Record<string, unknown>, ctx: NativeEsignContext): NativeEmployer {
  manager(ctx); expected(current, input);
  return { ...current, ...employerValues(input), version: current.version + 1, updatedAt: ctx.now };
}
function snapshot(employer: NativeEmployer): NativeEmployerSnapshot {
  if (!employer.active) fail('사용 중인 고용주를 선택해 주세요.', 'ESIGN_EMPLOYER_INACTIVE');
  return { id: employer.id, version: employer.version, legalName: employer.legalName, businessNumber: employer.businessNumber, representativeName: employer.representativeName, address: employer.address, signerActorId: employer.signerActorId, signerName: employer.signerName };
}
export function validateNativeContractTerms(value: unknown): NativeContractTerms {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('근로조건을 입력해 주세요.');
  const input = value as Record<string, unknown>;
  const employmentType = enumValue(input, 'employmentType', ['regular', 'contract', 'part_time']);
  const effectiveDate = date(input, 'effectiveDate'), endDate = date(input, 'endDate', true);
  if (employmentType === 'contract' && !endDate) fail('기간제 근로계약의 종료일을 입력해 주세요.');
  if (endDate && endDate < effectiveDate) fail('계약 종료일은 시작일 이후여야 합니다.');
  const workStart = text(input, 'workStart', 5), workEnd = text(input, 'workEnd', 5);
  if (![workStart, workEnd].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) fail('출퇴근 시간을 HH:MM 형식으로 입력해 주세요.');
  const breakMinutes = number(input, 'breakMinutes', 0, 720, true);
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const elapsed = (minutes(workEnd) - minutes(workStart) + 1440) % 1440;
  if (elapsed === 0 || breakMinutes >= elapsed) fail('근무시간과 휴게시간을 확인해 주세요.');
  return { employmentType, payType: enumValue(input, 'payType', ['monthly', 'hourly']), basePay: number(input, 'basePay', 1, 1_000_000_000, true), effectiveDate, endDate,
    jobTitle: text(input, 'jobTitle'), workplace: text(input, 'workplace', 500), workDays: text(input, 'workDays', 500), dailyWorkHours: text(input, 'dailyWorkHours', 1000), workStart, workEnd, breakMinutes,
    payday: text(input, 'payday', 500), payCalculation: text(input, 'payCalculation', 2000), payMethod: text(input, 'payMethod', 500), holidays: text(input, 'holidays', 2000), annualLeave: text(input, 'annualLeave', 2000), additionalTerms: text(input, 'additionalTerms', 8000, true) };
}
function contractValues(input: Record<string, unknown>, employer: NativeEmployer) {
  const storeId = text(input, 'storeId', 120);
  if (employer.storeId !== storeId) fail('해당 매장에 등록된 고용주를 선택해 주세요.', 'ESIGN_EMPLOYER_SCOPE', 403);
  const employeeActorId = text(input, 'employeeActorId', 120);
  if (employeeActorId === employer.signerActorId) fail('사용자와 근로자의 서명 계정은 서로 달라야 합니다.', 'ESIGN_SIGNER_CONFLICT');
  return { storeId, employeeId: text(input, 'employeeId', 120), employeeActorId, employeeName: text(input, 'employeeName', 100), employer: snapshot(employer), title: text(input, 'title', 200), templateKey: text(input, 'templateKey', 100), terms: validateNativeContractTerms(input.terms) };
}

/** This exact text is the document that signers see and sign; signatures are separate evidence. */
export function renderNativeContractDocument(contract: Pick<NativeContract, 'id' | 'storeId' | 'title' | 'templateKey' | 'employeeId' | 'employeeActorId' | 'employeeName' | 'employer' | 'terms' | 'intentText' | 'consentVersion'>): string {
  const { employer: e, terms: t } = contract;
  const employment = { regular: '정규직', contract: '기간제', part_time: '단시간' }[t.employmentType];
  return [contract.title, '', `문서번호: ${contract.id}`, `매장 식별자: ${contract.storeId}`, `양식 버전: ${contract.templateKey}`, '',
    '1. 계약 당사자', `사용자: ${e.legalName}`, `사업자등록번호: ${e.businessNumber}`, `대표자: ${e.representativeName}`, `사업장 주소: ${e.address}`, `사용자 서명 담당자: ${e.signerName}`, `사용자 서명 계정: ${e.signerActorId}`, `고용주 정보 버전: ${e.id}/${e.version}`,
    `근로자: ${contract.employeeName}`, `근로자 식별자: ${contract.employeeId}`, `근로자 서명 계정: ${contract.employeeActorId}`, '',
    '2. 근로계약 기간 및 업무', `고용형태: ${employment}`, `근로 시작일: ${t.effectiveDate}`, `근로 종료일: ${t.endDate || '기간의 정함 없음'}`, `담당 업무: ${t.jobTitle}`, `근무 장소: ${t.workplace}`, '',
    '3. 근로일 및 근로시간', `근로일: ${t.workDays}`, `근로일별 근로시간: ${t.dailyWorkHours}`, `시업 시각: ${t.workStart}`, `종업 시각: ${t.workEnd}${t.workEnd < t.workStart ? ' (다음 날)' : ''}`, `휴게시간: ${t.breakMinutes}분`, '',
    '4. 임금', `급여 기준: ${t.payType === 'monthly' ? '월급' : '시급'}`, `기본급: ${t.basePay}원`, `임금 구성 및 계산: ${t.payCalculation}`, `임금 지급일: ${t.payday}`, `임금 지급 방법: ${t.payMethod}`, '',
    '5. 휴일 및 휴가', `휴일: ${t.holidays}`, `연차유급휴가: ${t.annualLeave}`, '', '6. 추가 약정', t.additionalTerms || '별도 추가 약정 없음', '',
    '7. 전자서명 및 계약서 사본', contract.intentText, '체결 완료 후 근로자는 본인 계정에서 계약서 사본을 내려받을 수 있습니다. 사용자는 계약서 사본 교부를 별도로 확인합니다.', `전자서명 동의 버전: ${contract.consentVersion}`].join('\n');
}
/** Keep this v1 field set immutable; introduce a separate version for future schemas. */
function nativeContractSnapshotV1(contract: NativeContract): Record<string, unknown> {
  const t = contract.terms, e = contract.employer;
  return { id: contract.id, storeId: contract.storeId, title: contract.title, templateKey: contract.templateKey,
    employeeId: contract.employeeId, employeeActorId: contract.employeeActorId, employeeName: contract.employeeName,
    consentVersion: contract.consentVersion, intentText: contract.intentText,
    employer: { id: e.id, version: e.version, legalName: e.legalName, businessNumber: e.businessNumber, representativeName: e.representativeName, address: e.address, signerActorId: e.signerActorId, signerName: e.signerName },
    terms: { employmentType: t.employmentType, payType: t.payType, basePay: t.basePay, effectiveDate: t.effectiveDate, endDate: t.endDate, jobTitle: t.jobTitle, workplace: t.workplace, workDays: t.workDays, dailyWorkHours: t.dailyWorkHours, workStart: t.workStart, workEnd: t.workEnd, breakMinutes: t.breakMinutes, payday: t.payday, payCalculation: t.payCalculation, payMethod: t.payMethod, holidays: t.holidays, annualLeave: t.annualLeave, additionalTerms: t.additionalTerms } };
}
function audit(contract: NativeContract, action: string, details: NativeContractAuditEvent['details'], ctx: NativeEsignContext): void {
  const unsigned = { id: ctx.id(), sequence: contract.audit.length + 1, at: ctx.now, actorId: ctx.actorId, action, documentHash: contract.documentHash, details, previousHash: contract.audit.at(-1)?.hash ?? '' };
  contract.audit.push({ ...unsigned, hash: sha(ctx, nativeEsignCanonicalJson(unsigned)) });
}
function revised(current: NativeContract, ctx: NativeEsignContext): NativeContract {
  return { ...structuredClone(current), version: current.version + 1, updatedAt: ctx.now };
}
export function createNativeContract(input: Record<string, unknown>, employer: NativeEmployer, ctx: NativeEsignContext): NativeContract {
  manager(ctx);
  const contract: NativeContract = { id: ctx.id(), ...contractValues(input, employer), consentVersion: NATIVE_ESIGN_CONSENT_VERSION, intentText: NATIVE_ESIGN_INTENT_TEXT, version: 1, documentText: '', documentHash: '', status: 'draft', expiresAt: '', createdAt: ctx.now, createdBy: ctx.actorId, updatedAt: ctx.now, signatures: [], audit: [], deliveries: [] };
  contract.documentText = renderNativeContractDocument(contract);
  audit(contract, 'contract.created', { employerId: employer.id }, ctx);
  return contract;
}
export function updateNativeContract(current: NativeContract, input: Record<string, unknown>, employer: NativeEmployer, ctx: NativeEsignContext): NativeContract {
  manager(ctx); expected(current, input);
  if (current.status !== 'draft') fail('작성 중인 계약만 수정할 수 있습니다.', 'ESIGN_LOCKED', 409);
  const values = contractValues(input, employer);
  if (values.storeId !== current.storeId) fail('계약의 매장을 변경할 수 없습니다.', 'ESIGN_FORBIDDEN', 403);
  const next = { ...revised(current, ctx), ...values, consentVersion: NATIVE_ESIGN_CONSENT_VERSION, intentText: NATIVE_ESIGN_INTENT_TEXT };
  next.documentText = renderNativeContractDocument(next);
  audit(next, 'contract.updated', { employerId: employer.id }, ctx);
  return next;
}
export function requestNativeContract(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  manager(ctx); expected(current, input);
  if (current.status !== 'draft') fail('작성 중인 계약만 서명 요청할 수 있습니다.', 'ESIGN_STATE', 409);
  const expiresAt = text(input, 'expiresAt', 35), delta = instant(expiresAt, '서명 기한') - instant(ctx.now, '현재 시각');
  if (delta <= 0 || delta > 90 * 86400000) fail('서명 기한은 현재 이후 90일 이내로 지정해 주세요.');
  validateNativeContractTerms(current.terms);
  const next = revised(current, ctx);
  next.documentText = renderNativeContractDocument(next); next.documentHash = sha(ctx, next.documentText);
  next.status = 'pending'; next.expiresAt = new Date(expiresAt).toISOString(); next.requestedAt = ctx.now;
  audit(next, 'contract.requested', { expiresAt: next.expiresAt, snapshotVersion: 'v1', snapshotHash: sha(ctx, nativeEsignCanonicalJson(nativeContractSnapshotV1(next))) }, ctx);
  return next;
}
export function verifyNativeContractIntegrity(contract: NativeContract, hash: NativeEsignContext['hash']): boolean {
  if (!['draft', 'pending', 'completed', 'declined', 'cancelled'].includes(contract.status)) return false;
  // Never re-render signed history with the current template implementation.
  if (contract.status !== 'draft' && (!contract.documentHash || hash(contract.documentText) !== contract.documentHash)) return false;
  let previousHash = '';
  for (let i = 0; i < contract.audit.length; i++) {
    const event = contract.audit[i]!; const { hash: digest, ...unsigned } = event;
    if (event.sequence !== i + 1 || event.previousHash !== previousHash || hash(nativeEsignCanonicalJson(unsigned)) !== digest) return false;
    previousHash = digest;
  }
  if (contract.status === 'draft') return contract.signatures.length === 0 && !contract.documentHash && !contract.requestedAt && !contract.completedAt;
  const requested = contract.audit.filter(event => event.action === 'contract.requested');
  if (requested.length !== 1 || requested[0]!.documentHash !== contract.documentHash || requested[0]!.at !== contract.requestedAt || requested[0]!.details.expiresAt !== contract.expiresAt) return false;
  if (requested[0]!.details.snapshotVersion !== 'v1' || requested[0]!.details.snapshotHash !== hash(nativeEsignCanonicalJson(nativeContractSnapshotV1(contract)))) return false;
  const signatureEvents = contract.audit.filter(event => event.action.startsWith('signature.'));
  if (signatureEvents.length !== contract.signatures.length || contract.signatures.length > 2 || new Set(contract.signatures.map(signature => signature.role)).size !== contract.signatures.length) return false;
  for (const signature of contract.signatures) {
    const actorId = signature.role === 'employer' ? contract.employer.signerActorId : contract.employeeActorId;
    const name = signature.role === 'employer' ? contract.employer.signerName : contract.employeeName;
    const event = signatureEvents.find(row => row.details.signatureId === signature.id);
    if (!event || event.action !== `signature.${signature.role}` || event.actorId !== actorId || event.at !== signature.at || signature.actorId !== actorId || signature.name !== name || signature.documentHash !== contract.documentHash || event.documentHash !== contract.documentHash || signature.consentVersion !== contract.consentVersion || signature.intentText !== contract.intentText || event.details.signatureHash !== hash(nativeEsignCanonicalJson(signature))) return false;
  }
  const completed = contract.audit.filter(event => event.action === 'contract.completed');
  if (contract.status === 'completed') {
    if (contract.signatures.length !== 2 || completed.length !== 1 || completed[0]!.at !== contract.completedAt) return false;
  } else if (contract.signatures.length === 2 || contract.completedAt || completed.length || contract.deliveries.length || contract.appliedAt || contract.appliedBy) return false;
  const closed = contract.audit.filter(event => ['contract.declined', 'contract.cancelled'].includes(event.action));
  if (contract.status === 'declined' || contract.status === 'cancelled') {
    if (closed.length !== 1 || closed[0]!.action !== `contract.${contract.status}` || closed[0]!.at !== contract.closedAt || closed[0]!.details.reason !== contract.closeReason) return false;
  } else if (closed.length || contract.closedAt || contract.closeReason) return false;
  const applied = contract.audit.filter(event => event.action === 'hr.applied');
  if (applied.length !== (contract.appliedAt ? 1 : 0) || (contract.appliedAt && (applied[0]!.at !== contract.appliedAt || applied[0]!.actorId !== contract.appliedBy))) return false;
  const deliveryEvents = contract.audit.filter(event => event.action.startsWith('copy.'));
  if (deliveryEvents.length !== contract.deliveries.length) return false;
  return contract.deliveries.every(delivery => delivery.documentHash === contract.documentHash && deliveryEvents.some(event => event.details.deliveryId === delivery.id && event.details.deliveryHash === hash(nativeEsignCanonicalJson(delivery))));
}
function intact(current: NativeContract, ctx: NativeEsignContext): void {
  if (!verifyNativeContractIntegrity(current, ctx.hash)) fail('계약 원문 또는 증빙 무결성을 확인하지 못했습니다.', 'ESIGN_INTEGRITY', 409);
}
function pending(current: NativeContract, ctx: NativeEsignContext, enforceExpiry = true): void {
  if (current.status !== 'pending') fail('서명 진행 중인 계약만 처리할 수 있습니다.', 'ESIGN_STATE', 409);
  if (enforceExpiry && instant(current.expiresAt, '서명 기한') <= instant(ctx.now, '현재 시각')) fail('서명 기한이 지났습니다. 담당자에게 새 계약을 요청해 주세요.', 'ESIGN_EXPIRED', 409);
  intact(current, ctx);
}
export function validateNativeSignatureStrokes(value: unknown): NativeSignatureStroke[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) fail('서명란에 직접 서명해 주세요.', 'ESIGN_SIGNATURE_INVALID');
  let count = 0, length = 0;
  const strokes = value.map(stroke => {
    if (!Array.isArray(stroke) || stroke.length < 1 || stroke.length > 4000) fail('서명 획 정보를 확인해 주세요.', 'ESIGN_SIGNATURE_INVALID');
    const points = stroke.map((point: unknown) => {
      if (!point || typeof point !== 'object' || Array.isArray(point)) fail('서명 좌표를 확인해 주세요.', 'ESIGN_SIGNATURE_INVALID');
      const p = point as Record<string, unknown>; count++;
      if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) fail('서명 좌표는 0~1 범위여야 합니다.', 'ESIGN_SIGNATURE_INVALID');
      return { x: p.x, y: p.y };
    });
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    return points;
  });
  if (count < 3 || count > 8000 || length < 0.08) fail('서명란에 알아볼 수 있는 서명을 남겨 주세요.', 'ESIGN_SIGNATURE_INVALID');
  return strokes;
}
export function signNativeContract(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  expected(current, input); pending(current, ctx);
  const role = enumValue(input, 'role', ['employer', 'employee']);
  const assignedActorId = role === 'employer' ? current.employer.signerActorId : current.employeeActorId;
  const assignedName = role === 'employer' ? current.employer.signerName : current.employeeName;
  if (ctx.actorId !== assignedActorId) fail('본인에게 지정된 서명만 할 수 있습니다.', 'ESIGN_FORBIDDEN', 403);
  if (current.signatures.some(signature => signature.role === role || signature.actorId === ctx.actorId)) fail('이미 서명한 계약입니다.', 'ESIGN_ALREADY_SIGNED', 409);
  if (text(input, 'typedName', 100) !== assignedName.normalize('NFC')) fail('계약서의 본인 이름을 정확히 입력해 주세요.', 'ESIGN_NAME_MISMATCH');
  if (input.consent !== true || input.consentVersion !== current.consentVersion) fail('계약 내용 및 전자서명 동의를 확인해 주세요.', 'ESIGN_CONSENT_REQUIRED');
  if (input.documentHash !== current.documentHash) fail('확인한 계약 원문이 변경되었습니다. 다시 열어 확인해 주세요.', 'ESIGN_DOCUMENT_MISMATCH', 409);
  if (ctx.authMethod !== 'password_reauthentication' || !ctx.reauthenticatedAt) fail('본인 계정 비밀번호를 다시 확인해 주세요.', 'ESIGN_REAUTH_REQUIRED', 401);
  const elapsed = instant(ctx.now, '현재 시각') - instant(ctx.reauthenticatedAt, '본인 확인 시각');
  if (elapsed < 0 || elapsed > 5 * 60 * 1000) fail('본인 확인 시간이 만료되었습니다. 다시 확인해 주세요.', 'ESIGN_REAUTH_REQUIRED', 401);
  const strokes = validateNativeSignatureStrokes(input.strokes), next = revised(current, ctx);
  const signature: NativeContractSignature = { id: ctx.id(), role, actorId: ctx.actorId, name: assignedName, at: ctx.now, documentHash: current.documentHash, authMethod: 'password_reauthentication', reauthenticatedAt: ctx.reauthenticatedAt, ip: ctx.ip ?? '', userAgent: ctx.userAgent ?? '', consentVersion: current.consentVersion, intentText: current.intentText, strokes };
  next.signatures.push(signature);
  // The audit chain covers the signature data as well as the document hash.
  audit(next, `signature.${role}`, { signatureId: signature.id, signatureHash: sha(ctx, nativeEsignCanonicalJson(signature)) }, ctx);
  if (next.signatures.length === 2) { next.status = 'completed'; next.completedAt = ctx.now; audit(next, 'contract.completed', {}, ctx); }
  return next;
}
export function declineNativeContract(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  expected(current, input); pending(current, ctx);
  if (![current.employeeActorId, current.employer.signerActorId].includes(ctx.actorId)) fail('계약 당사자만 거절할 수 있습니다.', 'ESIGN_FORBIDDEN', 403);
  const reason = text(input, 'reason', 2000), next = revised(current, ctx);
  next.status = 'declined'; next.closedAt = ctx.now; next.closeReason = reason; audit(next, 'contract.declined', { reason }, ctx); return next;
}
export function cancelNativeContract(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  manager(ctx); expected(current, input); pending(current, ctx, false);
  const reason = text(input, 'reason', 2000), next = revised(current, ctx);
  next.status = 'cancelled'; next.closedAt = ctx.now; next.closeReason = reason; audit(next, 'contract.cancelled', { reason }, ctx); return next;
}
export function recordNativeContractDelivery(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  expected(current, input); intact(current, ctx);
  if (current.status !== 'completed') fail('체결이 완료된 계약의 사본만 교부 기록을 남길 수 있습니다.', 'ESIGN_STATE', 409);
  const method = enumValue(input, 'method', ['employee_download', 'manual_handover']);
  if (method === 'employee_download' && ctx.actorId !== current.employeeActorId) fail('직원의 실제 사본 내려받기만 기록할 수 있습니다.', 'ESIGN_FORBIDDEN', 403);
  if (method === 'manual_handover') manager(ctx);
  const evidenceNote = text(input, 'evidenceNote', 2000, method === 'employee_download'), next = revised(current, ctx);
  const delivery: NativeContractDelivery = { id: ctx.id(), at: ctx.now, actorId: ctx.actorId, method, evidenceNote, documentHash: current.documentHash };
  next.deliveries.push(delivery); audit(next, `copy.${method}`, { deliveryId: delivery.id, deliveryHash: sha(ctx, nativeEsignCanonicalJson(delivery)), evidenceNote }, ctx); return next;
}
export function applyNativeContract(current: NativeContract, input: Record<string, unknown>, ctx: NativeEsignContext): NativeContract {
  manager(ctx); expected(current, input); intact(current, ctx);
  if (current.status !== 'completed') fail('체결이 완료된 계약만 인사정보에 반영할 수 있습니다.', 'ESIGN_STATE', 409);
  if (current.appliedAt) fail('이미 인사정보에 반영한 계약입니다.', 'ESIGN_ALREADY_APPLIED', 409);
  const today = new Date(instant(ctx.now, '현재 시각') + 9 * 3600000).toISOString().slice(0, 10);
  if (current.terms.effectiveDate > today) fail('계약 적용일 이후 인사정보에 반영할 수 있습니다.', 'ESIGN_NOT_EFFECTIVE', 409);
  const next = revised(current, ctx); next.appliedAt = ctx.now; next.appliedBy = ctx.actorId;
  audit(next, 'hr.applied', { effectiveDate: current.terms.effectiveDate }, ctx); return next;
}
