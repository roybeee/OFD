import { useId, useState } from 'react';
import type { HrResponse } from '../api/oda-hr-client';
import { canHrApprove } from '../../../../packages/domain/src/oda-hr-workflow';
import { Check, ChevronRight, Search, X } from '../components/icons';
import type { StaffPersonalTab } from '../pages/OdaStaffPage';
import { hrToday } from './shared';

export type StaffTaskItem = {
  id: string;
  title: string;
  category: string;
  status: string;
  date: string;
  detail: string;
  tab: StaffPersonalTab;
};
export type StaffTaskGroups = { todo: StaffTaskItem[]; requested: StaffTaskItem[]; reference: StaffTaskItem[] };

const statusNames: Record<string, string> = {
  draft: '작성 중', pending: '승인 대기', approved: '승인 완료', rejected: '반려',
  cancelled: '취소', withdrawn: '회수', submitted: '검토 대기', reviewed: '검토 완료',
};

/** Uses the same current-step and delegation rules as the server. Never infers an approval from read access. */
export function deriveStaffTasks(response: HrResponse | null, actorId: string, today: string): StaffTaskGroups {
  const groups: StaffTaskGroups = { todo: [], requested: [], reference: [] };
  if (!response || !actorId) return groups;
  const { workspace, permissions, employeeId } = response;
  const context = { actorId, employeeId, manager: permissions.manage, payroll: permissions.payroll, today, now: `${today}T00:00:00+09:00`, id: () => '' };
  const mayAct = permissions.manage || permissions.self;
  for (const request of workspace.workflow.requests) {
    const item: StaffTaskItem = {
      id: `workflow:${request.id}`, title: request.title, category: '결재',
      status: statusNames[request.status] ?? request.status, date: request.submittedAt || request.createdAt,
      detail: request.status === 'pending' ? `${request.currentStep + 1}단계 결재 진행 중` : request.category, tab: 'approvals',
    };
    const actionable = mayAct && canHrApprove(request, workspace.workflow, context);
    if (actionable) groups.todo.push({ ...item, status: '내 승인 필요' });
    if (request.authorId === actorId) groups.requested.push(item);
    // There is no CC assignment in the workflow model. The reference tab is explicitly an approval-chain history.
    if (!actionable && request.authorId !== actorId && request.status !== 'draft'
      && (request.steps.some(step => step.approverIds.includes(actorId)) || request.decisions.some(decision => decision.actorId === actorId))) {
      groups.reference.push(item);
    }
  }
  for (const expense of workspace.workflow.expenses) {
    if (expense.authorId !== actorId) continue;
    groups.requested.push({ id: `expense:${expense.id}`, title: expense.title, category: '비용',
      status: statusNames[expense.status] ?? expense.status, date: expense.date,
      detail: `${expense.amount.toLocaleString('ko-KR')}원 · ${expense.category}`, tab: 'expenses' });
  }
  if (employeeId) {
    for (const leave of workspace.attendance.leaveRequests) {
      if (leave.employeeId !== employeeId) continue;
      const leaveType = workspace.attendance.leaveTypes.find(type => type.id === leave.typeId)?.name || '휴가';
      groups.requested.push({ id: `leave:${leave.id}`, title: `${leaveType} 신청`, category: '휴가',
        status: statusNames[leave.status] ?? leave.status, date: leave.createdAt,
        detail: leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} ~ ${leave.endDate}`, tab: 'leave' });
    }
    for (const work of workspace.attendance.workEntries) {
      if (work.employeeId !== employeeId || work.source !== 'manual') continue;
      groups.requested.push({ id: `work:${work.id}`, title: '근무 등록·정정 신청', category: '근무',
        status: statusNames[work.status] ?? work.status, date: work.createdAt,
        detail: `${work.date} · ${work.startTime} ~ ${work.endDate !== work.date ? `${work.endDate} ` : ''}${work.endTime}`, tab: 'attendance' });
    }
    if (mayAct) {
      for (const meeting of workspace.talent.meetings) {
        if (!meeting.participantEmployeeIds.includes(employeeId) && !permissions.manage) continue;
        for (const task of meeting.tasks) {
          if (task.completed || task.assigneeEmployeeId !== employeeId) continue;
          groups.todo.push({ id: `meeting:${meeting.id}:${task.id}`, title: task.title, category: '미팅',
            status: '진행 중', date: meeting.scheduledDate, detail: meeting.title, tab: 'meetings' });
        }
      }
      for (const cycle of workspace.talent.reviews) {
        if (cycle.status !== 'open' || today < cycle.startDate || today > cycle.dueDate) continue;
        for (const assignment of cycle.assignments) {
          if (assignment.reviewerEmployeeId !== employeeId || assignment.status !== 'draft') continue;
          const employee = workspace.employees.find(row => row.id === assignment.employeeId);
          groups.todo.push({ id: `review:${cycle.id}:${assignment.id}`, title: cycle.title, category: '평가',
            status: '작성 필요', date: cycle.dueDate, detail: `${employee?.name || '평가 대상자'} · ${cycle.dueDate}까지`, tab: 'reviews' });
        }
      }
    }
  }
  groups.todo.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const rows of [groups.requested, groups.reference]) rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return groups;
}

type Props = {
  response: HrResponse | null;
  actorId: string;
  busy: boolean;
  onOpenPersonal: (tab: StaffPersonalTab) => void;
};
const taskTabs = [['todo', '해야할 일'], ['requested', '요청한 일'], ['reference', '참조']] as const;
const emptyText = {
  todo: ['아직 요청받은 할 일이 없어요.', '내 승인이 필요한 결재와 미팅 할 일, 작성할 평가가 이곳에 쌓입니다.'],
  requested: ['아직 요청한 일이 없어요.', '근무·휴가 신청과 결재·비용 요청의 진행 상태를 확인할 수 있어요.'],
  reference: ['참고할 결재 문서가 없어요.', '결재선에 포함된 문서 중 다음 단계를 기다리거나 처리가 끝난 문서를 확인할 수 있어요.'],
} as const;

export function HrStaffTasks({ response, actorId, busy, onOpenPersonal }: Props) {
  const [tab, setTab] = useState<keyof StaffTaskGroups>('todo');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const id = useId();
  const groups = deriveStaffTasks(response, actorId, hrToday());
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  const rows = groups[tab].filter(row => !needle || `${row.title} ${row.category} ${row.status} ${row.detail}`.toLocaleLowerCase('ko-KR').includes(needle));
  const mayWrite = Boolean(response && (response.permissions.manage || response.permissions.self));
  return <section className="staff-tasks" aria-labelledby={`${id}-heading`}>
    <header className="staff-app-heading">
      <h1 id={`${id}-heading`}>할 일</h1>
      <div className="staff-heading-actions">
        <button className="staff-icon-button" type="button" aria-label={searchOpen ? '할 일 검색 닫기' : '할 일 검색'} aria-expanded={searchOpen} aria-controls={`${id}-search`} onClick={() => { setSearchOpen(value => !value); setQuery(''); }}>
          {searchOpen ? <X size={23} aria-hidden="true" /> : <Search size={23} aria-hidden="true" />}
        </button>
        <button className="staff-icon-button" type="button" aria-label="새 결재 요청" disabled={busy || !mayWrite} onClick={() => onOpenPersonal('approvals')}>
          <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6ZM3 23h18" /></svg>
        </button>
      </div>
    </header>
    {searchOpen && <div className="staff-task-search" id={`${id}-search`} role="search">
      <Search size={19} aria-hidden="true" /><input type="search" aria-label="할 일 검색어" placeholder="제목, 분류, 상태 검색" value={query} onChange={event => setQuery(event.target.value)} autoFocus />
    </div>}
    <div className="staff-task-tabs" role="tablist" aria-label="할 일 구분">
      {taskTabs.map(([value, label], index) => <button type="button" key={value} role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % taskTabs.length : event.key === 'ArrowLeft' ? (index + taskTabs.length - 1) % taskTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? taskTabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(taskTabs[next]![0]);
        (event.currentTarget.parentElement?.querySelectorAll('button')[next] as HTMLButtonElement | undefined)?.focus();
      }}>{label}{groups[value].length > 0 && <span className="staff-task-count">{groups[value].length}</span>}</button>)}
    </div>
    <div className="staff-task-panel" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={!response && busy}>
      {!response ? <div className="staff-task-empty" role="status"><p>{busy ? '할 일을 불러오고 있어요.' : '매장 정보를 불러온 뒤 할 일을 확인할 수 있어요.'}</p></div>
        : rows.length ? <>
          {tab === 'reference' && <p className="staff-task-context">결재선에 포함된 문서의 진행 상태를 확인하세요.</p>}
          <ul className="staff-task-list">{rows.map(row => <li key={row.id}><button type="button" className="staff-task-row" disabled={busy} onClick={() => onOpenPersonal(row.tab)}>
            <span className="staff-task-row-body"><span className="staff-task-meta"><span>{row.category}</span><span>{row.status}</span></span><strong>{row.title}</strong><span className="staff-task-detail">{row.detail}</span></span>
            <ChevronRight size={18} aria-hidden="true" />
          </button></li>)}</ul>
        </> : <div className="staff-task-empty">
          <span className="staff-task-empty-icon"><Check size={44} aria-hidden="true" /></span>
          <h2>{needle ? '검색 결과가 없어요.' : emptyText[tab][0]}</h2>
          <p>{needle ? '다른 검색어로 다시 찾아보세요.' : emptyText[tab][1]}</p>
        </div>}
    </div>
  </section>;
}
