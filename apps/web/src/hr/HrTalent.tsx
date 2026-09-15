import { useEffect, useState, type FormEvent } from 'react';
import type { HrCandidateStage, HrContract, HrGoal, HrMeeting, HrReviewAssignment, HrReviewCycle } from '../../../../packages/domain/src/oda-hr-talent';
import { Button } from '../components/ui';
import { HrDialog, HrEmpty, hrDate, hrError, hrToday, type HrPanelProps } from './shared';

type Tab = 'goals' | 'reviews' | 'meetings' | 'recruitment' | 'contracts';
type Props = HrPanelProps & { tab: Tab };
const labels: Record<Tab, string> = { goals: '목표', reviews: '평가', meetings: '미팅', recruitment: '채용', contracts: '계약' };
const stageNames: Record<HrCandidateStage, string> = { applied: '지원', screening: '서류 검토', interview: '인터뷰', offer: '처우 협의', hired: '합격', rejected: '불합격', withdrawn: '지원 철회' };
const stageOptions = Object.entries(stageNames) as [HrCandidateStage, string][];
const get = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const activeMembers = (props: HrPanelProps) => props.workspace.employees.filter(row => row.status === 'active');
const memberName = (props: HrPanelProps, id: string) => props.workspace.employees.find(row => row.id === id)?.name ?? '구성원';
function MemberSelect({ props, name = 'employeeId', value, onlySelf = false }: { props: HrPanelProps; name?: string; value?: string; onlySelf?: boolean }) {
  return <select name={name} required defaultValue={value ?? props.employeeId ?? ''}>
    <option value="" disabled>구성원 선택</option>
    {activeMembers(props).filter(row => !onlySelf || row.id === props.employeeId).map(row => <option key={row.id} value={row.id}>{row.name} · {row.employeeNumber}</option>)}
  </select>;
}
function FormActions({ busy, label = '저장', onClose }: { busy: boolean; label?: string; onClose: () => void }) {
  return <div className="hr-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>취소</Button><Button type="submit" disabled={busy}>{busy ? '저장 중…' : label}</Button></div>;
}

export function HrTalent(props: Props) {
  const { tab, workspace, permissions, busy, mutate } = props;
  const [dialog, setDialog] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState('');
  const [editingGoal, setEditingGoal] = useState<HrGoal | null>(null), [editingContract, setEditingContract] = useState<HrContract | null>(null);
  const [editingReview, setEditingReview] = useState<HrReviewCycle | null>(null);
  useEffect(() => { setDialog(false); setSelected(''); setError(''); setEditingGoal(null); setEditingContract(null); setEditingReview(null); }, [tab]);
  async function run(type: string, input: Record<string, unknown>, close = false): Promise<boolean> {
    setError('');
    try { await mutate(type, input); if (close) { setDialog(false); setEditingGoal(null); setEditingContract(null); setEditingReview(null); } return true; }
    catch (caught) { setError(hrError(caught)); return false; }
  }
  const canCreate = tab === 'goals' ? permissions.manage || Boolean(props.employeeId) : tab === 'meetings' ? Boolean(props.employeeId) : permissions.manage;
  function create() { setEditingGoal(null); setEditingContract(null); setEditingReview(null); setError(''); setDialog(true); }
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    if (tab === 'goals') {
      const input = { title: get(f, 'title'), description: get(f, 'description'), employeeId: get(f, 'employeeId'), dueDate: get(f, 'dueDate'), visibility: get(f, 'visibility') };
      await run(editingGoal ? 'goal.update' : 'goal.create', { ...input, ...(editingGoal ? { id: editingGoal.id } : {}) }, true);
    } else if (tab === 'reviews') {
      await run(editingReview ? 'review.update' : 'review.create', { ...(editingReview ? { id: editingReview.id } : {}), title: get(f, 'title'), startDate: get(f, 'startDate'), dueDate: get(f, 'dueDate'),
        employeeIds: f.getAll('employeeIds').map(String), reviewerEmployeeId: get(f, 'reviewerEmployeeId'), questions: get(f, 'questions').split('\n').map(row => row.trim()).filter(Boolean) }, true);
    } else if (tab === 'meetings') {
      await run('meeting.create', { title: get(f, 'title'), scheduledDate: get(f, 'scheduledDate'), participantEmployeeIds: [...new Set([...(props.employeeId ? [props.employeeId] : []), ...f.getAll('participantEmployeeIds').map(String)])] }, true);
    } else if (tab === 'recruitment') {
      await run('recruitment.createJob', { title: get(f, 'title'), description: get(f, 'description') }, true);
    } else {
      const pay = get(f, 'basePay');
      await run(editingContract ? 'contract.update' : 'contract.create', {
        ...(editingContract ? { id: editingContract.id } : {}), employeeId: get(f, 'employeeId'), title: get(f, 'title'), body: get(f, 'body'),
        employmentType: get(f, 'employmentType'), jobTitle: get(f, 'jobTitle'), effectiveDate: get(f, 'effectiveDate'), endDate: get(f, 'endDate'),
        payType: get(f, 'payType') || 'monthly', basePay: pay ? Number(pay) : null,
      }, true);
    }
  };
  const selectedMeeting = workspace.talent.meetings.find(row => row.id === selected);
  const selectedReview = workspace.talent.reviews.find(row => row.id === selected);
  return <section aria-label={labels[tab]}>
    <div className="hr-section-heading"><div><h2>{labels[tab]}</h2><p className="hr-muted">{tab === 'goals' ? '담당자와 기한을 정하고 목표의 진행률을 기록하세요.' : tab === 'reviews' ? '평가 준비, 답변 제출, 마감과 결과 공개를 관리하세요.' : tab === 'meetings' ? '참여자와 공동 노트를 작성하고 다음 할 일을 확인하세요.' : tab === 'recruitment' ? '공고별 지원자와 전형 진행 상황을 관리하세요.' : '계약 초안과 외부 체결 기록을 관리하고 인사정보에 반영하세요.'}</p></div>
      {canCreate && <Button onClick={create} disabled={busy}>{tab === 'reviews' ? '평가 준비하기' : tab === 'contracts' ? '계약 초안 작성' : `${labels[tab]} 추가`}</Button>}
    </div>
    {error && <p className="hr-error" role="alert">{error}</p>}
    {tab === 'goals' && <>
      {!workspace.talent.goals.length && <HrEmpty title="등록된 목표가 없습니다.">담당자, 기한, 공개 범위를 정해 첫 목표를 작성하세요.</HrEmpty>}
      <div className="hr-grid">{workspace.talent.goals.map(goal => {
        const editable = permissions.manage || props.employeeId === goal.employeeId;
        return <article key={goal.id} className="hr-card"><header className="hr-section-heading"><h3>{goal.title}</h3><span className="hr-badge">{goal.status === 'completed' ? '완료' : '진행 중'}</span></header>
          <p className="hr-muted">{memberName(props, goal.employeeId)} · {hrDate(goal.dueDate)} · {goal.visibility === 'private' ? '담당자·관리자 공개' : '회사 공개'}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{goal.description}</p><progress value={goal.progress} max={100} aria-label={`${goal.title} 진행률`} /><strong> {goal.progress}%</strong>
          {editable && <><form className="hr-toolbar" onSubmit={event => { event.preventDefault(); void run('goal.update', { id: goal.id, progress: Number(new FormData(event.currentTarget).get('progress')) }); }}>
            <label>진행률 <input name="progress" type="number" min="0" max="100" step="0.1" defaultValue={goal.progress} key={goal.progress} disabled={busy || goal.status === 'completed'} required /></label>
            <Button type="submit" variant="secondary" disabled={busy || goal.status === 'completed'}>진척 저장</Button></form>
            <div className="hr-actions"><Button variant="secondary" disabled={busy || goal.status === 'completed'} onClick={() => { setEditingGoal(goal); setDialog(true); }}>수정</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void run(goal.status === 'completed' ? 'goal.reopen' : 'goal.complete', { id: goal.id })}>{goal.status === 'completed' ? '다시 열기' : '완료 처리'}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`“${goal.title}” 목표를 삭제할까요? 복구할 수 없습니다.`)) void run('goal.delete', { id: goal.id }); }}>삭제</Button></div></>}
        </article>;
      })}</div>
    </>}
    {tab === 'reviews' && <>
      {!workspace.talent.reviews.length && <HrEmpty title="진행 중인 평가가 없습니다.">관리자가 평가 대상과 문항을 준비하면 작성할 수 있습니다.</HrEmpty>}
      <div className="hr-list">{workspace.talent.reviews.map(cycle => <article key={cycle.id} className="hr-card"><div className="hr-section-heading"><div><h3>{cycle.title}</h3><p>{hrDate(cycle.startDate)} ~ {hrDate(cycle.dueDate)} · {cycle.status === 'draft' ? '준비 중' : cycle.status === 'open' ? '진행 중' : '마감'}</p></div><Button variant="secondary" onClick={() => setSelected(selected === cycle.id ? '' : cycle.id)}>평가 보기</Button></div>
        <p className="hr-muted">제출 {cycle.assignments.filter(row => row.status === 'submitted').length} / {cycle.assignments.length}</p>
        {permissions.manage && <div className="hr-actions">{cycle.status === 'draft' && <><Button disabled={busy} onClick={() => void run('review.open', { id: cycle.id })}>평가 시작</Button><Button variant="secondary" disabled={busy} onClick={() => { setEditingReview(cycle); setDialog(true); }}>평가 준비 수정</Button><Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('준비 중인 평가를 삭제할까요?')) void run('review.delete', { id: cycle.id }); }}>준비 평가 삭제</Button></>}{cycle.status === 'open' && <Button disabled={busy || !cycle.assignments.every(row => row.status === 'submitted')} onClick={() => void run('review.close', { id: cycle.id })}>전체 제출 확인 · 마감</Button>}</div>}
      </article>)}</div>
      {selectedReview && <ReviewDetail key={selectedReview.id} props={props} cycle={selectedReview} run={run} />}
    </>}
    {tab === 'meetings' && <>
      {!workspace.talent.meetings.length && <HrEmpty title="참여 중인 미팅이 없습니다.">미팅을 만든 후 공동 노트와 개인 메모를 작성하세요.</HrEmpty>}
      <div className="hr-list">{workspace.talent.meetings.map(meeting => <article key={meeting.id} className="hr-card"><div className="hr-section-heading"><div><h3>{meeting.title}</h3><p>{meeting.scheduledDate ? hrDate(meeting.scheduledDate) : '일정 없음'} · {meeting.participantEmployeeIds.map(id => memberName(props, id)).join(', ')}</p></div><Button variant="secondary" onClick={() => setSelected(selected === meeting.id ? '' : meeting.id)}>노트 열기</Button></div></article>)}</div>
      {selectedMeeting && <MeetingDetail key={selectedMeeting.id} props={props} meeting={selectedMeeting} run={run} onDeleted={() => setSelected('')} />}
    </>}
    {tab === 'recruitment' && (permissions.manage ? <Recruitment props={props} run={run} /> : <HrEmpty title="채용 관리 권한이 필요합니다." />)}
    {tab === 'contracts' && <>
      <p className="hr-muted">체결 완료는 외부에서 완료한 계약의 근거를 등록하는 기록입니다. 인사정보 반영은 별도로 실행합니다.</p>
      {!workspace.talent.contracts.length && <HrEmpty title="등록된 계약이 없습니다.">구성원의 계약 초안을 작성해 보세요.</HrEmpty>}
      <div className="hr-list">{workspace.talent.contracts.map(contract => <article key={contract.id} className="hr-card"><header className="hr-section-heading"><h3>{contract.title}</h3><span className="hr-badge">{contract.status === 'draft' ? '초안' : contract.status === 'completed' ? '체결 완료 기록' : '취소'}</span></header>
        <p>{memberName(props, contract.employeeId)} · 적용일 {hrDate(contract.terms.effectiveDate)}{contract.terms.endDate && ` · 종료일 ${hrDate(contract.terms.endDate)}`}</p>
        <details><summary>계약 내용과 인사 반영값</summary><p style={{ whiteSpace: 'pre-wrap' }}>{contract.body}</p><p>직무: {contract.terms.jobTitle || '미지정'} · 고용 형태: {{ regular: '정규직', contract: '계약직', part_time: '단시간' }[contract.terms.employmentType]}</p>
          {contract.terms.basePay !== null && <p>{contract.terms.payType === 'monthly' ? '월급' : '시급'} {contract.terms.basePay.toLocaleString('ko-KR')}원</p>}</details>
        {contract.completionReference && <p>외부 체결 근거: {contract.completionReference}</p>}
        {contract.appliedAt && <p className="hr-badge">{hrDate(contract.appliedAt)} 인사정보 반영 완료</p>}
        {permissions.manage && contract.status === 'draft' && <><div className="hr-actions"><Button variant="secondary" disabled={busy} onClick={() => { setEditingContract(contract); setDialog(true); }}>초안 수정</Button><Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('이 계약 초안을 취소할까요?')) void run('contract.cancel', { id: contract.id }); }}>초안 취소</Button></div>
          <form className="hr-form" onSubmit={event => { event.preventDefault(); void run('contract.complete', { id: contract.id, completionReference: get(new FormData(event.currentTarget), 'completionReference') }); }}>
            <label>외부 체결 근거<input name="completionReference" maxLength={2000} placeholder="체결 일자와 문서 보관 위치, 확인 내용" required /></label><Button type="submit" disabled={busy}>체결 완료 기록</Button></form></>}
        {permissions.manage && contract.status === 'completed' && !contract.appliedAt && <Button disabled={busy || (contract.terms.basePay !== null && !permissions.payroll) || contract.terms.effectiveDate > hrToday()} onClick={() => { if (window.confirm(`${memberName(props, contract.employeeId)}의 현재 인사정보에 계약 조건을 반영할까요? 한 번만 반영할 수 있습니다.`)) void run('contract.applyPersonnel', { id: contract.id }); }}>계약 조건을 인사정보에 반영</Button>}
        {contract.status === 'completed' && !contract.appliedAt && contract.terms.effectiveDate > hrToday() && <p className="hr-muted">적용일 이후에 인사정보를 반영할 수 있습니다.</p>}
      </article>)}</div>
    </>}
    {dialog && <HrDialog title={editingGoal ? '목표 수정' : editingContract ? '계약 초안 수정' : editingReview ? '평가 준비 수정' : `${labels[tab]} 작성`} busy={busy} onClose={() => setDialog(false)}>
      {error && <p className="hr-error" role="alert">{error}</p>}
      <form className="hr-form" onSubmit={event => void onSubmit(event)}>
        <label>제목<input name="title" maxLength={100} required defaultValue={editingGoal?.title ?? editingContract?.title ?? editingReview?.title ?? ''} /></label>
        {tab === 'goals' && <><label>담당자{editingGoal ? <><input type="hidden" name="employeeId" value={editingGoal.employeeId} /><span>{memberName(props, editingGoal.employeeId)}</span></> : <MemberSelect props={props} onlySelf={!permissions.manage} />}</label>
          <label>목표 설명<textarea name="description" rows={4} maxLength={10000} defaultValue={editingGoal?.description} /></label>
          <label>기한<input type="date" name="dueDate" required defaultValue={editingGoal?.dueDate ?? hrToday()} /></label>
          <label>공개 범위<select name="visibility" defaultValue={editingGoal?.visibility ?? 'company'}><option value="company">회사 전체</option><option value="private">담당자·관리자</option></select></label></>}
        {tab === 'reviews' && <><div className="hr-form-grid"><label>시작일<input name="startDate" type="date" required defaultValue={editingReview?.startDate ?? hrToday()} /></label><label>마감일<input name="dueDate" type="date" required defaultValue={editingReview?.dueDate ?? hrToday()} /></label></div>
          <fieldset><legend>평가 대상</legend>{activeMembers(props).map(row => <label key={row.id}><input type="checkbox" name="employeeIds" value={row.id} defaultChecked={editingReview?.assignments.some(assignment => assignment.employeeId === row.id) ?? false} /> {row.name}</label>)}</fieldset>
          <label>평가 작성자<select name="reviewerEmployeeId" defaultValue={editingReview?.assignments.every(assignment => assignment.employeeId === assignment.reviewerEmployeeId) ? '' : editingReview?.assignments[0]?.reviewerEmployeeId ?? ''}><option value="">각 대상자의 셀프 평가</option>{activeMembers(props).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>평가 문항 · 한 줄에 하나<textarea name="questions" rows={5} required defaultValue={editingReview?.questions.join('\n') ?? '목표 달성\n협업과 소통\n성장과 개선'} maxLength={6000} /></label><p className="hr-muted">각 문항은 1~5점과 의견으로 답합니다. 준비한 뒤 평가 시작 버튼을 누르세요.</p></>}
        {tab === 'meetings' && <><label>일정<input name="scheduledDate" type="date" /></label><fieldset><legend>참여자 · 본인은 자동 포함</legend>{activeMembers(props).filter(row => row.id !== props.employeeId).map(row => <label key={row.id}><input type="checkbox" name="participantEmployeeIds" value={row.id} /> {row.name}</label>)}</fieldset></>}
        {tab === 'recruitment' && <label>공고 설명<textarea name="description" rows={6} maxLength={10000} /></label>}
        {tab === 'contracts' && <>
          <label>계약 대상{editingContract ? <><input type="hidden" name="employeeId" value={editingContract.employeeId} /><span>{memberName(props, editingContract.employeeId)}</span></> : <MemberSelect props={props} />}</label>
          <label>계약 본문<textarea name="body" rows={7} required maxLength={50000} defaultValue={editingContract?.body} /></label>
          <div className="hr-form-grid"><label>고용 형태<select name="employmentType" defaultValue={editingContract?.terms.employmentType ?? 'regular'}><option value="regular">정규직</option><option value="contract">계약직</option><option value="part_time">단시간</option></select></label><label>직무<input name="jobTitle" maxLength={100} defaultValue={editingContract?.terms.jobTitle} /></label>
            <label>적용일<input type="date" name="effectiveDate" required defaultValue={editingContract?.terms.effectiveDate ?? hrToday()} /></label><label>종료일 · 선택<input type="date" name="endDate" defaultValue={editingContract?.terms.endDate} /></label></div>
          {permissions.payroll && <div className="hr-form-grid"><label>급여 형태<select name="payType" defaultValue={editingContract?.terms.payType ?? 'monthly'}><option value="monthly">월급</option><option value="hourly">시급</option></select></label><label>기본 급여 · 변경 시 입력<input type="number" name="basePay" min="0" max="1000000000" step="1" defaultValue={editingContract?.terms.basePay ?? ''} /></label></div>}
          <p className="hr-muted">급여를 비워 두면 현재 급여는 유지합니다. 완료 기록 후에도 인사정보 반영 전에는 구성원 정보가 바뀌지 않습니다.</p>
        </>}
        <FormActions busy={busy} onClose={() => setDialog(false)} label={editingGoal || editingContract || editingReview ? '변경 저장' : '작성 완료'} />
      </form>
    </HrDialog>}
  </section>;
}

type Run = (type: string, input: Record<string, unknown>, close?: boolean) => Promise<boolean>;
function ReviewDetail({ props, cycle, run }: { props: Props; cycle: HrReviewCycle; run: Run }) {
  return <section className="hr-card" aria-label={`${cycle.title} 상세`}><h3>{cycle.title} · 평가와 결과</h3>
    {cycle.assignments.map(assignment => <ReviewAssignment key={assignment.id} props={props} cycle={cycle} assignment={assignment} run={run} />)}
    {cycle.reports.map(report => <article key={report.employeeId} className="hr-card"><h4>{memberName(props, report.employeeId)} 평가 결과</h4><p>평균 {report.averageScore} / 5 · 평가 {report.responseCount}건 · {report.sharedAt ? '구성원 공개 중' : '비공개'}</p><p style={{ whiteSpace: 'pre-wrap' }}>{report.summary}</p>
      {props.permissions.manage && <Button variant="secondary" disabled={props.busy} onClick={() => void run(report.sharedAt ? 'review.revoke' : 'review.publish', { id: cycle.id, employeeId: report.employeeId })}>{report.sharedAt ? '공개 회수' : '대상자에게 공개'}</Button>}</article>)}
  </section>;
}
function ReviewAssignment({ props, cycle, assignment, run }: { props: Props; cycle: HrReviewCycle; assignment: HrReviewAssignment; run: Run }) {
  const editable = assignment.reviewerEmployeeId === props.employeeId && cycle.status === 'open' && hrToday() >= cycle.startDate && hrToday() <= cycle.dueDate;
  const locked = !editable || assignment.status === 'submitted' || props.busy;
  return <article className="hr-card"><h4>{memberName(props, assignment.employeeId)} · 작성자 {memberName(props, assignment.reviewerEmployeeId)}</h4><p className="hr-muted">{assignment.status === 'submitted' ? '제출 완료 · 답변 잠금' : '작성 중'}</p>
    <form className="hr-form" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); void run('review.answer', { id: cycle.id, assignmentId: assignment.id, answers: cycle.questions.map((question, index) => ({ question, score: Number(get(f, `score-${index}`)), comment: get(f, `comment-${index}`) })) }); }}>
      {cycle.questions.map((question, index) => { const answer = assignment.answers.find(row => row.question === question); return <fieldset key={question}><legend>{question}</legend><label>점수<select name={`score-${index}`} required disabled={locked} defaultValue={answer?.score ?? ''}><option value="" disabled>점수 선택</option>{[1, 2, 3, 4, 5].map(score => <option value={score} key={score}>{score}점</option>)}</select></label><label>의견<textarea name={`comment-${index}`} rows={3} maxLength={5000} defaultValue={answer?.comment ?? ''} disabled={locked} /></label></fieldset>; })}
      {editable && <div className="hr-actions">{assignment.status === 'draft' ? <><Button type="submit" disabled={props.busy}>답변 저장</Button><Button type="button" disabled={props.busy || assignment.answers.length !== cycle.questions.length} onClick={() => void run('review.submit', { id: cycle.id, assignmentId: assignment.id })}>저장한 답변 제출</Button></> : <Button type="button" variant="secondary" disabled={props.busy} onClick={() => void run('review.withdraw', { id: cycle.id, assignmentId: assignment.id })}>제출 회수 · 수정</Button>}</div>}
    </form>
  </article>;
}
function MeetingDetail({ props, meeting, run, onDeleted }: { props: Props; meeting: HrMeeting; run: Run; onDeleted: () => void }) {
  return <section className="hr-card" aria-label={`${meeting.title} 노트`}><h3>{meeting.title}</h3>
    <form className="hr-form" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); void run('meeting.update', { id: meeting.id, title: get(f, 'title'), notes: get(f, 'notes'), scheduledDate: get(f, 'scheduledDate') }); }}>
      <label>미팅 제목<input name="title" required maxLength={100} defaultValue={meeting.title} /></label><label>일정<input name="scheduledDate" type="date" defaultValue={meeting.scheduledDate} /></label>
      <label>공동 노트<textarea name="notes" rows={8} maxLength={50000} defaultValue={meeting.notes} /></label><Button type="submit" disabled={props.busy}>공동 노트 저장</Button>
    </form>
    <form className="hr-form" onSubmit={event => { event.preventDefault(); void run('meeting.privateNote', { id: meeting.id, note: get(new FormData(event.currentTarget), 'note') }); }}>
      <label>나만 보는 메모<textarea name="note" rows={5} maxLength={50000} defaultValue={meeting.privateNotes[props.actorId] ?? ''} /></label><p className="hr-muted">다른 참여자와 관리자에게 공유되지 않습니다.</p><Button type="submit" variant="secondary" disabled={props.busy}>개인 메모 저장</Button>
    </form>
    <h4>다음 할 일</h4>{!meeting.tasks.length && <p className="hr-muted">등록된 할 일이 없습니다.</p>}
    <ul className="hr-list">{meeting.tasks.map(task => <li key={task.id}><label><input type="checkbox" checked={task.completed} disabled={props.busy} onChange={event => void run('meeting.toggleTask', { id: meeting.id, taskId: task.id, completed: event.target.checked })} /> {task.title} · {memberName(props, task.assigneeEmployeeId)}</label></li>)}</ul>
    <form className="hr-form" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, f = new FormData(form); void run('meeting.addTask', { id: meeting.id, title: get(f, 'title'), assigneeEmployeeId: get(f, 'assigneeEmployeeId') }).then(ok => { if (ok) form.reset(); }); }}>
      <label>할 일<input name="title" required maxLength={300} /></label><label>담당자<select name="assigneeEmployeeId" required defaultValue={props.employeeId}>{meeting.participantEmployeeIds.map(id => <option value={id} key={id}>{memberName(props, id)}</option>)}</select></label><Button type="submit" variant="secondary" disabled={props.busy}>할 일 추가</Button>
    </form>
    {meeting.hostActorId === props.actorId && <Button variant="ghost" disabled={props.busy} onClick={() => { if (window.confirm('미팅과 모든 노트를 삭제할까요? 복구할 수 없습니다.')) void run('meeting.delete', { id: meeting.id }).then(ok => { if (ok) onDeleted(); }); }}>미팅 삭제</Button>}
  </section>;
}
function Recruitment({ props, run }: { props: Props; run: Run }) {
  const { jobs, candidates } = props.workspace.talent;
  return <>{!jobs.length && <HrEmpty title="등록된 공고가 없습니다.">공고를 작성하고 모집 중으로 전환한 뒤 지원자를 등록하세요.</HrEmpty>}
    {jobs.map(job => <article key={job.id} className="hr-card"><header className="hr-section-heading"><h3>{job.title}</h3><span className="hr-badge">{job.status === 'draft' ? '초안' : job.status === 'open' ? '모집 중' : '마감'}</span></header><p style={{ whiteSpace: 'pre-wrap' }}>{job.description}</p>
      <details><summary>공고 수정</summary><form className="hr-form" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); void run('recruitment.updateJob', { id: job.id, title: get(f, 'title'), description: get(f, 'description') }); }}><label>제목<input name="title" required maxLength={100} defaultValue={job.title} /></label><label>설명<textarea name="description" maxLength={10000} defaultValue={job.description} /></label><Button type="submit" variant="secondary" disabled={props.busy}>수정 저장</Button></form></details>
      <div className="hr-actions"><Button variant="secondary" disabled={props.busy} onClick={() => void run('recruitment.updateJob', { id: job.id, status: job.status === 'open' ? 'closed' : 'open' })}>{job.status === 'open' ? '공고 마감' : '모집 시작'}</Button><Button variant="ghost" disabled={props.busy || candidates.some(row => row.jobId === job.id)} onClick={() => { if (window.confirm('이 공고를 삭제할까요?')) void run('recruitment.deleteJob', { id: job.id }); }}>공고 삭제</Button></div>
      <div className="hr-table-wrap"><table className="hr-table"><caption>{job.title} 지원자</caption><thead><tr><th>지원자</th><th>전형</th><th>단계 변경</th></tr></thead><tbody>{candidates.filter(row => row.jobId === job.id).map(candidate => {
        const terminal = ['hired', 'rejected', 'withdrawn'].includes(candidate.stage);
        return <tr key={candidate.id}><td>{candidate.name}<small className="hr-muted"> {candidate.email}</small><details><summary>기록 {candidate.history.length}건</summary><p>{candidate.note}</p><ul>{candidate.history.map((event, index) => <li key={index}>{hrDate(event.at)} · {event.from ? `${stageNames[event.from]} → ` : ''}{stageNames[event.to]}</li>)}</ul></details></td><td>{stageNames[candidate.stage]}</td><td>{terminal ? <Button variant="secondary" disabled={props.busy || job.status !== 'open'} onClick={() => void run('recruitment.reopenCandidate', { id: candidate.id })}>전형 다시 열기</Button> : <form className="hr-toolbar" onSubmit={event => { event.preventDefault(); void run('recruitment.moveCandidate', { id: candidate.id, stage: get(new FormData(event.currentTarget), 'stage') }); }}><select name="stage" aria-label={`${candidate.name} 이동할 전형`} defaultValue="" required disabled={props.busy || job.status !== 'open'} key={candidate.stage}><option value="" disabled>이동할 단계</option>{stageOptions.filter(([value]) => value !== candidate.stage).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Button type="submit" variant="secondary" disabled={props.busy || job.status !== 'open'}>이동</Button></form>}</td></tr>;
      })}{!candidates.some(row => row.jobId === job.id) && <tr><td colSpan={3}>아직 지원자가 없습니다.</td></tr>}</tbody></table></div>
      {job.status === 'open' && <details><summary>지원자 직접 등록</summary><form className="hr-form" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, f = new FormData(form); void run('recruitment.addCandidate', { jobId: job.id, name: get(f, 'name'), email: get(f, 'email'), note: get(f, 'note') }).then(ok => { if (ok) form.reset(); }); }}>
        <label>이름<input name="name" required maxLength={100} /></label><label>이메일 · 선택<input name="email" type="email" maxLength={254} /></label><label>지원 기록<textarea name="note" rows={3} maxLength={10000} /></label><Button type="submit" disabled={props.busy}>지원자 등록</Button></form></details>}
    </article>)}
  </>;
}
