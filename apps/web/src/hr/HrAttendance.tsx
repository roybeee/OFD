import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { HrDialog, hrError, hrToday, type HrPanelProps } from './shared';
import { Button } from '../components/ui';
import { getHrLeaveBalance, isHrAttendanceLocked, type HrAttendanceState, type HrWorkEntry } from '../../../../packages/domain/src/oda-hr-attendance';

type AttendanceProps = HrPanelProps & { tab: 'attendance' | 'leave' | 'shifts' };
type Employee = { id: string; name: string };
type Command = (type: string, input: Record<string, unknown>, message?: string) => Promise<boolean>;
type Panel = { state: HrAttendanceState; settings: HrPanelProps['workspace']['settings']; employees: Employee[]; employeeId?: string; manage: boolean; busy: boolean; run: Command; filterEmployee: string; month: string; error: string };
const duration = (minutes: number) => `${Math.floor(Math.abs(minutes) / 60)}시간${Math.abs(minutes) % 60 ? ` ${Math.abs(minutes) % 60}분` : ''}${minutes < 0 ? ' 차감' : ''}`;
const policyKinds: Record<string, string> = { fixed: '고정', staggered: '시차', selective: '선택적', shift: '교대' };
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
function textField(data: FormData, key: string): string { return String(data.get(key) ?? '').trim(); }
function numberField(data: FormData, key: string): number { return Number(textField(data, key)); }
function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="hr-field"><span>{title}</span>{children}</label>;
}
function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="hr-card"><div className="hr-card-head"><div><h3>{title}</h3>{description && <p>{description}</p>}</div></div>{children}</section>;
}
function Empty({ children }: { children: ReactNode }) { return <p className="hr-empty">{children}</p>; }
function State({ state }: { state: string }) {
  const names: Record<string, string> = { draft: '작성 중', pending: '승인 대기', submitted: '승인 대기', approved: '승인 완료', rejected: '반려', cancelled: '취소', confirmed: '확정', published: '게시됨', active: '사용 중', archived: '보관됨', open: '기록 중', closed: '마감', completed: '완료', locked: '마감', reopened: '마감 해제' };
  return <span className={`hr-badge hr-status-${state}`}>{names[state] ?? state}</span>;
}
function EmployeeField({ employees, employeeId, manage, name = 'employeeId', title = '구성원' }: { employees: Employee[]; employeeId?: string; manage: boolean; name?: string; title?: string }) {
  if (!manage) return <><input type="hidden" name={name} value={employeeId ?? ''} /><p className="hr-note">{employees.find(row => row.id === employeeId)?.name || '연결된 구성원 없음'}</p></>;
  return <Field title={title}><select name={name} required defaultValue={employeeId ?? ''}><option value="">구성원 선택</option>{employees.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>;
}
function Form({ children, busy, onSave, submit = '저장', reset = true }: { children: ReactNode; busy: boolean; onSave: (data: FormData) => Promise<boolean>; submit?: string; reset?: boolean }) {
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || lock.current) return;
    const form = event.currentTarget;
    lock.current = true; setSaving(true);
    try { if (await onSave(new FormData(form)) && reset) form.reset(); }
    finally { lock.current = false; setSaving(false); }
  }
  return <form className="hr-form" onSubmit={event => void handle(event)}><fieldset disabled={busy || saving}>{children}<div className="hr-actions"><Button type="submit" disabled={busy || saving}>{saving ? '저장 중…' : submit}</Button></div></fieldset></form>;
}

export function HrAttendance({ workspace, permissions, mutate, busy, employeeId, tab }: AttendanceProps) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [month, setMonth] = useState(hrToday().slice(0, 7));
  const [filterEmployee, setFilterEmployee] = useState('');
  const lock = useRef(false);
  async function run(type: string, input: Record<string, unknown>, success = '저장했습니다.'): Promise<boolean> {
    if (busy || lock.current) return false;
    lock.current = true; setSaving(true); setError(''); setMessage('');
    try { await mutate(type, input); setMessage(success); return true; }
    catch (cause) { setError(hrError(cause)); return false; }
    finally { lock.current = false; setSaving(false); }
  }
  const employees = permissions.manage ? workspace.employees : workspace.employees.filter(row => row.id === employeeId);
  const props: Panel = { state: workspace.attendance, settings: workspace.settings, employees, employeeId, manage: permissions.manage, busy: busy || saving, run, filterEmployee: permissions.manage ? filterEmployee : employeeId ?? '__unlinked__', month, error };
  return <div className="hr-stack" aria-label={tab === 'attendance' ? '근무 관리' : tab === 'leave' ? '휴가 관리' : '교대근무표'}>
    {error && <div className="hr-error" role="alert">{error}</div>}
    {message && <p className="hr-success" role="status">{message}</p>}
    {!permissions.manage && !employeeId && <div className="hr-empty">계정에 연결된 구성원이 없습니다. 인사 관리자에게 구성원 계정 연결을 요청해 주세요.</div>}
    <div className="hr-toolbar"><Field title="조회 월"><input type="month" value={month} onChange={event => setMonth(event.target.value)} /></Field>{permissions.manage && <Field title="조회 구성원"><select value={filterEmployee} onChange={event => setFilterEmployee(event.target.value)}><option value="">전체 구성원</option>{employees.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>}<span className="hr-muted">모든 근무 일자와 출퇴근 시간은 한국 시간 기준입니다.</span></div>
    {tab === 'attendance' && <WorkPanel {...props} />}
    {tab === 'leave' && <LeavePanel {...props} />}
    {tab === 'shifts' && <ShiftPanel {...props} />}
  </div>;
}

function WorkFields({ employees, employeeId, manage, entry }: Pick<Panel, 'employees' | 'employeeId' | 'manage'> & { entry?: HrWorkEntry }) {
  return <div className="hr-form-grid">
    {entry ? <><input type="hidden" name="employeeId" value={entry.employeeId} /><p>{employees.find(row => row.id === entry.employeeId)?.name ?? entry.employeeId}</p></> : <EmployeeField employees={employees} employeeId={employeeId} manage={manage} />}
    <Field title="근무 시작일"><input name="date" type="date" required defaultValue={entry?.date ?? hrToday()} /></Field>
    <Field title="시작 시간"><input name="startTime" type="time" required defaultValue={entry?.startTime ?? '09:00'} /></Field>
    <Field title="근무 종료일"><input name="endDate" type="date" required defaultValue={entry?.endDate ?? hrToday()} /></Field>
    <Field title="종료 시간"><input name="endTime" type="time" required defaultValue={entry?.endTime ?? '18:00'} /></Field>
    <Field title="휴게 시간 (분)"><input name="breakMinutes" type="number" min="0" max="1439" step="1" required defaultValue={entry?.breakMinutes ?? 60} /></Field>
    {manage && <Field title="인정 근무 분 (선택)"><input name="recognizedMinutes" type="number" min="0" max="1440" step="1" defaultValue={entry?.recognizedMinutes ?? ''} placeholder="미입력 시 근무유형으로 계산" /></Field>}
    <Field title="기록 메모"><input name="note" maxLength={2000} defaultValue={entry?.note ?? ''} /></Field>
  </div>;
}
function workInput(data: FormData) {
  return { employeeId: textField(data, 'employeeId'), date: textField(data, 'date'), endDate: textField(data, 'endDate'), startTime: textField(data, 'startTime'), endTime: textField(data, 'endTime'), breakMinutes: numberField(data, 'breakMinutes'), note: textField(data, 'note'), ...(textField(data, 'recognizedMinutes') ? { recognizedMinutes: numberField(data, 'recognizedMinutes') } : {}) };
}

function WorkPanel(props: Panel) {
  const { state, employees, employeeId, manage, busy, run, filterEmployee, month } = props;
  const [editing, setEditing] = useState<HrWorkEntry | null>(null);
  const [clockEmployee, setClockEmployee] = useState(employeeId ?? '');
  const [status, setStatus] = useState('');
  const selectedClockEmployee = manage ? clockEmployee : employeeId ?? '';
  const employeeName = (id: string) => employees.find(row => row.id === id)?.name ?? id;
  const entries = state.workEntries.filter(row => (!filterEmployee || row.employeeId === filterEmployee) && (!month || row.date.startsWith(month)) && (!status || row.status === status)).slice().sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
  const events = state.clockEvents.filter(row => row.employeeId === selectedClockEmployee).slice().reverse();
  const clockedIn = events[0]?.kind === 'in';
  const editable = manage || Boolean(employeeId);
  return <>
    <div className="hr-metrics"><div className="hr-metric"><span>승인된 근무</span><strong>{duration(entries.filter(row => row.status === 'approved').reduce((sum, row) => sum + row.recognizedMinutes, 0))}</strong></div><div className="hr-metric"><span>승인 대기</span><strong>{entries.filter(row => row.status === 'pending').length}건</strong></div><div className="hr-metric"><span>조회 기록</span><strong>{entries.length}건</strong></div></div>
    {editable && <Card title="출퇴근 기록" description="버튼을 누른 시각으로 실제 출퇴근 기록을 남깁니다.">
      <div className="hr-toolbar">{manage && <Field title="출퇴근 구성원"><select value={clockEmployee} onChange={event => setClockEmployee(event.target.value)}><option value="">구성원 선택</option>{employees.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>}<span>{selectedClockEmployee ? `${employeeName(selectedClockEmployee)} · ${clockedIn ? '근무 중' : '출근 전'}` : '구성원을 선택해 주세요.'}</span><Button disabled={busy || !selectedClockEmployee || clockedIn} onClick={() => void run('clock.in', { employeeId: selectedClockEmployee }, '출근을 기록했습니다.')}>출근</Button><Button variant="secondary" disabled={busy || !selectedClockEmployee || !clockedIn} onClick={() => void run('clock.out', { employeeId: selectedClockEmployee }, '퇴근을 기록했습니다.')}>퇴근</Button></div>
      {events.length > 0 && <details><summary>최근 실제 출퇴근 기록 {Math.min(events.length, 20)}건</summary><ul className="hr-list">{events.slice(0, 20).map(row => <li key={row.id}>{row.correction ? '미퇴근 정리' : row.kind === 'in' ? '출근' : '퇴근'}{row.note ? ` (${row.note})` : ''} · {new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(row.at))}</li>)}</ul></details>}
      {manage && clockedIn && <details><summary>미퇴근 기록 정리</summary><p className="hr-muted">선택한 구성원의 열린 출근 기록을 종료합니다. 실제 근무 시간은 아래 근무 기록 추가에서 별도로 입력해 주세요.</p><Form busy={busy} submit="미퇴근 기록 정리" onSave={data => run('clock.resolve', { employeeId: selectedClockEmployee, note: textField(data, 'note') }, '미퇴근 기록을 정리했습니다. 실제 근무 시간이 있다면 근무 기록을 별도로 추가해 주세요.')}><Field title="미퇴근 기록 정리 사유"><input name="note" required maxLength={2000} /></Field></Form></details>}
    </Card>}
    {editable && <Card title="근무 기록 추가" description="실제 근무 시간과 휴게 시간을 입력하세요. 밤을 넘겨 근무했다면 종료일을 다음 날로 지정하세요."><Form busy={busy} submit="근무 기록 저장" onSave={data => run('work.create', workInput(data))}><WorkFields employees={employees} employeeId={employeeId} manage={manage} /></Form></Card>}
    <Card title="근무 기록"><div className="hr-toolbar"><Field title="근무 상태"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">모든 상태</option><option value="pending">승인 대기</option><option value="approved">승인 완료</option><option value="rejected">반려</option><option value="cancelled">취소</option></select></Field></div>
      {entries.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>구성원</th><th>근무 일시</th><th>휴게</th><th>인정 시간</th><th>출처·메모</th><th>상태</th><th>처리</th></tr></thead><tbody>{entries.map(row => { const locked = isHrAttendanceLocked(state, row.employeeId, row.date) || isHrAttendanceLocked(state, row.employeeId, row.endDate); const actionable = editable && !locked && (manage || row.employeeId === employeeId); return <tr key={row.id}><td>{employeeName(row.employeeId)}</td><td>{row.date} {row.startTime}<br />~ {row.endDate} {row.endTime}</td><td>{row.breakMinutes}분</td><td>{duration(row.recognizedMinutes)}</td><td>{{ manual: '직접 입력', clock: '출퇴근 기록', shift: '교대근무표' }[row.source]}{row.note && <small>{row.note}</small>}</td><td><State state={row.status} />{locked && <span className="hr-badge">마감</span>}</td><td><div className="hr-actions">{actionable && (row.status === 'pending' || row.status === 'approved') && <><Button variant="secondary" disabled={busy} onClick={() => setEditing(row)}>수정</Button><Button variant="secondary" disabled={busy} onClick={() => void run('work.cancel', { id: row.id, expectedRevision: row.revision }, '근무 기록을 취소했습니다.')}>취소</Button></>}{manage && actionable && row.status === 'pending' && <><Button disabled={busy} onClick={() => void run('work.approve', { id: row.id, expectedRevision: row.revision }, '근무 기록을 승인했습니다.')}>승인</Button><Button variant="secondary" disabled={busy} onClick={() => void run('work.reject', { id: row.id, expectedRevision: row.revision }, '근무 기록을 반려했습니다.')}>반려</Button></>}</div></td></tr>; })}</tbody></table></div> : <Empty>조회 조건에 맞는 근무 기록이 없습니다.</Empty>}
    </Card>
    {editing && <HrDialog title="근무 기록 수정" onClose={() => setEditing(null)} busy={busy}><p className="hr-muted">수정 내용은 적용된 근무유형의 승인 설정에 따라 다시 검토됩니다.</p>{props.error && <p className="hr-error" role="alert">{props.error}</p>}<Form busy={busy} submit="수정 저장" onSave={async data => { const saved = await run('work.update', { id: editing.id, expectedRevision: editing.revision, ...workInput(data) }); if (saved) setEditing(null); return saved; }}><WorkFields employees={employees} employeeId={employeeId} manage={manage} entry={editing} /></Form></HrDialog>}
    {manage && <><PolicySettings {...props} /><HolidaySettings {...props} /><AttendanceLocks {...props} /></>}
  </>;
}

function PolicySettings({ state, settings, employees, busy, run }: Panel) {
  // These are editable form proposals, never an automatic policy assignment or a statutory calculation.
  const proposedDailyMinutes = Math.round(settings.workdayHours * 60);
  const proposedBreakMinutes = Math.min(proposedDailyMinutes >= 480 ? 60 : proposedDailyMinutes >= 240 ? 30 : 0, 1440 - proposedDailyMinutes);
  const proposedEnd = (9 * 60 + proposedDailyMinutes + proposedBreakMinutes) % 1440;
  const proposedEndTime = `${String(Math.floor(proposedEnd / 60)).padStart(2, '0')}:${String(proposedEnd % 60).padStart(2, '0')}`;
  return <Card title="근무유형·적용 이력" description="고정근무는 정해진 시간 안에서 인정 시간을 계산합니다. 운영 주기와 코어타임은 참고 기준이며 주기별 초과근무나 코어타임 위반을 자동 판정하지 않습니다."><details><summary>근무유형 만들기</summary><p className="hr-muted">회사 설정의 하루 {settings.workdayHours}시간과 주 {settings.weeklyDays}일을 초기 입력으로 제안합니다. 요일은 월요일부터 선택하고 휴게·종료 시간도 제안하므로 회사 운영에 맞게 수정하세요. 유형을 저장한 뒤 구성원에게 별도로 적용해야 하며 기존 근무나 급여는 자동 변경되지 않습니다.</p><Form busy={busy} submit="근무유형 만들기" onSave={data => run('work.policy.create', { name: textField(data, 'name'), kind: textField(data, 'kind'), cycle: textField(data, 'cycle'), effectiveFrom: textField(data, 'effectiveFrom'), dailyMinutes: numberField(data, 'dailyMinutes'), breakMinutes: numberField(data, 'breakMinutes'), workdays: data.getAll('workdays').map(Number), startTime: textField(data, 'startTime'), endTime: textField(data, 'endTime'), requireApproval: data.has('requireApproval'), coreStart: textField(data, 'coreStart'), coreEnd: textField(data, 'coreEnd') })}><div className="hr-form-grid">
      <Field title="근무유형 이름"><input name="name" required maxLength={100} /></Field><Field title="유형"><select name="kind" defaultValue="fixed">{Object.entries(policyKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field title="운영 주기"><select name="cycle" defaultValue="1w"><option value="1w">1주</option><option value="2w">2주</option><option value="3w">3주</option><option value="4w">4주</option><option value="1m">1개월</option></select></Field><Field title="사용 시작일"><input name="effectiveFrom" type="date" required defaultValue={hrToday()} /></Field><Field title="1일 소정근무 (분)"><input name="dailyMinutes" type="number" min="1" max="1440" required defaultValue={proposedDailyMinutes} /></Field><Field title="휴게 (분)"><input name="breakMinutes" type="number" min="0" max="1439" required defaultValue={proposedBreakMinutes} /></Field><Field title="시작 시간"><input name="startTime" type="time" required defaultValue="09:00" /></Field><Field title="종료 시간"><input name="endTime" type="time" required defaultValue={proposedEndTime} /></Field><Field title="코어타임 참고 시작 (선택)"><input name="coreStart" type="time" /></Field><Field title="코어타임 참고 종료 (선택)"><input name="coreEnd" type="time" /></Field>
      </div><div className="hr-actions" role="group" aria-label="근무 요일">{weekdays.map((day, index) => <label className="hr-check" key={day}><input name="workdays" type="checkbox" value={index || 7} defaultChecked={(index || 7) <= settings.weeklyDays} />{day}</label>)}</div><label className="hr-check"><input name="requireApproval" type="checkbox" defaultChecked />근무 기록 승인 필요</label></Form></details>
    {state.workPolicies.length ? <><div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>이름·유형</th><th>시간·요일</th><th>소정·휴게</th><th>시작일</th><th>승인</th></tr></thead><tbody>{state.workPolicies.map(row => <tr key={row.id}><td>{row.name} · {policyKinds[row.kind]}</td><td>{row.startTime}~{row.endTime}<br />{row.workdays.map(day => weekdays[day % 7]).join('·')} · {row.cycle === '1m' ? '1개월' : `${row.cycle.slice(0, 1)}주`}</td><td>{row.dailyMinutes}분 · 휴게 {row.breakMinutes}분</td><td>{row.effectiveFrom}</td><td>{row.requireApproval ? '필요' : '자동 승인'}</td></tr>)}</tbody></table></div><details><summary>구성원에게 근무유형 적용</summary><Form busy={busy} submit="적용일 저장" onSave={data => run('work.policy.assign', { employeeId: textField(data, 'employeeId'), policyId: textField(data, 'policyId'), effectiveFrom: textField(data, 'effectiveFrom') })}><div className="hr-form-grid"><EmployeeField employees={employees} manage /><Field title="근무유형"><select name="policyId" required defaultValue=""><option value="">근무유형 선택</option>{state.workPolicies.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field title="적용일"><input name="effectiveFrom" type="date" required defaultValue={hrToday()} /></Field></div></Form></details></> : <Empty>등록된 근무유형이 없습니다. 근무유형을 만들고 구성원에게 적용해 주세요.</Empty>}
    {state.assignments.length > 0 && <details><summary>적용 이력 {state.assignments.length}건</summary><ul className="hr-list">{state.assignments.slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)).map(row => <li key={row.id}>{employees.find(employee => employee.id === row.employeeId)?.name ?? row.employeeId} · {state.workPolicies.find(policy => policy.id === row.policyId)?.name ?? row.policyId} · {row.effectiveFrom}부터</li>)}</ul></details>}
  </Card>;
}

function AttendanceLocks({ state, employees, busy, run }: Panel) {
  return <Card title="근태 마감" description="마감한 기간의 근무·휴가·교대근무표 변경을 잠급니다. 수정이 필요하면 사유를 기록하고 마감을 해제하세요."><details><summary>기간 마감하기</summary><Form busy={busy} submit="근태 마감" onSave={data => run('attendance.lock', { startDate: textField(data, 'startDate'), endDate: textField(data, 'endDate'), employeeIds: data.getAll('employeeIds').map(String), reason: textField(data, 'reason') }, '선택한 근태 기간을 마감했습니다.')}><div className="hr-form-grid"><Field title="시작일"><input name="startDate" type="date" required /></Field><Field title="종료일"><input name="endDate" type="date" required /></Field><Field title="마감 사유"><input name="reason" required maxLength={2000} /></Field></div><p className="hr-muted">대상을 선택하지 않으면 전체 구성원을 마감합니다.</p><div className="hr-actions">{employees.map(row => <label className="hr-check" key={row.id}><input name="employeeIds" type="checkbox" value={row.id} />{row.name}</label>)}</div></Form></details>
    {state.locks.length ? <ul className="hr-list">{state.locks.slice().reverse().map(row => <li key={row.id}><strong>{row.startDate}~{row.endDate}</strong> · {row.employeeIds.length ? row.employeeIds.map(id => employees.find(employee => employee.id === id)?.name ?? id).join(', ') : '전체 구성원'} · <State state={row.status} /><p>{row.reason}</p>{row.status === 'locked' && <Form busy={busy} submit="마감 해제" onSave={data => run('attendance.unlock', { id: row.id, expectedRevision: row.revision, reason: textField(data, 'reason') }, '마감을 해제했습니다.')}><Field title="마감 해제 사유"><input name="reason" required maxLength={2000} /></Field></Form>}</li>)}</ul> : <Empty>마감한 기간이 없습니다.</Empty>}
  </Card>;
}

function HolidaySettings({ state, busy, run }: Panel) {
  return <Card title="회사 휴일" description="등록한 휴일은 기간 휴가 신청 시 근무일에서 제외됩니다."><details><summary>휴일 {state.holidays.length}일 관리</summary><Form key={state.holidays.join(',')} busy={busy} submit="회사 휴일 저장" reset={false} onSave={data => run('attendance.holidays.set', { dates: textField(data, 'dates').split(/[\s,]+/).filter(Boolean) }, '회사 휴일을 저장했습니다.')}><Field title="휴일 날짜 목록"><textarea name="dates" rows={5} defaultValue={state.holidays.join('\n')} placeholder="YYYY-MM-DD 형식으로 한 줄에 하루씩 입력" /></Field><p className="hr-muted">목록 전체가 저장됩니다. 날짜를 지우면 해당 휴일이 해제됩니다.</p></Form></details></Card>;
}

function LeavePanel({ state, settings, employees, employeeId, manage, busy, run, filterEmployee, month }: Panel) {
  const [balanceDate, setBalanceDate] = useState(hrToday());
  const [requestType, setRequestType] = useState(state.leaveTypes[0]?.id ?? '');
  const [status, setStatus] = useState('');
  const selectedType = state.leaveTypes.find(row => row.id === requestType);
  const employeeName = (id: string) => employees.find(row => row.id === id)?.name ?? id;
  const requests = state.leaveRequests.filter(row => (!filterEmployee || row.employeeId === filterEmployee) && (!month || row.slots.some(slot => slot.date.startsWith(month))) && (!status || row.status === status)).slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
  const balanceEmployees = employees.filter(row => !filterEmployee || row.id === filterEmployee);
  const ledger = state.leaveLedger.filter(row => (!filterEmployee || row.employeeId === filterEmployee) && (!month || row.effectiveFrom.startsWith(month) || row.at.startsWith(month))).slice().reverse();
  return <>
    <Card title="휴가 잔액" description="사용 가능한 잔액에서 승인 대기 중인 신청분은 이미 예약됩니다. 취소·반려하면 원래 지급분의 유효기간으로 복원됩니다."><div className="hr-toolbar"><Field title="잔액 기준일"><input type="date" required value={balanceDate} onChange={event => setBalanceDate(event.target.value || hrToday())} /></Field></div>
      {balanceEmployees.length && state.leaveTypes.some(row => row.deductBalance) ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>구성원</th><th>휴가 종류</th><th>사용 가능</th><th>승인 대기 예약</th></tr></thead><tbody>{balanceEmployees.flatMap(employee => state.leaveTypes.filter(type => type.deductBalance).map(type => { const balance = getHrLeaveBalance(state, employee.id, type.id, balanceDate); return <tr key={`${employee.id}-${type.id}`}><td>{employee.name}</td><td>{type.name}</td><td>{duration(balance.availableMinutes)}</td><td>{duration(balance.reservedMinutes)}</td></tr>; }))}</tbody></table></div> : <Empty>잔액을 조회할 구성원이나 잔액 차감형 휴가가 없습니다.</Empty>}
    </Card>
    {(manage || employeeId) && <Card title="휴가 신청" description="근무일별 사용 시간과 사유를 입력하세요. 적용 근무유형과 게시된 교대가 없으면 월~금 09:00~18:00, 하루 최대 480분을 기준으로 휴가를 검증합니다. 시급 급여는 승인된 인정 근무 분과 유급휴가 분으로 계산하며 회사의 하루 기준 시간으로 자동 대체하지 않습니다.">
      {state.leaveTypes.length ? <Form busy={busy} reset={false} submit="휴가 신청" onSave={data => run('leave.request', { employeeId: textField(data, 'employeeId'), typeId: requestType, startDate: textField(data, 'startDate'), endDate: textField(data, 'endDate'), startTime: textField(data, 'startTime'), endTime: textField(data, 'endTime'), minutesPerDay: numberField(data, 'minutesPerDay'), note: textField(data, 'note') }, '휴가를 신청했습니다. 아래에서 처리 상태를 확인해 주세요.')}><div className="hr-form-grid"><EmployeeField employees={employees} employeeId={employeeId} manage={manage} /><Field title="휴가 종류"><select value={requestType} onChange={event => setRequestType(event.target.value)} required><option value="">휴가 선택</option>{state.leaveTypes.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field title="시작일"><input name="startDate" type="date" required defaultValue={hrToday()} /></Field><Field title="종료일"><input name="endDate" type="date" required defaultValue={hrToday()} /></Field><Field title="매일 시작 시간"><input name="startTime" type="time" required defaultValue="09:00" /></Field><Field title="매일 종료 시간"><input name="endTime" type="time" required defaultValue="18:00" /></Field><Field title="하루 사용량 (분)"><input name="minutesPerDay" type="number" min={selectedType?.unitMinutes ?? 1} max="1440" step={selectedType?.unitMinutes ?? 1} required defaultValue="480" /></Field><Field title="신청 사유"><textarea name="note" maxLength={2000} rows={2} /></Field></div>{selectedType && <p className="hr-muted">{selectedType.paid ? '유급' : '무급'} · {selectedType.deductBalance ? '잔액 차감' : '잔액 차감 없음'} · {selectedType.unitMinutes}분 단위 · {selectedType.requireApproval ? '승인 필요' : '신청 시 승인'}</p>}</Form> : <Empty>신청 가능한 휴가 종류가 없습니다.</Empty>}
    </Card>}
    <Card title="휴가 신청 내역"><div className="hr-toolbar"><Field title="휴가 상태"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">모든 상태</option><option value="pending">승인 대기</option><option value="approved">승인 완료</option><option value="rejected">반려</option><option value="cancelled">취소</option></select></Field></div>
      {requests.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>구성원</th><th>휴가</th><th>기간·사용량</th><th>사유</th><th>상태</th><th>처리</th></tr></thead><tbody>{requests.map(row => { const locked = row.slots.some(slot => isHrAttendanceLocked(state, row.employeeId, slot.date)); const actionable = !locked && (manage || row.employeeId === employeeId); return <tr key={row.id}><td>{employeeName(row.employeeId)}</td><td>{state.leaveTypes.find(type => type.id === row.typeId)?.name ?? row.typeId}<br /><span className="hr-muted">{row.paid ? '유급' : '무급'}</span></td><td>{row.startDate}~{row.endDate}<br />총 {duration(row.minutes)}<details><summary>일별 사용 {row.slots.length}일</summary>{row.slots.map(slot => <p key={slot.date}>{slot.date} {slot.startTime}~{slot.endTime} · {duration(slot.minutes)}</p>)}</details></td><td>{row.note || '—'}</td><td><State state={row.status} />{locked && <span className="hr-badge">마감</span>}</td><td><div className="hr-actions">{actionable && (row.status === 'pending' || row.status === 'approved') && <Button variant="secondary" disabled={busy} onClick={() => void run('leave.cancel', { id: row.id, expectedRevision: row.revision }, '휴가 신청을 취소했습니다.')}>취소</Button>}{manage && actionable && row.status === 'pending' && <><Button disabled={busy} onClick={() => void run('leave.approve', { id: row.id, expectedRevision: row.revision }, '휴가를 승인했습니다.')}>승인</Button><Button variant="secondary" disabled={busy} onClick={() => void run('leave.reject', { id: row.id, expectedRevision: row.revision }, '휴가를 반려했습니다.')}>반려</Button></>}</div></td></tr>; })}</tbody></table></div> : <Empty>조회 조건에 맞는 휴가 신청이 없습니다.</Empty>}
    </Card>
    {manage && <Card title="휴가 지급·종류 설정"><details><summary>휴가 지급하기</summary><p className="hr-muted">회사 설정 {settings.annualLeaveDays}일 × 하루 {settings.workdayHours}시간을 분으로 환산해 제안합니다. 실제 지급할 수량으로 수정한 뒤 저장하세요. 설정 변경만으로 휴가가 발생하거나 기존 잔액이 바뀌지 않습니다.</p><Form busy={busy} submit="휴가 지급" onSave={data => run('leave.grant', { employeeId: textField(data, 'employeeId'), typeId: textField(data, 'typeId'), minutes: numberField(data, 'minutes'), effectiveFrom: textField(data, 'effectiveFrom'), expiresOn: textField(data, 'expiresOn'), note: textField(data, 'note') }, '휴가를 지급했습니다.')}><div className="hr-form-grid"><EmployeeField employees={employees} manage /><Field title="지급할 휴가"><select name="typeId" required defaultValue=""><option value="">휴가 선택</option>{state.leaveTypes.filter(row => row.deductBalance).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field title="지급량 (분)"><input name="minutes" type="number" min="1" max="1000000" step="1" required defaultValue={Math.round(settings.annualLeaveDays * settings.workdayHours * 60)} /></Field><Field title="사용 시작일"><input name="effectiveFrom" type="date" required defaultValue={hrToday()} /></Field><Field title="사용 종료일"><input name="expiresOn" type="date" required /></Field><Field title="지급 사유"><input name="note" maxLength={2000} /></Field></div></Form></details>
      <details><summary>휴가 종류 만들기</summary><Form busy={busy} submit="휴가 종류 만들기" onSave={data => run('leave.type.create', { name: textField(data, 'name'), paid: data.has('paid'), deductBalance: data.has('deductBalance'), unitMinutes: numberField(data, 'unitMinutes'), requireApproval: data.has('requireApproval') })}><div className="hr-form-grid"><Field title="휴가 이름"><input name="name" required maxLength={100} /></Field><Field title="최소 사용 단위 (분)"><input name="unitMinutes" type="number" min="1" max="480" required defaultValue="30" /></Field></div><div className="hr-actions"><label className="hr-check"><input name="paid" type="checkbox" defaultChecked />유급휴가</label><label className="hr-check"><input name="deductBalance" type="checkbox" defaultChecked />지급 잔액에서 차감</label><label className="hr-check"><input name="requireApproval" type="checkbox" defaultChecked />승인 필요</label></div></Form></details>
      <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>휴가 종류</th><th>유·무급</th><th>잔액 차감</th><th>사용 단위</th><th>승인</th></tr></thead><tbody>{state.leaveTypes.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.paid ? '유급' : '무급'}</td><td>{row.deductBalance ? '차감' : '미차감'}</td><td>{row.unitMinutes}분</td><td>{row.requireApproval ? '필요' : '자동 승인'}</td></tr>)}</tbody></table></div>
    </Card>}
    <Card title="휴가 지급·차감 원장" description="지급, 사용 예약, 복원 내역을 발생 순서대로 보관합니다.">{ledger.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>구성원·휴가</th><th>내역</th><th>증감</th><th>유효기간</th><th>메모</th></tr></thead><tbody>{ledger.map(row => <tr key={row.id}><td>{employeeName(row.employeeId)} · {state.leaveTypes.find(type => type.id === row.typeId)?.name ?? row.typeId}</td><td>{{ grant: '지급', use: '사용·예약', restore: '복원' }[row.kind]}</td><td>{row.minutes > 0 ? '+' : ''}{row.minutes.toLocaleString('ko-KR')}분</td><td>{row.effectiveFrom}~{row.expiresOn}</td><td>{row.note || '—'}</td></tr>)}</tbody></table></div> : <Empty>조회 조건에 맞는 지급·차감 내역이 없습니다.</Empty>}</Card>
  </>;
}

function ShiftPanel({ state, employees, employeeId, manage, busy, run, filterEmployee, month }: Panel) {
  const [selected, setSelected] = useState<string[]>([]);
  const [editId, setEditId] = useState('');
  const editing = state.shifts.find(row => row.id === editId);
  const shifts = state.shifts.filter(row => (manage || row.status === 'published') && (!filterEmployee || row.employeeId === filterEmployee) && (!month || row.date.startsWith(month))).slice().sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId));
  const publishable = shifts.filter(row => row.status === 'draft' && !isHrAttendanceLocked(state, row.employeeId, row.date));
  const picked = publishable.filter(row => selected.includes(row.id));
  async function publish() {
    if (!picked.length) return;
    const saved = await run('shift.publish', { ids: picked.map(row => row.id), revisions: Object.fromEntries(picked.map(row => [row.id, row.revision])) }, `${picked.length}개 근무를 게시했습니다.`);
    if (saved) setSelected([]);
  }
  async function save(data: FormData) {
    const saved = await run('shift.save', { employeeId: textField(data, 'employeeId'), date: textField(data, 'date'), templateId: textField(data, 'templateId'), note: textField(data, 'note'), ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) }, '근무표 초안을 저장했습니다. 게시하면 구성원에게 확정된 근무로 표시됩니다.');
    if (saved) setEditId('');
    return saved;
  }
  return <>
    <div className="hr-metrics"><div className="hr-metric"><span>게시된 근무</span><strong>{shifts.filter(row => row.status === 'published' && row.kind === 'work').length}건</strong></div><div className="hr-metric"><span>게시된 휴무</span><strong>{shifts.filter(row => row.status === 'published' && row.kind === 'off').length}건</strong></div>{manage && <div className="hr-metric"><span>초안</span><strong>{shifts.filter(row => row.status === 'draft').length}건</strong></div>}</div>
    {manage && <Card title="근무표 배정" description="구성원과 날짜에 근무 템플릿을 배정하고, 내용을 확인한 다음 게시하세요.">
      {state.shiftTemplates.length ? <Form key={editing?.id ?? 'new'} busy={busy} submit={editing ? '배정 수정' : '근무표 초안 저장'} onSave={save}><div className="hr-form-grid">{editing ? <><input type="hidden" name="employeeId" value={editing.employeeId} /><p>{employees.find(row => row.id === editing.employeeId)?.name ?? editing.employeeId}</p></> : <EmployeeField employees={employees} employeeId={employeeId} manage />}<Field title="근무 날짜"><input name="date" type="date" required defaultValue={editing?.date ?? hrToday()} /></Field><Field title="근무 템플릿"><select name="templateId" required defaultValue={editing?.templateId ?? ''}><option value="">템플릿 선택</option>{state.shiftTemplates.map(row => <option key={row.id} value={row.id}>{row.name} · {row.kind === 'off' ? '휴무' : `${row.startTime}~${row.endTime}`}</option>)}</select></Field><Field title="배정 메모"><input name="note" maxLength={2000} defaultValue={editing?.note ?? ''} /></Field></div>{editing && <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditId('')}>수정 취소</Button>}</Form> : <Empty>먼저 아래에서 근무·휴무 템플릿을 만들어 주세요.</Empty>}
    </Card>}
    <Card title="교대근무표"><div className="hr-toolbar">{manage && <><Button variant="secondary" disabled={busy || !publishable.length} onClick={() => setSelected(publishable.map(row => row.id))}>게시 가능한 초안 전체 선택</Button><Button variant="secondary" disabled={busy || !selected.length} onClick={() => setSelected([])}>선택 해제</Button><Button disabled={busy || !picked.length} onClick={() => void publish()}>선택 {picked.length}건 게시</Button></>}<span className="hr-muted">{shifts.length}건</span></div>
      {shifts.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr>{manage && <th>선택</th>}<th>날짜</th><th>구성원</th><th>근무</th><th>시간·휴게</th><th>상태</th><th>메모</th>{manage && <th>처리</th>}</tr></thead><tbody>{shifts.map(row => { const locked = isHrAttendanceLocked(state, row.employeeId, row.date); return <tr key={row.id}>{manage && <td><input type="checkbox" aria-label={`${row.date} ${employees.find(employee => employee.id === row.employeeId)?.name ?? row.employeeId} 게시 선택`} disabled={busy || locked || row.status !== 'draft'} checked={selected.includes(row.id) && row.status === 'draft'} onChange={event => setSelected(event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} /></td>}<td>{row.date}</td><td>{employees.find(employee => employee.id === row.employeeId)?.name ?? row.employeeId}</td><td>{state.shiftTemplates.find(template => template.id === row.templateId)?.name ?? row.templateId}{row.kind === 'off' && ' · 휴무'}</td><td>{row.startTime}~{row.endTime}<br />휴게 {row.breakMinutes}분</td><td><State state={row.status} />{locked && <span className="hr-badge">마감</span>}</td><td>{row.note || '—'}</td>{manage && <td><div className="hr-actions">{!locked && row.status !== 'cancelled' && <>{row.status === 'draft' && <Button variant="secondary" disabled={busy} onClick={() => setEditId(row.id)}>배정 수정</Button>}<Button variant="secondary" disabled={busy} onClick={() => void run('shift.cancel', { id: row.id, expectedRevision: row.revision }, '근무표 배정을 취소했습니다.')}>배정 취소</Button></>}</div></td>}</tr>; })}</tbody></table></div> : <Empty>{manage ? '조회 조건에 맞는 근무표가 없습니다. 템플릿을 배정하고 게시해 주세요.' : '조회 조건에 맞는 게시된 근무표가 없습니다.'}</Empty>}
    </Card>
    {manage && <Card title="근무·휴무 템플릿"><details><summary>템플릿 만들기</summary><Form busy={busy} submit="템플릿 만들기" onSave={data => run('shift.template.create', { name: textField(data, 'name'), kind: textField(data, 'kind'), startTime: textField(data, 'startTime'), endTime: textField(data, 'endTime'), breakMinutes: numberField(data, 'breakMinutes') })}><div className="hr-form-grid"><Field title="템플릿 이름"><input name="name" required maxLength={100} /></Field><Field title="구분"><select name="kind" defaultValue="work"><option value="work">근무</option><option value="off">휴무 (OFF)</option></select></Field><Field title="시작 시간"><input name="startTime" type="time" required defaultValue="09:00" /></Field><Field title="종료 시간"><input name="endTime" type="time" required defaultValue="18:00" /></Field><Field title="휴게 (분)"><input name="breakMinutes" type="number" min="0" max="1439" required defaultValue="60" /></Field></div></Form></details>
      {state.shiftTemplates.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>이름</th><th>구분</th><th>시간</th><th>휴게</th></tr></thead><tbody>{state.shiftTemplates.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.kind === 'off' ? '휴무' : '근무'}</td><td>{row.startTime}~{row.endTime}</td><td>{row.breakMinutes}분</td></tr>)}</tbody></table></div> : <Empty>등록된 근무 템플릿이 없습니다.</Empty>}
    </Card>}
  </>;
}
