import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AggregateChange, StateRepository } from '@ofd/db';
import { DomainError, odaLineExternalKey, type Actor, type OdaLine, type OdaMonth, type Store } from '@ofd/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from './events.ts';
import { loadOdaMonthForAutomation } from './oda-routes.ts';

declare module 'fastify' {
  interface FastifyContextConfig { odaMachineIntegration?: boolean }
}
// Only explicitly registered machine endpoints may skip browser-session checks.
// Each handler still verifies its restricted integration token independently.
export const odaIntegrationRouteOptions = { config: { odaMachineIntegration: true } } as const;

export interface IntegrationToken {
  id: string; version: number; secretHash: string; issuerId: string; issuerAuthVersion: number;
  name: string; storeIds: string[]; kinds: Array<'revenue' | 'expense'>; routines: boolean;
  createdAt: string; expiresAt: string; revokedAt?: string;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const safeId = z.string().trim().min(1).max(120);
const money = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, '실제 존재하는 날짜가 필요합니다.');
const lineSchema = z.object({
  externalRef: z.string().transform(value => value.normalize('NFKC').trim()).pipe(safeId), date, kind: z.enum(['revenue', 'expense']),
  channel: z.enum(['pos', 'baemin', 'coupang', 'yogiyo', 'ddangyo', 'manual']),
  category: z.enum(['sales', 'ingredients', 'labor', 'rent', 'utilities', 'fees', 'marketing', 'supplies', 'other']),
  description: z.string().trim().min(1).max(500), amountKrw: money, vatKrw: money.nullable(),
}).strict().refine(line => line.kind === 'revenue' ? line.category === 'sales' && line.channel !== 'manual' : line.category !== 'sales', '매출 채널과 비용 분류를 확인해 주세요.')
  .refine(line => line.vatKrw === null || Math.abs(line.vatKrw) <= Math.abs(line.amountKrw) && (line.vatKrw === 0 || Math.sign(line.amountKrw) === Math.sign(line.vatKrw)), '부가세는 금액 이내이며 같은 부호여야 합니다.');
export const odaAutomationBatchSchema = z.object({
  batchId: z.uuid(), storeId: safeId, month: z.string().regex(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/),
  source: z.object({ system: safeId, accountRef: safeId, url: z.url().max(2000).refine(value => {
    const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
  }, '인증정보·쿼리가 없는 HTTPS 원본 페이지 주소를 사용하세요.'), capturedAt: z.iso.datetime() }).strict(),
  lines: z.array(lineSchema).min(1).max(200),
}).strict().refine(body => body.lines.every(line => line.date.startsWith(`${body.month}-`)), '모든 행은 지정 정산월에 속해야 합니다.')
  .refine(body => new Set(body.lines.map(line => `${line.kind}:${line.channel}:${line.externalRef}`)).size === body.lines.length, '요청에 같은 외부 거래가 중복되어 있습니다.');
type BatchInput = z.infer<typeof odaAutomationBatchSchema>;
type ImportedLine = BatchInput['lines'][number];
export interface AutomationBatch {
  id: string; version: number; tokenId: string; input: BatchInput; digest: string;
  status: 'awaiting_approval' | 'approved' | 'committed' | 'rejected'; createdAt: string; expiresAt: string;
  approvedBy?: string; approvedAuthVersion?: number; approvedAt?: string;
  result?: { added: number; duplicates: number; monthVersion: number; committedAt: string };
}
type MonthRecord = OdaMonth & { evidenceBytes: Record<string, string> };
type RefRecord = { id: string; version: number; fingerprint: string; lineId: string; month: string; batchId: string };
function allowed(actor: Actor, storeId: string, admin = false) {
  return actor.active && (admin ? ['hq_master', 'store_owner'] : ['hq_master', 'store_owner', 'hq_finance']).includes(actor.role)
    && (actor.storeIds.includes(storeId) || actor.role !== 'store_owner' && actor.storeIds.length === 0);
}
export async function requireOdaAutomationStore(repository: StateRepository, actor: Actor, storeId: string, admin = false) {
  if (!allowed(actor, storeId, admin)) throw new DomainError('ODA_FORBIDDEN', '이 매장의 자동화 권한이 없습니다.', 403);
  if (!(await repository.get<Store>('store', storeId))?.active) throw new DomainError('ODA_STORE_NOT_FOUND', '운영 중인 매장이 아닙니다.', 404);
}
function publicToken(token: IntegrationToken) { const { secretHash: _secret, ...safe } = token; return safe; }
export async function validateOdaIntegrationToken(repository: StateRepository, id: string) {
  const token = await repository.get<IntegrationToken>('oda_automation_token', id);
  if (!token || token.revokedAt || token.expiresAt <= new Date().toISOString()) throw new DomainError('ODA_TOKEN_REVOKED', '연결 암호가 만료되었거나 폐기되었습니다.', 401);
  const actor = await repository.get<Actor>('actor', token.issuerId);
  if (!actor || !actor.active || actor.authVersion !== token.issuerAuthVersion || token.storeIds.some(storeId => !allowed(actor, storeId, true))) {
    throw new DomainError('ODA_TOKEN_REVOKED', '연결을 발급한 계정의 권한이 변경되었습니다.', 401);
  }
  return { token, actor };
}
export async function requireOdaIntegration(request: FastifyRequest, repository: StateRepository) {
  if (request.headers.origin) throw new DomainError('ODA_SERVER_ONLY', '연결 암호는 서버에서만 사용합니다.', 403);
  const match = /^Bearer oda_int_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
  if (!match) throw new DomainError('ODA_INTEGRATION_AUTH', '유효한 ODA 연결 암호가 필요합니다.', 401);
  const resolved = await validateOdaIntegrationToken(repository, match[1]!);
  const expected = Buffer.from(resolved.token.secretHash, 'hex');
  const received = Buffer.from(sha(match[2]!), 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new DomainError('ODA_INTEGRATION_AUTH', '유효한 ODA 연결 암호가 필요합니다.', 401);
  return resolved;
}
function requireBatchScope(token: IntegrationToken, input: BatchInput) {
  if (!token.storeIds.includes(input.storeId) || input.lines.some(line => !token.kinds.includes(line.kind))) throw new DomainError('ODA_TOKEN_SCOPE', '연결 암호의 매장·업무 범위를 벗어났습니다.', 403);
}
const fingerprint = (line: ImportedLine) => sha(JSON.stringify([line.date, line.kind, line.channel, line.category, line.description, line.amountKrw, line.vatKrw]));
const lineFingerprint = (line: OdaLine) => sha(JSON.stringify([line.date, line.kind, line.channel, line.category, line.description, line.amount, line.vat]));
// Store + channel + kind + external reference remain stable across renewed tokens, batches and months.
const refId = (storeId: string, line: ImportedLine) => sha(JSON.stringify([storeId, line.channel, line.kind, line.externalRef]));
async function inspect(repository: StateRepository, input: BatchInput) {
  const months = await repository.list<MonthRecord>('oda_month', [input.storeId]);
  const record = months.find(item => item.month === input.month);
  if (record && record.status !== 'draft') throw new DomainError('ODA_MONTH_LOCKED', '확정·지급된 정산월에는 자동 반영할 수 없습니다.', 409);
  const known = new Map<string, OdaLine[]>();
  for (const month of months) for (const saved of month.lines) {
    const line = saved.kind === 'excluded' && saved.originalKind ? { ...saved, kind: saved.originalKind, category: saved.originalCategory ?? saved.category } : saved;
    const key = odaLineExternalKey(line);
    if (key) known.set(key, [...(known.get(key) ?? []), line]);
  }
  const entries: Array<{ line: ImportedLine; id: string; status: 'new' | 'duplicate' | 'conflict'; existing?: RefRecord }> = [];
  for (const line of input.lines) {
    const id = refId(input.storeId, line);
    const existing = await repository.get<RefRecord>('oda_automation_ref', id);
    const manual = known.get(odaLineExternalKey({ externalId: line.externalRef, channel: line.channel, kind: line.kind })!);
    const prior = [...(existing ? [existing.fingerprint] : []), ...(manual ?? []).map(lineFingerprint)];
    entries.push({ line, id, status: prior.length ? prior.every(value => value === fingerprint(line)) ? 'duplicate' : 'conflict' : 'new', ...(existing ? { existing } : {}) });
  }
  return { record, entries, added: entries.filter(entry => entry.status === 'new').length,
    duplicates: entries.filter(entry => entry.status === 'duplicate').length, conflicts: entries.filter(entry => entry.status === 'conflict').map(entry => entry.line.externalRef) };
}
async function batchDto(repository: StateRepository, batch: AutomationBatch) {
  if (batch.status === 'committed') return { ...batch, preview: null };
  const inspection = await inspect(repository, batch.input);
  return { ...batch, preview: { added: inspection.added, duplicates: inspection.duplicates, conflicts: inspection.conflicts,
    revenueKrw: inspection.entries.filter(entry => entry.status === 'new' && entry.line.kind === 'revenue').reduce((sum, entry) => sum + entry.line.amountKrw, 0),
    expenseKrw: inspection.entries.filter(entry => entry.status === 'new' && entry.line.kind === 'expense').reduce((sum, entry) => sum + entry.line.amountKrw, 0),
    rows: inspection.entries.map(({ line, status }) => ({ ...line, status })) } };
}
async function loadBatch(repository: StateRepository, id: string) {
  const batch = await repository.get<AutomationBatch>('oda_automation_batch', id);
  if (!batch) throw new DomainError('ODA_BATCH_NOT_FOUND', '수집 결과를 찾을 수 없습니다.', 404);
  return batch;
}
async function commitBatch(repository: StateRepository, id: string, digest: string, tokenId?: string) {
  const initial = await loadBatch(repository, id);
  return repository.exclusiveTransaction(`oda:${initial.input.storeId}:${initial.input.month}`, async scoped => {
    const batch = await loadBatch(scoped, id);
    const { token } = await validateOdaIntegrationToken(scoped, batch.tokenId);
    if (tokenId && tokenId !== token.id) throw new DomainError('ODA_BATCH_NOT_FOUND', '수집 결과를 찾을 수 없습니다.', 404);
    requireBatchScope(token, batch.input);
    if (digest !== batch.digest) throw new DomainError('ODA_BATCH_CHANGED', '승인하려는 내용과 수집 결과가 다릅니다.', 409);
    if (batch.status === 'committed') return batch;
    if (batch.status !== 'approved' || !batch.approvedBy) throw new DomainError('ODA_APPROVAL_REQUIRED', 'ODA에서 원본과 금액을 확인하고 승인해 주세요.', 409);
    if (batch.expiresAt <= new Date().toISOString()) throw new DomainError('ODA_BATCH_EXPIRED', '승인 유효기간이 지났습니다. 새 결과를 수집해 주세요.', 409);
    const actor = await scoped.get<Actor>('actor', batch.approvedBy);
    if (!actor || actor.authVersion !== batch.approvedAuthVersion) throw new DomainError('ODA_APPROVAL_REVOKED', '승인 계정의 권한이 변경되었습니다.', 403);
    await requireOdaAutomationStore(scoped, actor, batch.input.storeId);
    const inspection = await inspect(scoped, batch.input);
    if (inspection.conflicts.length) throw new DomainError('ODA_EXTERNAL_CONFLICT', '동일한 거래번호의 금액·날짜·분류가 기존 자료와 다릅니다. 원본을 확인해 주세요.', 409, { externalRefs: inspection.conflicts });
    const now = new Date().toISOString();
    const record: MonthRecord = inspection.record ?? await loadOdaMonthForAutomation(scoped, batch.input.storeId, batch.input.month);
    const sourceId = `automation:${batch.id}`;
    const content = Buffer.from(JSON.stringify({ source: batch.input.source, batchId: batch.id, digest: batch.digest, lines: batch.input.lines }, null, 2));
    const newRows = inspection.entries.filter(entry => entry.status === 'new');
    const changes: AggregateChange[] = [];
    if (newRows.length) {
      if (record.lines.length + newRows.length > 5000) throw new DomainError('ODA_LINE_LIMIT', '월 정산의 최대 행 수를 초과합니다.', 422);
      if (Object.values(record.evidenceBytes).reduce((sum, bytes) => sum + Buffer.byteLength(bytes, 'base64'), 0) + content.length > 10 * 1024 * 1024) throw new DomainError('ODA_EVIDENCE_LIMIT', '정산월 증빙 보관 한도를 초과합니다.', 422);
      record.evidenceBytes[sourceId] = content.toString('base64');
      record.sources.push({ id: sourceId, fileName: `automation-${batch.id}.json`, sha256: sha(content.toString()), kind: 'evidence', channel: '', importedAt: now,
        importedBy: actor.id, rowCount: newRows.length, sizeBytes: content.length, mimeType: 'application/json' });
      for (const entry of newRows) {
        const lineId = `auto:${entry.id}`;
        record.lines.push({ id: lineId, date: entry.line.date, kind: entry.line.kind, description: entry.line.description, amount: entry.line.amountKrw, vat: entry.line.vatKrw,
          category: entry.line.category, channel: entry.line.channel, sourceId, sourceRow: batch.input.lines.indexOf(entry.line) + 1, externalId: entry.line.externalRef,
          reviewed: false, note: `자동 수집 · ${batch.input.source.system} · ${batch.input.source.accountRef} · ${batch.input.source.url}` });
        changes.push({ type: 'oda_automation_ref', id: entry.id, storeId: batch.input.storeId, expectedVersion: null,
          value: { id: entry.id, version: 1, fingerprint: fingerprint(entry.line), lineId, month: batch.input.month, batchId: batch.id } satisfies RefRecord });
      }
      const beforeVersion = record.version;
      record.version++; record.updatedAt = now;
      changes.push({ type: 'oda_month', id: record.id, storeId: record.storeId, expectedVersion: beforeVersion === 0 ? null : beforeVersion, value: record });
    }
    const completed: AutomationBatch = { ...batch, version: batch.version + 1, status: 'committed', result: { added: newRows.length, duplicates: inspection.duplicates, monthVersion: record.version, committedAt: now } };
    changes.push({ type: 'oda_automation_batch', id: batch.id, storeId: batch.input.storeId, expectedVersion: batch.version, value: completed },
      // A concurrent token revoke must conflict with this fence and roll back the entire posting.
      { type: 'oda_automation_token', id: token.id, storeId: token.storeIds[0]!, expectedVersion: token.version, value: { ...token, version: token.version + 1 } });
    await scoped.commit({ changes, audits: [audit(actor, 'oda_month', record.id, '자동 수집 매출·비용 반영', record.storeId, undefined,
      { batchId: batch.id, digest: batch.digest, ...completed.result }, { source: batch.input.source, tokenId: token.id })] });
    return completed;
  });
}

export async function previewOdaBatch(repository: StateRepository, token: IntegrationToken, raw: unknown) {
  const input = odaAutomationBatchSchema.parse(raw);
  const current = await validateOdaIntegrationToken(repository, token.id);
  requireBatchScope(current.token, input); await requireOdaAutomationStore(repository, current.actor, input.storeId);
    return repository.exclusiveTransaction(`oda-batch:${input.batchId}`, async scoped => {
      const digest = sha(JSON.stringify(input)); const existing = await scoped.get<AutomationBatch>('oda_automation_batch', input.batchId);
      if (existing) {
        if (existing.tokenId !== token.id || existing.digest !== digest) throw new DomainError('ODA_IDEMPOTENCY_CONFLICT', '같은 수집 ID에 다른 내용을 보낼 수 없습니다.', 409);
        return batchDto(scoped, existing);
      }
      await inspect(scoped, input);
      const batch: AutomationBatch = { id: input.batchId, version: 1, tokenId: token.id, input, digest, status: 'awaiting_approval',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
      await scoped.commit({ changes: [{ type: 'oda_automation_batch', id: batch.id, storeId: input.storeId, expectedVersion: null, value: batch }] });
      return batchDto(scoped, batch);
    });
}

export function registerOdaAutomation(app: FastifyInstance, repository: StateRepository) {
  const ui = '/api/v2/oda/automation'; const machine = '/api/v2/oda/integration';
  app.get(`${ui}/tokens`, async request => {
    const { storeId } = z.object({ storeId: safeId }).parse(request.query);
    await requireOdaAutomationStore(repository, request.actor, storeId, true);
    return { tokens: (await repository.list<IntegrationToken>('oda_automation_token')).filter(token => token.storeIds.includes(storeId) && token.storeIds.every(id => allowed(request.actor, id, true))).map(publicToken) };
  });
  app.post(`${ui}/tokens`, async request => {
    const input = z.object({ name: z.string().trim().min(1).max(80), storeIds: z.array(safeId).min(1).max(50), kinds: z.array(z.enum(['revenue', 'expense'])).max(2),
      routines: z.boolean().default(false), expiresInDays: z.number().int().min(1).max(90).default(30) }).strict().parse(request.body);
    if (!input.kinds.length && !input.routines) throw new DomainError('ODA_TOKEN_SCOPE', '연결할 업무를 선택해 주세요.', 422);
    for (const id of input.storeIds) await requireOdaAutomationStore(repository, request.actor, id, true);
    const secret = randomBytes(32).toString('base64url'); const id = randomUUID(); const now = new Date();
    const token: IntegrationToken = { id, version: 1, secretHash: sha(secret), issuerId: request.actor.id, issuerAuthVersion: request.actor.authVersion,
      name: input.name, storeIds: [...new Set(input.storeIds)], kinds: [...new Set(input.kinds)], routines: input.routines,
      createdAt: now.toISOString(), expiresAt: new Date(now.valueOf() + input.expiresInDays * 86400_000).toISOString() };
    await repository.commit({ changes: [{ type: 'oda_automation_token', id, storeId: token.storeIds[0]!, expectedVersion: null, value: token }],
      audits: [audit(request.actor, 'oda_automation_token', id, '자동화 연결 발급', token.storeIds[0], undefined, publicToken(token))] });
    return { token: `oda_int_${id}.${secret}`, connection: publicToken(token) };
  });
  app.post(`${ui}/tokens/:id/revoke`, async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return repository.exclusiveTransaction(`oda-token:${id}`, async scoped => {
      const token = await scoped.get<IntegrationToken>('oda_automation_token', id);
      if (!token) throw new DomainError('ODA_TOKEN_NOT_FOUND', '연결을 찾을 수 없습니다.', 404);
      for (const storeId of token.storeIds) await requireOdaAutomationStore(scoped, request.actor, storeId, true);
      if (!token.revokedAt) await scoped.commit({ changes: [{ type: 'oda_automation_token', id, storeId: token.storeIds[0]!, expectedVersion: token.version,
        value: { ...token, version: token.version + 1, revokedAt: new Date().toISOString() } }], audits: [audit(request.actor, 'oda_automation_token', id, '자동화 연결 폐기', token.storeIds[0], undefined, { revoked: true })] });
      return { revoked: true };
    });
  });
  app.get(`${machine}/capabilities`, odaIntegrationRouteOptions, async request => {
    const { token } = await requireOdaIntegration(request, repository);
    const stores = await Promise.all(token.storeIds.map(async id => { const store = await repository.get<Store>('store', id); return store?.active ? { id, name: store.name } : null; }));
    return { version: 1, storeIds: token.storeIds, stores: stores.filter(Boolean), kinds: token.kinds, routines: token.routines, batchPreview: true, approvedCommit: true, currency: 'KRW', maxLines: 200, expiresAt: token.expiresAt };
  });
  app.get(`${machine}/batches`, odaIntegrationRouteOptions, async request => {
    const { token } = await requireOdaIntegration(request, repository);
    const { storeId, month } = z.object({ storeId: safeId, month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
    if (!token.storeIds.includes(storeId)) throw new DomainError('ODA_TOKEN_SCOPE', '이 매장의 권한이 없습니다.', 403);
    return { batches: (await repository.list<AutomationBatch>('oda_automation_batch', [storeId])).filter(batch => batch.tokenId === token.id && batch.input.month === month).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) };
  });
  app.post(`${machine}/batches/preview`, odaIntegrationRouteOptions, async request => {
    const { token } = await requireOdaIntegration(request, repository);
    return previewOdaBatch(repository, token, request.body);
  });
  app.get(`${machine}/batches/:id`, odaIntegrationRouteOptions, async request => {
    const { token } = await requireOdaIntegration(request, repository); const batch = await loadBatch(repository, z.object({ id: z.uuid() }).parse(request.params).id);
    if (batch.tokenId !== token.id) throw new DomainError('ODA_BATCH_NOT_FOUND', '수집 결과를 찾을 수 없습니다.', 404);
    requireBatchScope(token, batch.input); return batchDto(repository, batch);
  });
  app.post(`${machine}/batches/:id/commit`, odaIntegrationRouteOptions, async request => {
    const { token } = await requireOdaIntegration(request, repository); const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { digest } = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    return commitBatch(repository, id, digest, token.id);
  });
  app.get(`${ui}/batches`, async request => {
    const { storeId, month } = z.object({ storeId: safeId, month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
    await requireOdaAutomationStore(repository, request.actor, storeId);
    return { batches: (await repository.list<AutomationBatch>('oda_automation_batch', [storeId])).filter(batch => batch.input.month === month).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) };
  });
  app.get(`${ui}/batches/:id`, async request => {
    const batch = await loadBatch(repository, z.object({ id: z.uuid() }).parse(request.params).id);
    await requireOdaAutomationStore(repository, request.actor, batch.input.storeId); return batchDto(repository, batch);
  });
  app.post(`${ui}/batches/:id/approve`, async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { digest, commit } = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), commit: z.boolean().default(false) }).strict().parse(request.body);
    const approved = await repository.exclusiveTransaction(`oda-batch:${id}`, async scoped => {
      const batch = await loadBatch(scoped, id); await requireOdaAutomationStore(scoped, request.actor, batch.input.storeId);
      await validateOdaIntegrationToken(scoped, batch.tokenId);
      if (digest !== batch.digest) throw new DomainError('ODA_BATCH_CHANGED', '미리보기와 승인 내용이 다릅니다.', 409);
      if (batch.status === 'committed' || batch.status === 'approved') return batch;
      if (batch.status === 'rejected' || batch.expiresAt <= new Date().toISOString()) throw new DomainError('ODA_BATCH_EXPIRED', '승인할 수 없는 수집 결과입니다.', 409);
      const inspection = await inspect(scoped, batch.input);
      if (inspection.conflicts.length) throw new DomainError('ODA_EXTERNAL_CONFLICT', '기존 자료와 다른 거래가 있습니다. 원본을 확인해 주세요.', 409, { externalRefs: inspection.conflicts });
      const next: AutomationBatch = { ...batch, version: batch.version + 1, status: 'approved', approvedBy: request.actor.id, approvedAuthVersion: request.actor.authVersion,
        approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      await scoped.commit({ changes: [{ type: 'oda_automation_batch', id, storeId: batch.input.storeId, expectedVersion: batch.version, value: next }],
        audits: [audit(request.actor, 'oda_automation_batch', id, '자동 수집 반영 승인', batch.input.storeId, undefined, { digest, lineCount: batch.input.lines.length })] });
      return next;
    });
    return commit ? commitBatch(repository, id, digest) : approved;
  });
  app.post(`${ui}/batches/:id/reject`, async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return repository.exclusiveTransaction(`oda-batch:${id}`, async scoped => {
      const batch = await loadBatch(scoped, id); await requireOdaAutomationStore(scoped, request.actor, batch.input.storeId);
      if (batch.status === 'committed') throw new DomainError('ODA_BATCH_COMMITTED', '이미 반영되었습니다. 정산 화면에서 원본과 수정 사유를 확인해 주세요.', 409);
      if (batch.status !== 'rejected') await scoped.commit({ changes: [{ type: 'oda_automation_batch', id, storeId: batch.input.storeId, expectedVersion: batch.version, value: { ...batch, status: 'rejected', version: batch.version + 1 } }],
        audits: [audit(request.actor, 'oda_automation_batch', id, '자동 수집 반영 거절', batch.input.storeId, undefined, { digest: batch.digest })] });
      return { rejected: true };
    });
  });
}
