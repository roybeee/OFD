import type { EsignContractSummary } from '../api/oda-esign-client';
import { esignTiming, matchesEsignTask, type EsignTask } from './esign-followup';

export type EsignStatusFilter = 'all' | EsignContractSummary['status'];
export const esignStatusLabels = { draft: '작성 중', pending: '서명 진행 중', completed: '체결 완료', declined: '서명 거절', cancelled: '요청 취소' };
export interface EsignRegisterFilter { employerId: string; search: string; status: EsignStatusFilter; task: EsignTask }
export function filterEsignRegister(contracts: EsignContractSummary[], filter: EsignRegisterFilter, actorId: string, now: number) {
  const query = filter.search.trim().normalize('NFC').toLocaleLowerCase('ko-KR');
  return contracts.filter(row => (filter.employerId === 'all' || row.employer.id === filter.employerId)
    && (filter.status === 'all' || row.status === filter.status)
    && `${row.title} ${row.employeeName} ${row.employer.legalName} ${row.employer.businessNumber}`.normalize('NFC').toLocaleLowerCase('ko-KR').includes(query)
    && matchesEsignTask(row, filter.task, actorId, now));
}
function cell(value: string | number): string {
  const raw = String(value);
  // Quoting alone does not stop spreadsheet formula execution.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(raw) || /^[\t\r\n]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
function timestamp(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
export function esignRegisterCsv(contracts: EsignContractSummary[], now: number): string {
  const header = ['조회 시각(KST)', '계약 ID', '버전', '고용주', '사업자등록번호', '직원', '직원 ID', '계약명', '상태', '근로 시작일', '기록된 종료일', '급여 기준', '기본급(원)', '사용자 서명(KST)', '근로자 서명(KST)', '서명 마감(KST)', '체결 완료(KST)', '사본 교부 기록', '인사 반영(KST)'];
  const rows = contracts.map(c => [timestamp(new Date(now).toISOString()), c.id, c.version, c.employer.legalName,
    c.employer.businessNumber.replace(/^(\d{3})(\d{2})(\d{5})$/, '$1-$2-$3'), c.employeeName, c.employeeId, c.title,
    esignTiming(c, now).expired ? '서명 기한 경과' : esignStatusLabels[c.status], c.terms.effectiveDate, c.terms.endDate,
    c.terms.payType === 'monthly' ? '월급' : '시급', c.terms.basePay,
    timestamp(c.signatures.find(row => row.role === 'employer')?.at), timestamp(c.signatures.find(row => row.role === 'employee')?.at),
    timestamp(c.expiresAt), timestamp(c.completedAt), c.status === 'completed' ? (c.deliveries.some(row => row.method === 'manual_handover') ? '담당자 교부 기록 있음' : '교부 확인 대기') : '체결 전', timestamp(c.appliedAt)]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function saveEsignRegister(contracts: EsignContractSummary[], now: number): void {
  const href = URL.createObjectURL(new Blob([esignRegisterCsv(contracts, now)], { type: 'text/csv;charset=utf-8' }));
  const revoke = URL.revokeObjectURL.bind(URL);
  const anchor = document.createElement('a'); anchor.href = href;
  anchor.download = `ODA_계약관리대장_${new Date(now + 9 * 3600000).toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => revoke(href), 1000);
}
