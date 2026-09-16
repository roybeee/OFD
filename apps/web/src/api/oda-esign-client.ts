import type { NativeContract as EsignContract, NativeEmployer as EsignEmployer } from '../../../../packages/domain/src/oda-esign';
import { ApiError, mutateV2, newIdempotencyKey } from './client';

export type EsignContractSummary = Omit<EsignContract, 'documentText' | 'signatures' | 'audit'> & { signatures: Array<Pick<EsignContract['signatures'][number], 'role' | 'actorId' | 'name' | 'at'>> };
export interface EsignOverview {
  storeId: string;
  employers: EsignEmployer[];
  contracts: EsignContractSummary[];
  permissions: { manage: boolean; sign: boolean };
  currentActorId: string;
  accounts?: Array<{ id: string; name: string; role: string }>;
}
export type EsignMutation = EsignOverview & { contract?: EsignContract; employer?: EsignEmployer };
const path = (storeId: string) => `/oda/${encodeURIComponent(storeId)}/esign`;
const url = (storeId: string, suffix = '') => `${import.meta.env.VITE_API_BASE ?? '/api/v2'}${path(storeId)}${suffix}`;
async function read<T>(storeId: string, suffix: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url(storeId, suffix), { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'ESIGN_LOAD_FAILED', payload.error?.message || '전자계약을 불러오지 못했습니다. 다시 시도해 주세요.');
  }
  return response.json();
}
export const getOdaEsign = (storeId: string, signal?: AbortSignal) => read<EsignOverview>(storeId, '', signal);
export const getOdaEsignContract = (storeId: string, id: string, signal?: AbortSignal) => read<{ contract: EsignContract }>(storeId, `/contracts/${encodeURIComponent(id)}`, signal);
export function mutateOdaEsign(storeId: string, suffix: string, input: Record<string, unknown>, idempotencyKey = newIdempotencyKey()): Promise<EsignMutation> {
  return mutateV2<EsignMutation>(`${path(storeId)}${suffix}`, input, { idempotencyKey });
}
export async function downloadOdaEsign(storeId: string, id: string, kind: 'pdf' | 'evidence'): Promise<void> {
  const response = await fetch(url(storeId, `/contracts/${encodeURIComponent(id)}/${kind}`), { credentials: 'same-origin', headers: { Accept: kind === 'pdf' ? 'application/pdf' : '*/*' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.code || 'ESIGN_DOWNLOAD_FAILED', payload.error?.message || '문서를 다운로드하지 못했습니다.');
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const json = response.headers.get('content-type')?.includes('json');
  anchor.href = href; anchor.download = `ODA_${kind === 'pdf' ? '근로계약서' : '계약진행기록'}_${id}.${json ? 'json' : 'pdf'}`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
