import { useState } from 'react';
import type { NativeContractTemplate, NativeEmployer } from '../../../../packages/domain/src/oda-esign';
import type { HrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { Button } from '../components/ui';

export function EsignBatchForm({ template, employer, workspace, accounts, busy, onSubmit }: {
  template: NativeContractTemplate; employer?: NativeEmployer; workspace: HrWorkspace;
  accounts: Array<{ id: string }>; busy: boolean; onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [title, setTitle] = useState(`${template.name} 근로계약서`.slice(0, 200));
  const [search, setSearch] = useState('');
  // Consent covers the personnel, employer and template snapshots reviewed together.
  const [review, setReview] = useState<{ hr: number; employer: number; template: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const employees = workspace.employees.filter(row => row.status !== 'retired');
  const eligible = employees.filter(row => row.actorId && row.actorId !== employer?.signerActorId && accounts.some(account => account.id === row.actorId));
  const visible = eligible.filter(row => `${row.name} ${row.employeeNumber}`.includes(search.trim()));
  const recipients = eligible.filter(row => selected.includes(row.id));
  const reviewing = review !== null;
  const reviewChanged = Boolean(review && (review.hr !== workspace.version || review.employer !== employer?.version || review.template !== template.version));
  const valid = Boolean(employer?.active && template.active && recipients.length && recipients.length <= 50 && recipients.length === selected.length
    && new Set(recipients.map(row => row.actorId)).size === recipients.length && start && (!end || end >= start) && (template.terms.employmentType !== 'contract' || end) && title.trim());
  const terms = template.terms;
  return <form className="hr-form esign-form esign-batch-form" onSubmit={event => {
    event.preventDefault(); if (!valid || busy) return;
    if (!reviewing || reviewChanged) { if (employer) setReview({ hr: workspace.version, employer: employer.version, template: template.version }); setConfirmed(false); return; }
    if (!confirmed || !employer) return;
    void onSubmit({ expectedVersion: 0, savedTemplateId: template.id, savedTemplateVersion: review.template, expectedEmployerVersion: review.employer,
      expectedHrVersion: review.hr, title: title.trim(), effectiveDate: start, endDate: end, employeeIds: selected });
  }}><h2>{reviewing ? '대상자와 공통 조건 최종 확인' : '여러 직원 계약 초안 만들기'}</h2>
    <p>{employer?.legalName} · {employer?.businessNumber} / {template.name}</p>
    <p className="esign-muted">선택한 직원 모두에게 아래 양식 조건을 적용합니다. 직원별로 다른 조건은 저장 후 각 초안에서 수정할 수 있습니다. 서명 요청은 초안 검토 후 별도로 진행합니다.</p>
    {!reviewing && <><fieldset><legend>1. 계약 제목과 공통 기간</legend><label>계약 제목<input name="batchTitle" required maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label><div className="hr-form-grid"><label>근로 시작일<input name="batchStart" type="date" required value={start} disabled={busy} onChange={event => setStart(event.target.value)} /></label><label>근로 종료일{terms.employmentType !== 'contract' && ' · 선택'}<input name="batchEnd" type="date" required={terms.employmentType === 'contract'} min={start || undefined} value={end} disabled={busy} onChange={event => setEnd(event.target.value)} /></label></div></fieldset>
      <fieldset><legend>2. 대상 직원 · {selected.length}/50명</legend><label>직원 검색<input type="search" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} placeholder="이름·직원번호" /></label><div className="esign-actions"><Button type="button" variant="secondary" disabled={busy || !visible.length || new Set([...selected, ...visible.map(row => row.id)]).size > 50} onClick={() => setSelected(previous => [...new Set([...previous, ...visible.map(row => row.id)])])}>검색 결과 모두 선택</Button><Button type="button" variant="ghost" disabled={busy || !selected.length} onClick={() => setSelected([])}>선택 해제</Button></div>
        <div className="esign-batch-employees">{visible.map(employee => <label className="esign-consent" key={employee.id}><input type="checkbox" checked={selected.includes(employee.id)} disabled={busy || (!selected.includes(employee.id) && selected.length >= 50)} onChange={event => setSelected(previous => event.target.checked ? [...previous, employee.id] : previous.filter(id => id !== employee.id))} /><span>{employee.name} · {employee.employeeNumber}</span></label>)}</div>
        {!visible.length && <p>선택 가능한 직원이 없습니다.</p>}<p className="esign-muted">매장 접근이 가능한 계정이 연결된 직원만 표시됩니다. 고용주 서명 담당자는 제외합니다. {employees.length - eligible.length}명 제외</p></fieldset></>}
    <section className="esign-delivery"><h3>모든 대상자에게 적용할 양식 조건</h3><dl className="esign-summary">{Object.entries({ '고용 형태': terms.employmentType === 'regular' ? '정규직' : terms.employmentType === 'contract' ? '기간제' : '단시간', '임금': `${terms.payType === 'monthly' ? '월급' : '시급'} ${terms.basePay.toLocaleString('ko-KR')}원`, '업무': terms.jobTitle, '근무 장소': terms.workplace, '근로일': terms.workDays, '근로일별 시간': terms.dailyWorkHours, '시업·종업 / 휴게': `${terms.workStart}~${terms.workEnd} / ${terms.breakMinutes}분`, '임금 계산': terms.payCalculation, '지급일·방법': `${terms.payday} / ${terms.payMethod}`, '휴일': terms.holidays, '연차': terms.annualLeave, '추가 약정': terms.additionalTerms || '없음' }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="esign-template-value">{value}</dd></div>)}</dl></section>
    {reviewing && <><h3>{title} · {recipients.length}명</h3><p>적용 기간 {start} ~ {end || '종료일 없음'}</p><div className="esign-batch-review">{recipients.map(employee => <div className="esign-delivery" key={employee.id}><strong>{employee.name} · {employee.employeeNumber}</strong><p>현재 인사정보: {employee.payType === 'monthly' ? '월급' : '시급'} {employee.basePay.toLocaleString('ko-KR')}원</p><p>새 계약 초안: {terms.payType === 'monthly' ? '월급' : '시급'} {terms.basePay.toLocaleString('ko-KR')}원</p></div>)}</div>
      {reviewChanged && <p role="alert">직원·고용주 또는 양식 정보가 갱신되었습니다. 대상자 선택으로 돌아가 다시 확인해 주세요.</p>}
      <label className="esign-consent"><input type="checkbox" checked={confirmed && !reviewChanged} disabled={busy || reviewChanged} onChange={event => setConfirmed(event.target.checked)} /><span>대상자별 임금과 공통 조건을 확인했으며, 추가 약정에 다른 직원의 개인정보가 없는지 검토했습니다.</span></label></>}
    <div className="esign-actions">{reviewing && <Button type="button" variant="secondary" disabled={busy} onClick={() => { setReview(null); setConfirmed(false); }}>대상자 선택으로</Button>}<Button type="submit" disabled={busy || !valid || (reviewing && (!confirmed || reviewChanged))}>{busy ? '저장 중…' : reviewing ? `${recipients.length}명 초안 저장` : '선택한 직원과 조건 검토'}</Button></div>
  </form>;
}
