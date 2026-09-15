import type { HrPermissions, HrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { ApiError, mutateV2, newIdempotencyKey } from './client';

export type HrResponse = { workspace: HrWorkspace; permissions: HrPermissions; employeeId?: string; accounts?: Array<{ id: string; name: string; role: string }> };
const base = (storeId: string) => `/oda/${encodeURIComponent(storeId)}/hr`;

export async function getOdaHr(storeId: string, signal?: AbortSignal): Promise<HrResponse> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${base(storeId)}`, {
    credentials: 'same-origin', headers: { Accept: 'application/json' }, signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'HR_LOAD_FAILED',
      payload.error?.message || payload.message || '인사 정보를 불러오지 못했습니다. 다시 불러와 주세요.');
  }
  return response.json();
}

export function commandOdaHr(storeId: string, expectedVersion: number, type: string, input: Record<string, unknown>): Promise<HrResponse> {
  return mutateV2<HrResponse>(`${base(storeId)}/commands`, { expectedVersion, type, input }, { idempotencyKey: newIdempotencyKey() });
}

/** Deliberately contains aggregate amounts only; no employee names or individual payroll rows. */
export interface HrPayrollCostPreview {
  storeId: string; month: string; hrVersion: number; odaVersion: number;
  payrollRunId: string | null; payrollRunRevision: number | null; payrollStatus: 'draft' | 'reviewed' | 'locked' | 'published' | null;
  odaStatus: 'draft' | 'finalized' | 'paid'; gross: number | null; employerInsurance: number | null; total: number | null;
  currentAmount: number; otherLaborAmount: number; otherLaborCount: number; alreadyApplied: boolean;
  canApply: boolean; blockers: string[];
  receipt?: { changed: boolean; month: string; hrVersion: number; odaVersion: number };
}
export async function getOdaHrPayrollCost(storeId: string, month: string, signal?: AbortSignal): Promise<HrPayrollCostPreview> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${base(storeId)}/payroll-cost?month=${encodeURIComponent(month)}`, {
    credentials: 'same-origin', headers: { Accept: 'application/json' }, signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'HR_PAYROLL_COST_LOAD_FAILED', payload.error?.message || '월 정산 인건비 미리보기를 불러오지 못했습니다.');
  }
  return response.json();
}
export function applyOdaHrPayrollCost(storeId: string, preview: Pick<HrPayrollCostPreview, 'month' | 'hrVersion' | 'odaVersion' | 'payrollRunId'>): Promise<HrPayrollCostPreview> {
  return mutateV2<HrPayrollCostPreview>(`${base(storeId)}/payroll-cost`, {
    month: preview.month, expectedHrVersion: preview.hrVersion, expectedOdaVersion: preview.odaVersion,
    ...(preview.payrollRunId ? { expectedPayrollRunId: preview.payrollRunId } : {}),
  }, { idempotencyKey: newIdempotencyKey() });
}
