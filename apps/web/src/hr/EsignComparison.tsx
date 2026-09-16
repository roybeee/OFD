import { useState } from 'react';
import type { NativeContractTerms } from '../../../../packages/domain/src/oda-esign';
import type { EsignContractSummary } from '../api/oda-esign-client';
import { Button } from '../components/ui';
import { hrDate } from './shared';

const labels: Record<keyof NativeContractTerms, string> = {
  employmentType: '고용 형태', payType: '급여 기준', basePay: '기본급', effectiveDate: '근로 시작일', endDate: '근로 종료일',
  jobTitle: '담당 업무', workplace: '근무 장소', workDays: '근로일', dailyWorkHours: '근로일별 시간',
  workStart: '기본 시업', workEnd: '기본 종업', breakMinutes: '기본 휴게시간', payday: '임금 지급일',
  payCalculation: '임금 구성·계산방법', payMethod: '임금 지급 방법', holidays: '휴일', annualLeave: '연차유급휴가', additionalTerms: '추가 약정',
};
export function comparisonCandidates(current: EsignContractSummary, contracts: EsignContractSummary[]): EsignContractSummary[] {
  return contracts.filter(row => row.id !== current.id && row.status === 'completed' && row.storeId === current.storeId
    && row.employeeId === current.employeeId && row.employeeActorId === current.employeeActorId
    && row.employer.id === current.employer.id && row.employer.businessNumber === current.employer.businessNumber)
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt) || b.id.localeCompare(a.id));
}
function display(key: keyof NativeContractTerms, terms: NativeContractTerms): string {
  const value = terms[key];
  if (key === 'employmentType') return { regular: '정규직', contract: '기간제', part_time: '단시간' }[terms.employmentType];
  if (key === 'payType') return terms.payType === 'monthly' ? '월급' : '시급';
  if (key === 'basePay') return `${terms.payType === 'monthly' ? '월급' : '시급'} ${terms.basePay.toLocaleString('ko-KR')}원`;
  if (key === 'breakMinutes') return `${value}분`;
  if (key === 'endDate' && !value) return '종료일 미지정';
  return String(value || '없음');
}

export function EsignComparison({ current, contracts, busy }: { current: EsignContractSummary; contracts: EsignContractSummary[]; busy: boolean }) {
  const [selectedId, setSelectedId] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const candidates = comparisonCandidates(current, contracts);
  const previous = candidates.find(row => row.id === selectedId) ?? candidates[0];
  const rows = (Object.keys(labels) as Array<keyof NativeContractTerms>).map(key => ({ key, label: labels[key],
    changed: Boolean(previous && (previous.terms[key] !== current.terms[key] || (key === 'basePay' && previous.terms.payType !== current.terms.payType))) }));
  const changes = rows.filter(row => row.changed);
  return <section className="esign-comparison" aria-label="체결 계약과 근로조건 비교"><h3>체결 계약과 근로조건 비교</h3>
    {!previous ? <p className="esign-muted">같은 직원·고용주의 비교 가능한 체결 계약이 없습니다. 아래 계약서 전체 내용을 검토해 주세요.</p> : <>
      <label className="esign-comparison-select">비교할 체결 계약<select name="compareContractId" value={previous.id} disabled={busy} onChange={event => setSelectedId(event.target.value)}>{candidates.map(row => <option key={row.id} value={row.id}>{row.title} · 시작 {row.terms.effectiveDate} · 체결 {row.completedAt ? hrDate(row.completedAt) : '일시 확인 필요'} · {row.id.slice(-8)}</option>)}</select></label>
      <p className="esign-muted">최근 체결 순으로 표시합니다. 비교 계약의 적용 시작일도 확인해 주세요. 이 표는 근로조건을 비교하며, 계약 전체 검토는 아래 원문에서 진행합니다.</p>
      {previous.terms.effectiveDate > current.terms.effectiveDate && <p className="esign-comparison-notice">비교 계약의 시작일이 현재 계약보다 나중입니다. 갱신 순서와 비교 대상을 확인해 주세요.</p>}
      {previous.terms.payType !== current.terms.payType && <p className="esign-comparison-notice">월급·시급 기준이 달라 금액만으로 인상·인하를 판단할 수 없습니다.</p>}
      <div className="esign-topline"><strong>변경 항목 {changes.length}개</strong><Button type="button" variant="secondary" aria-pressed={!onlyChanged} disabled={busy} onClick={() => setOnlyChanged(value => !value)}>{onlyChanged ? '전체 항목 보기' : '변경 항목만 보기'}</Button></div>
      {!changes.length && onlyChanged ? <p>근로조건이 동일합니다. 계약 당사자와 원문도 확인해 주세요.</p> : <div className="esign-comparison-scroll" tabIndex={0} aria-label="근로조건 비교표"><table><caption>선택한 체결 계약과 현재 {current.status === 'draft' ? '초안' : '서명 요청'}의 근로조건</caption><thead><tr><th scope="col">항목</th><th scope="col">체결 계약</th><th scope="col">현재 계약</th></tr></thead><tbody>{rows.filter(row => !onlyChanged || row.changed).map(row => <tr key={row.key} className={row.changed ? 'esign-comparison-changed' : ''}><th scope="row">{row.label}{row.changed && <small>변경</small>}</th><td>{display(row.key, previous.terms)}</td><td>{display(row.key, current.terms)}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
