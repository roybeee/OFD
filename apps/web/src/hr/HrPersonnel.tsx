import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { HrDepartment, HrDocument, HrEmployee, HrNotice } from '../../../../packages/domain/src/oda-hr';
import { Button } from '../components/ui';
import { ArrowDownToLine, Plus } from '../components/icons';
import type { HrTab } from '../pages/OdaHrPage';
import { HrDialog, HrEmpty, hrDate, hrError, hrToday, type HrPanelProps } from './shared';

type PersonnelTab = 'overview' | 'people' | 'documents' | 'settings' | 'help';
type Account = { id: string; name: string; role: string };
type Props = HrPanelProps & { tab: PersonnelTab; accounts?: Account[]; onTabChange: (tab: HrTab) => void };
const employmentNames = { regular: '정규직', contract: '계약직', part_time: '시간제' };
const statusNames = { active: '재직', leave: '휴직', retired: '퇴직' };
const categoryNames = { contract: '계약서', certificate: '증명서', policy: '규정·정책', other: '기타' };
const fieldNames: Record<string, string> = { name: '이름', employeeNumber: '사번', departmentId: '조직', jobTitle: '직책', status: '재직 상태', employmentType: '고용형태', hireDate: '입사일', endDate: '퇴직일', payType: '급여 기준', basePay: '기본급', email: '이메일', phone: '연락처', actorId: '로그인 계정' };
const txt = (data: FormData, key: string) => String(data.get(key) || '').trim();
const person = (employees: HrEmployee[], id?: string) => employees.find(row => row.id === id)?.name || '미지정';

function downloadText(filename: string, body: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', body], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`hr-field${wide ? ' hr-wide' : ''}`}><span>{label}</span>{children}</label>;
}

function SaveForm({ busy, children, onSave, submit = '저장', onCancel }: {
  busy: boolean; children: ReactNode; onSave: (data: FormData) => Promise<void>; submit?: string; onCancel?: () => void;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || saving) return;
    const form = new FormData(event.currentTarget);
    setSaving(true); setError('');
    try { await onSave(form); }
    catch (caught) { setError(hrError(caught)); }
    finally { setSaving(false); }
  }
  return <form className="hr-form" onSubmit={event => void handle(event)}><fieldset disabled={busy || saving}>{children}
    {error && <p className="hr-error" role="alert">{error}</p>}
    <div className="hr-actions">{onCancel && <Button type="button" variant="secondary" onClick={onCancel}>취소</Button>}<Button type="submit">{saving ? '저장 중…' : submit}</Button></div>
  </fieldset></form>;
}

function Confirm({ title, body, busy, onClose, onConfirm }: { title: string; body: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  return <HrDialog title={title} busy={busy} onClose={onClose}><SaveForm busy={busy} onCancel={onClose} submit="보관하기" onSave={async () => { await onConfirm(); onClose(); }}><p className="hr-note">{body}</p></SaveForm></HrDialog>;
}

export function HrPersonnel(props: Props) {
  if (props.tab === 'people') return <People {...props} />;
  if (props.tab === 'documents') return <Documents {...props} />;
  if (props.tab === 'settings') return <Settings {...props} />;
  if (props.tab === 'help') return <Help onTabChange={props.onTabChange} />;
  return <Overview {...props} />;
}

function Overview(props: Props) {
  const { workspace: w, permissions, employeeId, onTabChange } = props;
  const employees = w.employees;
  const active = employees.filter(row => row.status === 'active');
  const departments = w.departments.filter(row => !row.archived);
  const waitingLeave = w.attendance.leaveRequests.filter(row => row.status === 'pending');
  const waitingRequests = w.workflow.requests.filter(row => row.status === 'pending');
  const myEmployee = employees.find(row => row.id === employeeId);
  const today = hrToday();
  return <>
    {!permissions.manage && !permissions.self && <p className="hr-note">내 근무·휴가·급여를 이용하려면 인사 담당자가 직원 정보에 로그인 계정을 연결해야 합니다.</p>}
    <div className="hr-metrics">
      <article className="hr-metric"><span>재직 구성원</span><strong>{active.length}<small> 명</small></strong><small>{departments.length}개 조직</small></article>
      <article className="hr-metric"><span>휴직 구성원</span><strong>{employees.filter(row => row.status === 'leave').length}<small> 명</small></strong><small>조회 가능한 구성원 기준</small></article>
      <article className="hr-metric"><span>{permissions.manage ? '휴가 승인 대기' : '내 휴가 승인 대기'}</span><strong>{waitingLeave.length}<small> 건</small></strong><small>승인 완료 전 신청</small></article>
      <article className="hr-metric"><span>조회 가능한 결재 대기</span><strong>{waitingRequests.length}<small> 건</small></strong><small>제출된 결재 문서</small></article>
    </div>
    {!employees.length && <HrEmpty title="첫 구성원부터 등록해 보세요">직원 정보를 등록한 뒤 근무 정책, 휴가와 급여를 설정할 수 있습니다.{permissions.manage && <Button onClick={() => onTabChange('people')}>직원 등록 시작</Button>}</HrEmpty>}
    <div className="hr-grid"><section className="hr-card"><div className="hr-section-heading"><div><h2>{myEmployee ? `${myEmployee.name}님의 오늘` : '오늘의 인사 업무'}</h2><p>{hrDate(today)}</p></div></div>
      <div className="hr-actions"><Button variant="secondary" onClick={() => onTabChange('attendance')}>근무 기록</Button><Button variant="secondary" onClick={() => onTabChange('leave')}>휴가 확인</Button><Button variant="secondary" onClick={() => onTabChange('approvals')}>결재함</Button></div>
      <p className="hr-note" style={{ marginTop: 18 }}>모든 수치는 현재 계정으로 조회할 수 있는 저장된 인사 정보를 기준으로 집계합니다.</p>
    </section><section className="hr-card"><div className="hr-section-heading"><h2>조직별 재직 인원</h2><Button variant="ghost" onClick={() => onTabChange('people')}>조직 보기</Button></div>
      {active.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>조직</th><th>인원</th></tr></thead><tbody>{[...departments.map(row => ({ id: row.id, name: row.name })), { id: '', name: '미배정' }].map(department => <tr key={department.id}><td>{department.name}</td><td>{active.filter(row => row.departmentId === department.id).length}명</td></tr>)}</tbody></table></div> : <HrEmpty title="집계할 재직 구성원이 없습니다" />}
    </section></div>
    <Notices {...props} />
    <section className="hr-card"><div className="hr-section-heading"><h2>최근 변경 기록</h2><span className="hr-muted">조회 권한이 있는 기록</span></div>
      {w.history.length ? <ol className="hr-list">{w.history.slice(-12).reverse().map(row => <li key={row.id}><strong>{historyName(row.type)}</strong><small>{hrDate(row.at)}</small></li>)}</ol> : <HrEmpty title="아직 변경 기록이 없습니다">인사 정보를 저장하면 변경 이력이 기록됩니다.</HrEmpty>}
    </section>
  </>;
}

function historyName(type: string) {
  const group: Record<string, string> = { workspace: '인사관리 시작', employee: '직원 정보', department: '조직', settings: '인사 설정', notice: '공지', document: '문서', attendance: '근무 기록', work: '근무 기록', leave: '휴가', shift: '근무 일정', payroll: '급여', goal: '목표', review: '평가', meeting: '미팅', recruitment: '채용', candidate: '지원자', contract: '계약', workflow: '전자결재', expense: '비용 청구' };
  const action: Record<string, string> = { create: '등록', update: '수정', retire: '퇴직 처리', archive: '보관', upsert: '저장', approve: '승인', reject: '반려', submit: '제출', cancel: '취소', publish: '게시', close: '마감', open: '시작', finalize: '확정', reopen: '재개' };
  const [prefix, suffix] = type.split('.');
  return `${group[prefix] || '인사 업무'} ${action[suffix] || '변경'}`;
}

function People(props: Props) {
  const { workspace: w, permissions, busy } = props;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [departmentId, setDepartmentId] = useState('all');
  const [view, setView] = useState<'directory' | 'organization'>('directory');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<HrEmployee | 'new' | null>(null);
  const [retiring, setRetiring] = useState<HrEmployee | null>(null);
  const selected = w.employees.find(row => row.id === selectedId);
  const departments = w.departments.filter(row => !row.archived);
  const departmentName = (id: string) => w.departments.find(row => row.id === id)?.name || '미배정';
  const filtered = w.employees.filter(row => (status === 'all' || row.status === status) && (departmentId === 'all' || row.departmentId === departmentId)
    && `${row.name} ${row.employeeNumber} ${row.jobTitle} ${departmentName(row.departmentId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function exportDirectory() {
    const safeCell = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const rows = [['사번', '이름', '조직', '직책', '고용형태', '재직 상태'], ...filtered.map(row => [row.employeeNumber, row.name, departmentName(row.departmentId), row.jobTitle, employmentNames[row.employmentType], statusNames[row.status]])];
    downloadText('직원목록.csv', rows.map(row => row.map(safeCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><h2>직원·조직</h2><p>직원 정보를 찾고 소속 조직과 변경 이력을 확인하세요.</p></div><div className="hr-actions"><Button variant="secondary" onClick={exportDirectory} disabled={!filtered.length}><ArrowDownToLine size={15} /> 목록 내려받기</Button>{permissions.manage && <Button disabled={busy} onClick={() => setEditor('new')}><Plus size={16} /> 직원 등록</Button>}</div></div>
      <div className="hr-actions" style={{ marginBottom: 20 }}><Button variant={view === 'directory' ? 'primary' : 'secondary'} onClick={() => setView('directory')}>직원 목록</Button><Button variant={view === 'organization' ? 'primary' : 'secondary'} onClick={() => setView('organization')}>조직도</Button></div>
      {view === 'directory' ? <><div className="hr-toolbar"><Field label="직원 검색"><input type="search" placeholder="이름, 사번, 조직, 직책 검색" value={query} onChange={event => setQuery(event.target.value)} /></Field>
        <Field label="조직"><select value={departmentId} onChange={event => setDepartmentId(event.target.value)}><option value="all">모든 조직</option><option value="">미배정</option>{departments.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
        <Field label="재직 상태"><select value={status} onChange={event => setStatus(event.target.value)}><option value="all">모든 상태</option>{Object.entries(statusNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field></div>
        <p className="hr-muted" style={{ marginBottom: 12 }}>검색 결과 {filtered.length}명</p>
        {filtered.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>이름·사번</th><th>조직</th><th>직책</th><th>고용형태</th><th>상태</th><th>정보</th></tr></thead><tbody>{filtered.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.employeeNumber}</small></td><td>{departmentName(row.departmentId)}</td><td>{row.jobTitle || '—'}</td><td>{employmentNames[row.employmentType]}</td><td><span className={`hr-badge hr-status-${row.status}`}>{statusNames[row.status]}</span></td><td><Button variant="ghost" aria-label={`${row.name} 상세 정보`} onClick={() => setSelectedId(row.id)}>상세 보기</Button></td></tr>)}</tbody></table></div> : <HrEmpty title={w.employees.length ? '검색 결과가 없습니다' : '등록된 직원이 없습니다'}>{w.employees.length ? '다른 검색어나 필터를 선택해 주세요.' : '직원 등록에서 사번과 이름, 입사일을 입력해 시작하세요.'}</HrEmpty>}
      </> : <Organization {...props} />}
    </section>
    {selected && <HrDialog title="직원 상세" onClose={() => setSelectedId('')} busy={busy}><div className="hr-profile"><span className="hr-avatar">{selected.name.slice(0, 1)}</span><div><h2>{selected.name}</h2><p>{selected.employeeNumber} · {statusNames[selected.status]}</p></div></div>
      <dl className="hr-details"><div><dt>소속 조직</dt><dd>{departmentName(selected.departmentId)}</dd></div><div><dt>직책</dt><dd>{selected.jobTitle || '—'}</dd></div><div><dt>고용형태</dt><dd>{employmentNames[selected.employmentType]}</dd></div><div><dt>입사일</dt><dd>{hrDate(selected.hireDate)}</dd></div>
        {(permissions.manage || selected.id === props.employeeId) && <><div><dt>이메일</dt><dd>{selected.email || '미등록'}</dd></div><div><dt>연락처</dt><dd>{selected.phone || '미등록'}</dd></div><div><dt>로그인 계정 연결</dt><dd>{selected.actorId ? '연결됨' : '미연결'}</dd></div></>}
        {(permissions.payroll || selected.id === props.employeeId) && <div><dt>{selected.payType === 'hourly' ? '기본 시급' : '기본 월급'}</dt><dd>{selected.basePay.toLocaleString('ko-KR')}원</dd></div>}
        {selected.endDate && <div><dt>퇴직일</dt><dd>{hrDate(selected.endDate)}</dd></div>}
      </dl>
      {permissions.manage && <div className="hr-actions" style={{ marginBottom: 24 }}><Button disabled={busy} onClick={() => { setEditor(selected); setSelectedId(''); }}>정보 수정</Button>{selected.status !== 'retired' && <Button variant="secondary" disabled={busy} onClick={() => { setRetiring(selected); setSelectedId(''); }}>퇴직 처리</Button>}</div>}
      <h3 style={{ marginBottom: 14 }}>인사 변경 이력</h3>{selected.history.length ? <ol className="hr-list">{selected.history.slice().reverse().map((row, index) => <li key={`${row.at}-${index}`}><strong>{row.reason}</strong><p>{Object.keys(row.changes).map(key => fieldNames[key] || '기타 항목').join(' · ')}</p><small>적용일 {hrDate(row.effectiveDate)} · 기록일 {hrDate(row.at)}</small></li>)}</ol> : <HrEmpty title="조회 가능한 변경 이력이 없습니다" />}
    </HrDialog>}
    {editor && <EmployeeEditor {...props} employee={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />}
    {retiring && <HrDialog title={`${retiring.name} 퇴직 처리`} busy={busy} onClose={() => setRetiring(null)}><SaveForm busy={busy} submit="퇴직 처리" onCancel={() => setRetiring(null)} onSave={async form => { await props.mutate('employee.retire', { id: retiring.id, endDate: txt(form, 'endDate'), reason: txt(form, 'reason') }); setRetiring(null); }}><p className="hr-note">직원 기록은 유지되며 상태가 퇴직으로 변경됩니다. 퇴직일 당일 또는 이후에 처리할 수 있습니다.</p><Field label="퇴직일"><input type="date" name="endDate" required min={retiring.hireDate} max={hrToday()} defaultValue={hrToday()} /></Field><Field label="퇴직 처리 사유"><textarea name="reason" required maxLength={500} /></Field></SaveForm></HrDialog>}
  </>;
}

function EmployeeEditor({ employee, onClose, ...props }: Props & { employee?: HrEmployee; onClose: () => void }) {
  const { workspace: w, permissions, busy, mutate } = props;
  const accounts = props.accounts || [];
  return <HrDialog title={employee ? `${employee.name} 정보 수정` : '직원 등록'} busy={busy} onClose={onClose}><SaveForm busy={busy} onCancel={onClose} submit={employee ? '변경 저장' : '직원 등록'} onSave={async form => {
    const changes: Record<string, unknown> = Object.fromEntries(['employeeNumber', 'name', 'departmentId', 'jobTitle', 'employmentType', 'hireDate', 'email', 'phone', 'actorId'].map(key => [key, txt(form, key)]));
    if (permissions.payroll) { changes.payType = txt(form, 'payType'); changes.basePay = Number(txt(form, 'basePay')); }
    if (employee) { changes.status = txt(form, 'status'); if (employee.status === 'retired') changes.endDate = txt(form, 'endDate'); await mutate('employee.update', { id: employee.id, changes, effectiveDate: txt(form, 'effectiveDate'), reason: txt(form, 'reason') }); }
    else await mutate('employee.create', changes);
    onClose();
  }}><div className="hr-form-grid">
    <Field label="이름"><input name="name" required maxLength={100} defaultValue={employee?.name} data-dialog-initial /></Field><Field label="사번"><input name="employeeNumber" required maxLength={100} defaultValue={employee?.employeeNumber} /></Field>
    <Field label="소속 조직"><select name="departmentId" defaultValue={employee?.departmentId || ''}><option value="">미배정</option>{w.departments.filter(row => !row.archived || row.id === employee?.departmentId).map(row => <option key={row.id} value={row.id}>{row.name}{row.archived ? ' (보관됨)' : ''}</option>)}</select></Field>
    <Field label="직책"><input name="jobTitle" maxLength={120} defaultValue={employee?.jobTitle} /></Field>
    <Field label="고용형태"><select name="employmentType" defaultValue={employee?.employmentType || 'regular'}>{Object.entries(employmentNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
    <Field label="입사일"><input name="hireDate" type="date" required defaultValue={employee?.hireDate} /></Field>
    <Field label="이메일"><input name="email" type="email" maxLength={254} defaultValue={employee?.email} /></Field><Field label="연락처"><input name="phone" type="tel" maxLength={120} defaultValue={employee?.phone} /></Field>
    <Field label="로그인 계정 연결" wide><select name="actorId" defaultValue={employee?.actorId || ''}><option value="">연결하지 않음</option>{accounts.map(row => <option key={row.id} value={row.id}>{row.name}{row.id === props.actorId ? ' (내 계정)' : ''}</option>)}{employee?.actorId && !accounts.some(row => row.id === employee.actorId) && <option value={employee.actorId}>기존 연결 계정 유지</option>}</select></Field>
    {permissions.payroll && <><Field label="급여 기준"><select name="payType" defaultValue={employee?.payType || 'monthly'}><option value="monthly">월급</option><option value="hourly">시급</option></select></Field><Field label="기본급 (원)"><input type="number" name="basePay" required min={0} max={1_000_000_000} step={1} defaultValue={employee?.basePay ?? ''} /></Field></>}
    {employee && <><Field label="재직 상태"><select name="status" defaultValue={employee.status}><option value="active">재직</option><option value="leave">휴직</option>{employee.status === 'retired' && <option value="retired">퇴직</option>}</select></Field><Field label="변경 적용일"><input type="date" name="effectiveDate" required max={hrToday()} defaultValue={hrToday()} /></Field>{employee.status === 'retired' && <Field label="퇴직일"><input type="date" name="endDate" max={hrToday()} defaultValue={employee.endDate} /></Field>}<Field label="변경 사유" wide><textarea name="reason" required maxLength={500} /></Field></>}
  </div><p className="hr-note">로그인 계정을 연결하면 해당 직원이 본인의 근무·휴가·급여를 조회할 수 있습니다. 변경 적용일은 오늘 또는 과거 날짜를 입력하세요.</p></SaveForm></HrDialog>;
}

function Organization(props: Props) {
  const { workspace: w, permissions, busy, mutate } = props;
  const [editing, setEditing] = useState<HrDepartment | 'new' | null>(null);
  const [archive, setArchive] = useState<HrDepartment | null>(null);
  const rows = w.departments.filter(row => !row.archived);
  function renderRows(parentId: string | undefined, depth = 0, seen = new Set<string>()): ReactNode {
    return rows.filter(row => (row.parentId || undefined) === parentId).map(row => {
      if (seen.has(row.id)) return null;
      const visited = new Set(seen); visited.add(row.id);
      return <div key={row.id}><div className="hr-org-node" style={{ '--hr-depth': Math.min(depth, 5) } as CSSProperties}><article className="hr-org-row"><div><strong>{row.name}</strong><p>조직장 {person(w.employees, row.leaderId)} · 소속 {w.employees.filter(employee => employee.departmentId === row.id && employee.status !== 'retired').length}명</p></div>{permissions.manage && <div className="hr-actions"><Button variant="secondary" disabled={busy} onClick={() => setEditing(row)}>수정</Button><Button variant="ghost" disabled={busy} onClick={() => setArchive(row)}>보관</Button></div>}</article></div>{renderRows(row.id, depth + 1, visited)}</div>;
    });
  }
  const current = editing && editing !== 'new' ? editing : undefined;
  return <><div className="hr-section-heading"><p className="hr-muted">상위 조직과 조직장을 지정해 조직도를 구성합니다.</p>{permissions.manage && <Button variant="secondary" disabled={busy} onClick={() => setEditing('new')}><Plus size={16} /> 조직 추가</Button>}</div>
    {rows.length ? renderRows(undefined) : <HrEmpty title="등록된 조직이 없습니다">조직을 추가한 뒤 직원에게 소속을 지정해 주세요.</HrEmpty>}
    {editing && <HrDialog title={current ? '조직 수정' : '조직 추가'} busy={busy} onClose={() => setEditing(null)}><SaveForm busy={busy} onCancel={() => setEditing(null)} onSave={async form => { await mutate('department.upsert', { ...(current ? { id: current.id } : {}), name: txt(form, 'name'), parentId: txt(form, 'parentId'), leaderId: txt(form, 'leaderId') }); setEditing(null); }}><Field label="조직 이름"><input name="name" required maxLength={100} defaultValue={current?.name} /></Field><Field label="상위 조직"><select name="parentId" defaultValue={current?.parentId || ''}><option value="">최상위 조직</option>{rows.filter(row => row.id !== current?.id).map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></Field><Field label="조직장"><select name="leaderId" defaultValue={current?.leaderId || ''}><option value="">미지정</option>{w.employees.filter(row => row.status === 'active').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field></SaveForm></HrDialog>}
    {archive && <Confirm title="조직 보관" body={`${archive.name} 조직을 보관합니다. 소속 구성원과 하위 조직이 있으면 먼저 다른 조직으로 이동해야 합니다.`} busy={busy} onClose={() => setArchive(null)} onConfirm={() => mutate('department.archive', { id: archive.id })} />}
  </>;
}

function Notices(props: Props) {
  const { workspace: w, permissions, busy, mutate } = props;
  const [editing, setEditing] = useState<HrNotice | 'new' | null>(null);
  const [archive, setArchive] = useState<HrNotice | null>(null);
  const [expanded, setExpanded] = useState('');
  const notices = w.notices.filter(row => row.status !== 'archived').sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const current = editing && editing !== 'new' ? editing : undefined;
  return <section className="hr-card"><div className="hr-section-heading"><div><h2>공지사항</h2><p>구성원에게 필요한 소식과 안내를 공유합니다.</p></div>{permissions.manage && <Button variant="secondary" disabled={busy} onClick={() => setEditing('new')}><Plus size={16} /> 공지 작성</Button>}</div>
    {notices.length ? <div className="hr-list">{notices.map(row => <article key={row.id}><div className="hr-section-heading"><div><h3>{row.pinned && <span className="hr-badge">고정</span>} {row.title}</h3><small>{hrDate(row.updatedAt)} · {row.status === 'draft' ? '임시 저장' : '게시됨'}</small></div><Button variant="ghost" onClick={() => setExpanded(expanded === row.id ? '' : row.id)} aria-expanded={expanded === row.id}>{expanded === row.id ? '접기' : '내용 보기'}</Button></div>{expanded === row.id && <div className="hr-prose">{row.body}</div>}{permissions.manage && <div className="hr-actions"><Button variant="ghost" disabled={busy} onClick={() => setEditing(row)}>수정</Button><Button variant="ghost" disabled={busy} onClick={() => setArchive(row)}>보관</Button></div>}</article>)}</div> : <HrEmpty title="등록된 공지가 없습니다" />}
    {editing && <HrDialog title={current ? '공지 수정' : '공지 작성'} busy={busy} onClose={() => setEditing(null)}><SaveForm busy={busy} onCancel={() => setEditing(null)} submit="공지 저장" onSave={async form => { await mutate(current ? 'notice.update' : 'notice.create', { ...(current ? { id: current.id } : {}), title: txt(form, 'title'), body: txt(form, 'body'), pinned: form.get('pinned') === 'on', status: txt(form, 'status') }); setEditing(null); }}><Field label="제목"><input name="title" required maxLength={200} defaultValue={current?.title} /></Field><Field label="내용"><textarea name="body" required rows={8} maxLength={20000} defaultValue={current?.body} /></Field><Field label="공개 상태"><select name="status" defaultValue={current?.status || 'draft'}><option value="draft">임시 저장 · 관리자만 조회</option><option value="published">구성원에게 게시</option></select></Field><label className="hr-check"><input name="pinned" type="checkbox" defaultChecked={current?.pinned} />목록 상단에 고정</label></SaveForm></HrDialog>}
    {archive && <Confirm title="공지 보관" body={`“${archive.title}” 공지를 목록에서 보관합니다. 구성원에게는 더 이상 표시되지 않습니다.`} busy={busy} onClose={() => setArchive(null)} onConfirm={() => mutate('notice.archive', { id: archive.id })} />}
  </section>;
}

function Documents(props: Props) {
  const { workspace: w, permissions, busy, mutate } = props;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [editing, setEditing] = useState<HrDocument | 'new' | null>(null);
  const [selected, setSelected] = useState<HrDocument | null>(null);
  const [archive, setArchive] = useState<HrDocument | null>(null);
  const docs = w.documents.filter(row => row.status === 'active' && (category === 'all' || row.category === category) && row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const current = editing && editing !== 'new' ? editing : undefined;
  return <section className="hr-card"><div className="hr-section-heading"><div><h2>문서함</h2><p>직원별 문서와 회사 규정을 작성하고 보관합니다.</p></div>{permissions.manage && <Button disabled={busy} onClick={() => setEditing('new')}><Plus size={16} /> 문서 작성</Button>}</div>
    <div className="hr-toolbar"><Field label="문서 검색"><input type="search" placeholder="문서 제목 검색" value={query} onChange={event => setQuery(event.target.value)} /></Field><Field label="문서 유형"><select value={category} onChange={event => setCategory(event.target.value)}><option value="all">모든 유형</option>{Object.entries(categoryNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field></div>
    {docs.length ? <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>문서</th><th>유형</th><th>대상</th><th>수정일</th><th>보기</th></tr></thead><tbody>{docs.map(row => <tr key={row.id}><td><strong>{row.title}</strong></td><td>{categoryNames[row.category]}</td><td>{row.employeeId ? person(w.employees, row.employeeId) : '전체 구성원'}</td><td>{hrDate(row.updatedAt)}</td><td><Button variant="ghost" onClick={() => setSelected(row)} aria-label={`${row.title} 문서 열기`}>열기</Button></td></tr>)}</tbody></table></div> : <HrEmpty title="조회할 문서가 없습니다">개인 문서는 지정된 직원과 관리자에게 표시됩니다.</HrEmpty>}
    {selected && <HrDialog title={selected.title} busy={busy} onClose={() => setSelected(null)}><p className="hr-muted" style={{ marginBottom: 20 }}>{categoryNames[selected.category]} · {selected.employeeId ? person(w.employees, selected.employeeId) : '전체 구성원'} · {hrDate(selected.updatedAt)}</p><div className="hr-prose">{selected.body}</div><div className="hr-actions" style={{ marginTop: 24 }}><Button variant="secondary" onClick={() => downloadText(`${selected.title.replace(/[\\/:*?"<>|]/g, '_')}.txt`, selected.body)}>내용 내려받기</Button>{permissions.manage && <><Button disabled={busy} onClick={() => { setEditing(selected); setSelected(null); }}>수정</Button><Button variant="ghost" disabled={busy} onClick={() => { setArchive(selected); setSelected(null); }}>보관</Button></>}</div></HrDialog>}
    {editing && <DocumentEditor {...props} document={current} onClose={() => setEditing(null)} />}
    {archive && <Confirm title="문서 보관" body={`“${archive.title}” 문서를 보관합니다. 직원의 문서함에서 더 이상 표시되지 않습니다.`} busy={busy} onClose={() => setArchive(null)} onConfirm={() => mutate('document.archive', { id: archive.id })} />}
  </section>;
}

function DocumentEditor({ document: current, onClose, ...props }: Props & { document?: HrDocument; onClose: () => void }) {
  const [category, setCategory] = useState(current?.category || 'other');
  return <HrDialog title={current ? '문서 수정' : '문서 작성'} busy={props.busy} onClose={onClose}><SaveForm busy={props.busy} onCancel={onClose} submit="문서 저장" onSave={async form => { await props.mutate(current ? 'document.update' : 'document.create', { ...(current ? { id: current.id } : {}), title: txt(form, 'title'), category, employeeId: txt(form, 'employeeId'), body: txt(form, 'body') }); onClose(); }}><Field label="문서 제목"><input name="title" required maxLength={200} defaultValue={current?.title} /></Field><div className="hr-form-grid"><Field label="유형"><select name="category" value={category} onChange={event => setCategory(event.target.value as HrDocument['category'])}>{Object.entries(categoryNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field><Field label="대상 구성원"><select name="employeeId" required={category !== 'policy'} defaultValue={current?.employeeId || ''}><option value="">{category === 'policy' ? '전체 구성원' : '구성원 선택'}</option>{props.workspace.employees.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field></div><Field label="문서 내용"><textarea name="body" required rows={12} maxLength={30000} defaultValue={current?.body} /></Field><p className="hr-note">회사 규정은 대상 구성원을 선택하지 않으면 전체에 공개됩니다. 개인 계약서·증명서·기타 문서는 대상 직원에게만 공개됩니다.</p></SaveForm></HrDialog>;
}

function Settings(props: Props) {
  const { workspace: w, permissions, busy, mutate } = props;
  if (!permissions.manage) return <section className="hr-card"><h2 style={{ marginBottom: 20 }}>인사 설정</h2><dl className="hr-details"><div><dt>회사·매장 이름</dt><dd>{w.settings.companyName}</dd></div><div><dt>시간 기준</dt><dd>대한민국 · 서울</dd></div><div><dt>하루 기준 근무시간</dt><dd>{w.settings.workdayHours}시간</dd></div><div><dt>주 근무일</dt><dd>{w.settings.weeklyDays}일</dd></div></dl><p className="hr-note">인사 설정은 관리자에게 변경을 요청해 주세요.</p></section>;
  return <section className="hr-card"><div className="hr-section-heading"><div><h2>인사 설정</h2><p>매장별 인사 기준과 안내용 담당자를 관리합니다.</p></div></div><SaveForm busy={busy} onSave={async form => mutate('settings.update', { companyName: txt(form, 'companyName'), workdayHours: Number(txt(form, 'workdayHours')), weeklyDays: Number(txt(form, 'weeklyDays')), annualLeaveDays: Number(txt(form, 'annualLeaveDays')), approvalEmployeeId: txt(form, 'approvalEmployeeId'), timezone: 'Asia/Seoul', reason: txt(form, 'reason') })}><div className="hr-form-grid"><Field label="회사·매장 이름"><input name="companyName" required maxLength={100} defaultValue={w.settings.companyName} /></Field><Field label="하루 기준 근무시간"><input name="workdayHours" type="number" min={1} max={24} step={0.5} required defaultValue={w.settings.workdayHours} /></Field><Field label="주 근무일"><input name="weeklyDays" type="number" min={1} max={7} step={1} required defaultValue={w.settings.weeklyDays} /></Field><Field label="기본 연차 일수"><input name="annualLeaveDays" type="number" min={0} max={366} step={0.5} required defaultValue={w.settings.annualLeaveDays} /></Field><Field label="안내용 담당자"><select name="approvalEmployeeId" defaultValue={w.settings.approvalEmployeeId || ''}><option value="">미지정</option>{w.employees.filter(row => row.status === 'active').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field label="시간 기준"><input readOnly value="대한민국 · 서울 (UTC+9)" /></Field><Field label="변경 메모" wide><textarea name="reason" maxLength={500} /></Field></div><p className="hr-note">안내용 담당자는 승인 권한이나 결재선에 자동 적용되지 않습니다. 기본 연차 일수를 바꿔도 기존 휴가 잔액은 자동으로 변경되지 않습니다. 근무 정책·휴가 발생·급여 정산은 각 메뉴에서 확인하고 적용해 주세요.</p></SaveForm></section>;
}

function Help({ onTabChange }: { onTabChange: (tab: HrTab) => void }) {
  const steps: Array<{ title: string; text: string; tab: HrTab; action: string }> = [
    { title: '조직과 직원 등록', text: '직원·조직에서 조직을 추가하고 직원의 사번, 이름, 입사일을 등록하세요. 로그인 계정을 연결하면 직원이 본인의 정보를 이용할 수 있습니다.', tab: 'people', action: '직원·조직 열기' },
    { title: '매장의 근무 기준 설정', text: '근무 기록에서 근무 정책을 만들고 직원에게 적용합니다. 근무 일정을 등록한 뒤 실제 출퇴근 기록을 확인하고 승인하세요.', tab: 'attendance', action: '근무 기록 열기' },
    { title: '휴가 종류와 잔액 준비', text: '관리자는 휴가 유형과 발생 내역을 준비합니다. 직원은 사용할 날짜와 시간을 신청하고, 담당자는 승인이나 반려 사유를 남깁니다.', tab: 'leave', action: '휴가 열기' },
    { title: '결재와 비용 처리', text: '전자결재에서 양식과 승인 단계를 설정합니다. 구성원은 문서를 작성해 제출하고 비용 청구에 증빙의 보관 위치와 금액을 기록합니다. 원본 파일은 월 손익·정산에서 보관하세요.', tab: 'approvals', action: '전자결재 열기' },
    { title: '급여 정산과 명세서', text: '급여 권한을 가진 담당자가 정산을 만들고 근무·지급 항목과 공제액을 확인합니다. 확정·공개된 명세서는 연결된 직원 계정으로 조회합니다.', tab: 'payroll', action: '급여 열기' },
    { title: '성장과 소통', text: '목표와 달성도를 기록하고 평가를 진행합니다. 미팅에서 공유 메모와 본인만 보는 메모를 구분하고 후속 할 일을 관리하세요.', tab: 'goals', action: '목표 열기' },
    { title: '문서와 공지 공유', text: '문서함의 개인 문서는 해당 직원에게, 대상을 지정하지 않은 규정은 전체 구성원에게 공개됩니다. 홈의 공지는 임시 저장 또는 게시 상태로 관리합니다.', tab: 'documents', action: '문서함 열기' },
  ];
  return <><section className="hr-card"><div className="hr-section-heading"><div><h2>인사관리 시작하기</h2><p>현재 ODA 인사관리 화면을 사용하는 순서입니다.</p></div></div>{steps.map((step, index) => <article className="hr-help-step" key={step.tab}><span className="hr-help-number">{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p><Button variant="secondary" onClick={() => onTabChange(step.tab)}>{step.action}</Button></div></article>)}</section><section className="hr-card"><h2 style={{ marginBottom: 18 }}>지원 범위와 자주 묻는 질문</h2><p className="hr-note" style={{ marginBottom: 18 }}>직원·조직, 근무·휴가 승인, 결재, 급여 정산, 목표·평가, 미팅, 채용 단계와 계약 기록을 관리합니다. 외부 전자서명, 세무 신고, 보험 가입, 미팅 음성 요약은 연결되어 있지 않습니다. 계약 완료에는 외부에서 체결한 근거를 기록하고, 세금·보험 공제액은 검토한 금액을 입력하세요.</p><div className="hr-list"><article><h3>저장이 충돌하면 어떻게 하나요?</h3><p>다른 변경이 먼저 저장되면 최신 데이터를 불러옵니다. 입력한 내용은 유지되므로 변경된 정보를 확인한 뒤 다시 저장하세요.</p></article><article><h3>매장을 바꾸면 어떤 정보가 보이나요?</h3><p>화면 상단에서 배정된 매장을 선택합니다. 직원, 정책, 결재와 급여 정보는 선택한 매장별로 관리됩니다.</p></article><article><h3>개인 정보가 보이지 않아요.</h3><p>계정과 연결된 직원 정보, 관리자·급여 담당 권한에 따라 조회 범위가 달라집니다. 계정 관리자에게 배정과 권한을 확인해 주세요.</p></article><article><h3>기존 월 손익·정산과 연결되어 있나요?</h3><p>급여에서 월 인건비 반영을 선택하면 확정한 급여와 사업주 보험 부담액의 합계를 기존 월 손익·정산에 반영할 수 있습니다. 비용 청구의 원본 증빙은 월 손익·정산에서 별도로 관리합니다.</p></article></div></section></>;
}
