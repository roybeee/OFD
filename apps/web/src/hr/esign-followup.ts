import type { EsignContractSummary } from '../api/oda-esign-client';

export type EsignTask = 'all' | 'mine' | 'expired' | 'ending' | 'ended' | 'delivery' | 'apply';
export const esignTaskLabels: Record<EsignTask, string> = {
  all: '전체 계약', mine: '내 서명 대기', expired: '서명 기한 경과', ending: '30일 내 종료 예정',
  ended: '종료일 경과', delivery: '교부 확인 대기', apply: '인사 반영 확인',
};
export function esignTiming(contract: EsignContractSummary, now: number) {
  const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const end = contract.terms.endDate;
  const daysLeft = end ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
  return { today, daysLeft, expired: contract.status === 'pending' && Date.parse(contract.expiresAt) <= now };
}
export function matchesEsignTask(contract: EsignContractSummary, task: EsignTask, actorId: string, now: number): boolean {
  const { today, daysLeft, expired } = esignTiming(contract, now);
  switch (task) {
    case 'all': return true;
    case 'mine': return contract.status === 'pending' && !expired && Date.parse(contract.expiresAt) > now
      && [contract.employeeActorId, contract.employer.signerActorId].includes(actorId)
      && !contract.signatures.some(signature => signature.actorId === actorId);
    case 'expired': return expired;
    case 'ending': return contract.status === 'completed' && daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
    case 'ended': return contract.status === 'completed' && daysLeft !== null && daysLeft < 0;
    case 'delivery': return contract.status === 'completed' && !contract.deliveries.some(row => row.method === 'manual_handover');
    case 'apply': return contract.status === 'completed' && !contract.appliedAt && contract.terms.effectiveDate <= today;
  }
}
