import { createHash, randomUUID } from 'node:crypto';
import type { StateRepository } from '@ofd/db';
import { calculateHrPayrollRun, capabilitiesForPages, createOdaMonth, DomainError, normalizeOdaCategory,
  type Actor, type HrPayrollRun, type HrWorkspace, type OdaLine, type OdaMonth, type OdaSource, type Store } from '@ofd/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from './events.ts';
import { idempotentMutation } from './idempotency.ts';
import { ACCESS_POLICY_ID, resolveVisiblePages, type AccessPolicyDocument } from './service.ts';

interface PayrollCostLink { lineId: string; sourceId: string; signature: string; lineHash: string; runId: string; runRevision: number; hrVersion: number }
interface CostMonth extends OdaMonth { evidenceBytes: Record<string, string>; hrPayrollCost?: PayrollCostLink }
export interface HrPayrollCostPreview {
  storeId: string; month: string; hrVersion: number; odaVersion: number;
  payrollRunId: string | null; payrollRunRevision: number | null; payrollStatus: HrPayrollRun['status'] | null;
  odaStatus: OdaMonth['status']; gross: number | null; employerInsurance: number | null; total: number | null;
  currentAmount: number; otherLaborAmount: number; otherLaborCount: number; alreadyApplied: boolean;
  canApply: boolean; blockers: string[];
}
const monthSchema = z.string().regex(/^(19\d{2}|20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/);
const paramsSchema = z.object({ storeId: z.string().trim().min(1).max(120) }).strict();
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const querySchema = z.object({ month: monthSchema }).strict();
const bodySchema = querySchema.extend({ expectedHrVersion: version, expectedOdaVersion: version, expectedPayrollRunId: z.string().min(1).max(120).optional() }).strict();
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const lineIdFor = (month: string): string => `hr-payroll:${month}`;
const final = (run: HrPayrollRun): boolean => run.status === 'locked' || run.status === 'published';

async function scope(repository: StateRepository, actor: Actor | undefined, storeId: string, write: boolean): Promise<Store> {
  if (!actor?.active || !['hq_master', 'store_owner', 'hq_finance', 'auditor'].includes(actor.role)
    || (write && actor.role === 'auditor') || (actor.role === 'store_owner' && !actor.storeIds.includes(storeId))
    || (actor.storeIds.length > 0 && !actor.storeIds.includes(storeId))) throw new DomainError('HR_PAYROLL_COST_FORBIDDEN', '이 매장의 급여·월 정산을 함께 처리할 권한이 없습니다.', 403);
  const policy = await repository.get<AccessPolicyDocument>('access_policy', ACCESS_POLICY_ID);
  const caps = capabilitiesForPages(actor.role, resolveVisiblePages(actor, policy));
  if (!caps.some(cap => cap === 'oda.hr.read' || cap === 'oda.hr.hq.read')
    || !caps.some(cap => cap === 'oda.settlement.read' || cap === 'oda.finance.read')) throw new DomainError('HR_PAYROLL_COST_FORBIDDEN', '인사관리와 월 정산 접근 권한이 모두 필요합니다.', 403);
  const store = await repository.get<Store>('store', storeId);
  if (!store?.active) throw new DomainError('HR_PAYROLL_COST_STORE', '운영 중인 매장을 찾을 수 없습니다.', 404);
  return store;
}
async function load(repository: StateRepository, store: Store, month: string): Promise<{ hr: HrWorkspace | undefined; oda: CostMonth }> {
  const hr = await repository.get<HrWorkspace>('oda_hr', `hr:${store.id}`);
  if (hr && (hr.storeId !== store.id || hr.id !== `hr:${store.id}`)) throw new DomainError('HR_SCOPE_CORRUPT', '인사관리 매장 정보를 확인할 수 없습니다.', 503);
  const found = await repository.get<CostMonth>('oda_month', `${store.id}:${month}`);
  if (found) {
    if (found.storeId !== store.id || found.month !== month || found.id !== `${store.id}:${month}` || !found.evidenceBytes) throw new DomainError('ODA_SCOPE_CORRUPT', '월 정산 매장·원본 보관 정보를 확인할 수 없습니다.', 503);
    return { hr, oda: found };
  }
  // Match the existing ODA virtual-month baseline. No read creates a record or copies source rows.
  const oda: CostMonth = { ...createOdaMonth(store.id, month), id: `${store.id}:${month}`, version: 0, evidenceBytes: {} };
  const previous = (await repository.list<CostMonth>('oda_month', [store.id])).filter(item => item.month < month).sort((a, b) => b.month.localeCompare(a.month))[0];
  if (previous) { oda.policy = structuredClone(previous.policy); oda.policy.partialMonth = false; oda.policy.operatingDays = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate(); }
  const open = store.openDate;
  if (open && /^\d{4}-\d{2}-\d{2}$/.test(open) && open.startsWith(`${month}-`) && Number.isFinite(Date.parse(open)) && new Date(`${open}T00:00:00Z`).toISOString().slice(0, 10) === open && Number(open.slice(8)) > 1) {
    oda.policy.partialMonth = true; oda.policy.operatingDays = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate() - Number(open.slice(8)) + 1;
  }
  return { hr, oda };
}
function calculateSource(hr: HrWorkspace | undefined, month: string) {
  const runs = hr?.payroll.runs.filter(run => run.month === month) ?? [];
  const run = runs.length === 1 ? runs[0] : undefined;
  const totals = run && final(run) ? calculateHrPayrollRun(run) : null;
  const lockedRevision = run ? run.status === 'published'
    ? [...run.history].reverse().find(item => item.status === 'locked')?.revision ?? run.revision
    : run.revision : 0;
  const signature = run && totals ? digest({ month, runId: run.id, lockedRevision, gross: totals.gross, employerInsurance: totals.employerInsurance, total: totals.laborCost }) : '';
  return { run, totals, signature, lockedRevision, count: runs.length };
}
function ownedLine(oda: CostMonth): { line?: OdaLine; intact: boolean } {
  const matches = oda.lines.filter(line => line.id === lineIdFor(oda.month));
  const link = oda.hrPayrollCost; const line = matches[0];
  if (!line) return { intact: !link };
  const source = link && oda.sources.find(item => item.id === link.sourceId);
  const raw = source && oda.evidenceBytes[source.id];
  const bytes = raw ? Buffer.from(raw, 'base64') : undefined;
  const intact = matches.length === 1 && Boolean(link && source && bytes && link.lineId === line.id && line.sourceId === source.id
    && source.kind === 'expense' && line.kind === 'expense' && line.category === 'labor' && digest(line) === link.lineHash
    && bytes.length === source.sizeBytes && digest(bytes.toString('utf8')) === source.sha256);
  return { line, intact };
}
function preview(actor: Actor, storeId: string, month: string, hr: HrWorkspace | undefined, oda: CostMonth): HrPayrollCostPreview {
  const source = calculateSource(hr, month); const owned = ownedLine(oda);
  const others = oda.lines.filter(line => line.id !== lineIdFor(month) && line.kind === 'expense' && normalizeOdaCategory(line.category) === 'labor');
  const blockers: string[] = [];
  if (actor.role === 'auditor') blockers.push('감사 계정은 미리보기만 가능합니다.');
  if (!source.run || !final(source.run)) blockers.push(source.count > 1 ? '같은 귀속월 급여가 여러 건입니다. 합산 대상을 정리해 주세요.' : '해당 월 급여를 먼저 검토하고 확정·잠금해 주세요.');
  if (source.run && (!source.run.rows.length || source.totals?.net === null || source.run.rows.some(row => !row.manualConfirmed))) blockers.push('확정급여의 검토 상태를 확인할 수 없습니다.');
  if (oda.status !== 'draft') blockers.push('확정 또는 지급 완료된 월 정산은 변경할 수 없습니다.');
  if (!owned.intact || oda.lines.some(line => line.id !== lineIdFor(month) && (line.channel === 'hr-payroll' || line.externalId === lineIdFor(month)))) blockers.push('HR 인건비 행이 수정되었거나 같은 식별자가 사용 중입니다. 기존 내역을 확인해 주세요.');
  if (others.length) blockers.push('다른 인건비 내역이 있습니다. 월 정산에서 급여와 중복인지 먼저 확인해 주세요.');
  if (source.totals && (!Number.isSafeInteger(source.totals.laborCost) || source.totals.laborCost < 0 || source.totals.laborCost > 1_000_000_000_000)) blockers.push('인건비 합계가 월 정산 금액 범위를 벗어났습니다.');
  if (!owned.line && oda.lines.length >= 5000) blockers.push('월 정산의 5,000행 한도에 도달했습니다.');
  const alreadyApplied = Boolean(source.signature && oda.hrPayrollCost?.signature === source.signature && owned.intact);
  return { storeId, month, hrVersion: hr?.version ?? 0, odaVersion: oda.version, payrollRunId: source.run?.id ?? null,
    payrollRunRevision: source.run?.revision ?? null, payrollStatus: source.run?.status ?? null, odaStatus: oda.status,
    gross: source.totals?.gross ?? null, employerInsurance: source.totals?.employerInsurance ?? null, total: source.totals?.laborCost ?? null,
    currentAmount: owned.line?.kind === 'expense' && owned.line.category === 'labor' ? owned.line.amount : 0,
    otherLaborAmount: others.reduce((sum, line) => sum + line.amount, 0), otherLaborCount: others.length,
    alreadyApplied, canApply: blockers.length === 0 && !alreadyApplied, blockers };
}

/** Atomic HR→ODA bridge; all output and evidence contain only aggregate cost, never employee rows. */
export function registerOdaHrPayrollCostRoutes(app: FastifyInstance, repository: StateRepository): void {
  const path = '/api/v2/oda/:storeId/hr/payroll-cost';
  const read = async (actor: Actor, storeId: string, month: string) => repository.exclusiveTransaction(`oda:hr:${storeId}`, tx => tx.exclusiveTransaction(`oda:${storeId}:${month}`, async scoped => {
    const store = await scope(scoped, actor, storeId, false); const state = await load(scoped, store, month);
    return preview(actor, storeId, month, state.hr, state.oda);
  }));
  app.get(path, async request => {
    const { storeId } = paramsSchema.parse(request.params); const { month } = querySchema.parse(request.query);
    await scope(repository, request.actor, storeId, false); return read(request.actor, storeId, month);
  });
  app.post(path, async (request, reply) => {
    const { storeId } = paramsSchema.parse(request.params); const body = bodySchema.parse(request.body);
    await scope(repository, request.actor, storeId, true);
    // Cache only a receipt, then re-read current authorized aggregate data even on a replay.
    const receipt = await idempotentMutation(request, reply, repository, request.actor, 200, tx => tx.exclusiveTransaction(`oda:hr:${storeId}`, inner => inner.exclusiveTransaction(`oda:${storeId}:${body.month}`, async scoped => {
      const store = await scope(scoped, request.actor, storeId, true); const { hr, oda } = await load(scoped, store, body.month);
      if ((hr?.version ?? 0) !== body.expectedHrVersion || oda.version !== body.expectedOdaVersion) throw new DomainError('VERSION_CONFLICT', '인사 또는 월 정산이 변경되었습니다. 미리보기를 다시 확인해 주세요.', 409);
      const current = preview(request.actor, storeId, body.month, hr, oda); const source = calculateSource(hr, body.month);
      if (body.expectedPayrollRunId && source.run?.id !== body.expectedPayrollRunId) throw new DomainError('VERSION_CONFLICT', '급여 대상이 변경되었습니다. 미리보기를 다시 확인해 주세요.', 409);
      if (current.blockers.length) throw new DomainError('HR_PAYROLL_COST_BLOCKED', current.blockers.join(' '), 409);
      if (current.alreadyApplied) return { changed: false, month: body.month, hrVersion: hr!.version, odaVersion: oda.version };
      if (!hr || !source.run || !source.totals) throw new DomainError('HR_PAYROLL_COST_UNCONFIRMED', '확정급여를 찾을 수 없습니다.', 409);
      const now = new Date().toISOString(); const sourceId = `hr-payroll-source:${source.signature}`;
      const content = `귀속월,총지급,회사부담보험,인건비합계,급여정산ID,확정버전\r\n${body.month},${source.totals.gross},${source.totals.employerInsurance},${source.totals.laborCost},${source.run.id},${source.lockedRevision}\r\n`;
      const bytes = Buffer.from(content, 'utf8');
      if (oda.sources.some(item => item.id === sourceId) || Object.hasOwn(oda.evidenceBytes, sourceId)) throw new DomainError('HR_PAYROLL_COST_SOURCE_COLLISION', '합계 증빙 식별자가 이미 존재합니다. 원본을 보존하기 위해 반영을 중단했습니다.', 409);
      if (oda.sources.reduce((sum, item) => sum + item.sizeBytes, 0) + bytes.length > 10 * 1024 * 1024) throw new DomainError('ODA_FILE_SIZE', '월 정산 원본 보관 한도에 도달했습니다.', 422);
      const evidence: OdaSource = { id: sourceId, kind: 'expense', channel: 'hr-payroll', fileName: `HR_급여합계_${body.month}_v${source.lockedRevision}.csv`, sha256: digest(content), importedAt: now, importedBy: request.actor.id, rowCount: 1, sizeBytes: bytes.length, mimeType: 'text/csv; charset=utf-8' };
      const lastDay = new Date(Date.UTC(Number(body.month.slice(0, 4)), Number(body.month.slice(5)), 0)).getUTCDate();
      const line: OdaLine = { id: lineIdFor(body.month), date: `${body.month}-${lastDay}`, kind: 'expense', description: `${body.month} HR 확정급여 인건비`, amount: source.totals.laborCost, vat: 0,
        category: 'labor', channel: 'hr-payroll', sourceId, sourceRow: 2, externalId: lineIdFor(body.month), reviewed: true, note: '확정급여 총지급 + 회사 부담 보험료. 근로자 공제는 추가 비용에 포함하지 않음.' };
      const oldAmount = current.currentAmount; const beforeHrVersion = hr.version; const beforeOdaVersion = oda.version;
      const index = oda.lines.findIndex(item => item.id === line.id); if (index < 0) oda.lines.push(line); else oda.lines[index] = line;
      oda.sources.push(evidence); oda.evidenceBytes[sourceId] = bytes.toString('base64');
      oda.hrPayrollCost = { lineId: line.id, sourceId, signature: source.signature, lineHash: digest(line), runId: source.run.id, runRevision: source.lockedRevision, hrVersion: beforeHrVersion };
      oda.version += 1; oda.updatedAt = now;
      // A real aggregate version change makes both read preconditions database CAS guards in one commit.
      hr.version += 1; hr.updatedAt = now;
      hr.history.push({ id: randomUUID(), type: 'payroll.costApplied', actorId: request.actor.id, at: now, summary: `${body.month} 확정급여를 월 정산에 반영` });
      hr.history = hr.history.slice(-1000);
      await scoped.commit({ changes: [
        { type: 'oda_hr', id: hr.id, storeId, expectedVersion: beforeHrVersion, value: hr },
        { type: 'oda_month', id: oda.id, storeId, expectedVersion: beforeOdaVersion === 0 ? null : beforeOdaVersion, value: oda },
      ], audits: [audit(request.actor, 'oda_month', oda.id, 'ODA HR 확정급여 인건비 반영', storeId,
        { version: beforeOdaVersion, hrVersion: beforeHrVersion, amount: oldAmount }, { version: oda.version, hrVersion: hr.version, amount: line.amount }, { month: body.month, lineId: line.id, sourceId })] });
      return { changed: true, month: body.month, hrVersion: hr.version, odaVersion: oda.version };
    })));
    await scope(repository, request.actor, storeId, true);
    return { ...await read(request.actor, storeId, body.month), receipt };
  });
}
