import { ApiError, mutateV2, newIdempotencyKey } from './client';
import type { OdaCsvResult, OdaLine, OdaMonth, OdaPolicy, OdaSource, OdaSourceKind, OdaSummary } from '../../../../packages/domain/src/oda-settlement';
export type { OdaLine, OdaMonth, OdaPolicy, OdaSource, OdaSummary, OdaSourceKind };

export type OdaResponse = {
  data: OdaMonth;
  summary: OdaSummary;
  version: number;
  evidence: OdaSource[];
  history: OdaMonth['history'];
  capabilities: { edit: boolean; confirmParty: 'A' | 'B' | null; finalize: boolean; pay: boolean; reopen: boolean };
  importResult?: { added: number; duplicates: number };
  expenseRules?: OdaExpenseRules;
  audit?: Array<{ id: string; action: string; actorId: string; at: string; metadata: { lineChanges?: Array<{ before: OdaLine | null; after: OdaLine }>; [key: string]: unknown } }>;
  payment?: { date: string; amount: number; reference: string } | null;
};
export type OdaImport = { filename: string; kind: OdaSourceKind; content?: string; contentBase64?: string; mediaType?: string; channel?: string; sheetName?: string; headerRow?: number; columnMap?: Record<string, string>; expectedExpenseRulesVersion?: number };
export type OdaPreview = OdaCsvResult & { expenseRulesVersion?: number; workbook?: { sheetNames: string[]; sheetName: string; headers: string[] } };
export type OdaExpenseRules = { version: number; rules: Array<{ id: string; description: string; category: string; updatedAt: string }> };
const rulesBase = (storeId: string) => `/oda/${encodeURIComponent(storeId)}/expense-rules`;
export async function getOdaExpenseRules(storeId: string, signal?: AbortSignal): Promise<OdaExpenseRules> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${rulesBase(storeId)}`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'ODA_RULES_FAILED', '기억한 비용 분류를 불러오지 못했습니다. 다시 불러와 주세요.');
  return response.json();
}
export function removeOdaExpenseRule(storeId: string, ruleId: string, expectedVersion: number) {
  return mutateV2<OdaExpenseRules>(`${rulesBase(storeId)}/${encodeURIComponent(ruleId)}/remove`, { expectedVersion }, { idempotencyKey: newIdempotencyKey() });
}
export type OdaImportProfile = { headerRow: number; sheetName: string; headers: string[]; columnMap: Record<string, string> };
export type OdaImportProfileResponse = { version: number; profile: OdaImportProfile | null };
const profileBase = (storeId: string) => `/oda/${encodeURIComponent(storeId)}/import-profile`;
export async function getOdaImportProfile(storeId: string, kind: OdaSourceKind, channel: string, signal?: AbortSignal): Promise<OdaImportProfileResponse> {
  const query = new URLSearchParams({ kind, channel });
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${profileBase(storeId)}?${query}`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'ODA_PROFILE_FAILED', '저장한 엑셀 설정을 불러오지 못했습니다. 기본 설정으로 파일을 확인하거나 다시 불러와 주세요.');
  return response.json();
}
export function resetOdaImportProfile(storeId: string, kind: OdaSourceKind, channel: string, expectedVersion: number) {
  return mutateV2<OdaImportProfileResponse>(`${profileBase(storeId)}/reset`, { kind, channel, expectedVersion }, { idempotencyKey: newIdempotencyKey() });
}
const base = (storeId: string, month: string) => `/oda/${encodeURIComponent(storeId)}/${encodeURIComponent(month)}`;
export const odaUrl = (storeId: string, month: string, suffix: string) => `${import.meta.env.VITE_API_BASE ?? '/api/v2'}${base(storeId, month)}${suffix}`;

export async function getOdaMonth(storeId: string, month: string, signal?: AbortSignal): Promise<OdaResponse> {
  const response = await fetch(odaUrl(storeId, month, ''), { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'ODA_REQUEST_FAILED', payload.error?.message || payload.message || '월 정산 정보를 불러오지 못했습니다.');
  }
  return response.json();
}

export function odaMutation(storeId: string, month: string, suffix: string, expectedVersion: number, body: Record<string, unknown> = {}) {
  return mutateV2<OdaResponse>(`${base(storeId, month)}${suffix}`, { ...body, expectedVersion }, { idempotencyKey: newIdempotencyKey() });
}

export function previewOdaImport(storeId: string, month: string, input: OdaImport) {
  return mutateV2<OdaPreview>(`${base(storeId, month)}/import/preview`, { ...input, useExpenseRules: true }, { idempotencyKey: newIdempotencyKey() });
}

export type OdaRecurringPreview = { month: string; previousMonth: string; previousVersion: number | null; targetVersion: number;
  status: 'available' | 'missing' | 'unfinalized'; rows: Array<{ lineId: string; description: string; category: string; amount: number;
    vat: number | null; previousDate: string; status: 'available' | 'similar' | 'already_added'; matchCount: number;
    matches: Array<{ lineId: string; date: string; description: string; amount: number }> }> };
export type OdaRecurringSelection = { expectedVersion: number; previousVersion: number; lineIds: string[]; confirmedSimilarLineIds: string[] };
export async function getOdaRecurringPreview(storeId: string, month: string, signal?: AbortSignal): Promise<OdaRecurringPreview> {
  const response = await fetch(odaUrl(storeId, month, '/repeat-previous/preview'), { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'ODA_RECURRING_FAILED', payload.error?.message || '지난달 비용을 불러오지 못했습니다.');
  }
  return response.json();
}

export async function prepareOdaFile(file: File, kind: OdaSourceKind, channel: string): Promise<OdaImport> {
  if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name}: 파일당 2MB 이하로 올려 주세요.`);
  const isCsv = /\.(csv|tsv)$/i.test(file.name);
  if (!isCsv && !/\.(xlsx|pdf|png|jpe?g)$/i.test(file.name)) throw new Error(`${file.name}: XLSX, CSV, TSV, PDF, JPG, PNG 파일을 지원합니다.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  const mediaType = isCsv ? /\.tsv$/i.test(file.name) ? 'text/tab-separated-values' : 'text/csv' : /\.xlsx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
  return { filename: file.name, kind: isCsv || /\.xlsx$/i.test(file.name) ? kind === 'evidence' ? 'expense' : kind : 'evidence', contentBase64: btoa(binary), mediaType, channel };
}

export function downloadOdaText(filename: string, contents: string, mediaType = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', contents], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type OdaOverviewRow = { storeId: string; storeName: string; month: string; amountBasis: string; updatedAt: string | null;
  status: 'not_started' | 'draft' | 'ready' | 'finalized' | 'paid' | 'error'; revenue: number | null;
  expenses: number | null; profit: number | null; payableB: number | null; sourceCount: number;
  reviewCount: number; blockerCount: number; overdue: boolean; dueDate: string | null; nextAction: string; tab: string; anchor: string };
export type OdaOverview = { month: string; page: number; pageSize: number; total: number; rows: OdaOverviewRow[] };
export async function getOdaOverview(month: string, page = 1, signal?: AbortSignal): Promise<OdaOverview> {
  const query = new URLSearchParams({ month, page: String(page) });
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}/oda/overview?${query}`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'ODA_OVERVIEW_FAILED', payload.error?.message || '정산 현황을 불러오지 못했습니다.');
  }
  return response.json();
}
