import { invariant } from './errors.js';
import type { HrCommand, HrContext, HrWorkspace } from './oda-hr.ts';

export interface HrGoal {
  id: string; employeeId: string; title: string; description: string; dueDate: string;
  progress: number; status: 'active' | 'completed'; visibility: 'company' | 'private';
  createdAt: string; updatedAt: string;
}
export interface HrReviewAnswer { question: string; score: number; comment: string }
export interface HrReviewAssignment {
  id: string; employeeId: string; reviewerEmployeeId: string;
  status: 'draft' | 'submitted'; answers: HrReviewAnswer[]; submittedAt: string | null;
}
export interface HrReviewReport {
  employeeId: string; averageScore: number; responseCount: number; summary: string;
  sharedAt: string | null; revokedAt: string | null;
}
export interface HrReviewCycle {
  id: string; title: string; startDate: string; dueDate: string; questions: string[];
  status: 'draft' | 'open' | 'closed'; assignments: HrReviewAssignment[];
  reports: HrReviewReport[]; createdAt: string;
}
export interface HrMeetingTask { id: string; title: string; assigneeEmployeeId: string; completed: boolean }
export interface HrMeeting {
  id: string; title: string; hostActorId: string; participantEmployeeIds: string[];
  scheduledDate: string; notes: string; privateNotes: Record<string, string>;
  tasks: HrMeetingTask[]; createdAt: string; updatedAt: string;
}
export interface HrRecruitmentJob {
  id: string; title: string; description: string; status: 'draft' | 'open' | 'closed'; createdAt: string;
}
export type HrCandidateStage = 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
export interface HrCandidate {
  id: string; jobId: string; name: string; email: string; note: string; stage: HrCandidateStage;
  previousStage: HrCandidateStage | null;
  history: { from: HrCandidateStage | null; to: HrCandidateStage; at: string; actorId: string }[];
}
export interface HrContractTerms {
  employmentType: 'regular' | 'contract' | 'part_time'; jobTitle: string;
  effectiveDate: string; endDate: string; payType: 'monthly' | 'hourly'; basePay: number | null;
}
export interface HrContract {
  id: string; employeeId: string; title: string; body: string; terms: HrContractTerms;
  status: 'draft' | 'completed' | 'cancelled'; completionKind: 'external_record' | null;
  completionReference: string; completedAt: string | null; createdAt: string;
  appliedAt: string | null; appliedBy: string | null;
  personnelBefore: { employmentType: string; jobTitle: string; endDate: string; payType: string; basePay: number | null } | null;
}
export interface HrTalentState {
  goals: HrGoal[]; reviews: HrReviewCycle[]; meetings: HrMeeting[];
  jobs: HrRecruitmentJob[]; candidates: HrCandidate[]; contracts: HrContract[];
}
export function createHrTalentState(): HrTalentState {
  return { goals: [], reviews: [], meetings: [], jobs: [], candidates: [], contracts: [] };
}

const own = (input: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(input, key);
function text(input: Record<string, unknown>, key: string, max = 100, optional = false): string {
  const value = input[key];
  invariant(typeof value === 'string' || (optional && value === undefined), 'HR_INVALID', `${key} 값을 확인해 주세요.`);
  const result = typeof value === 'string' ? value.trim() : '';
  invariant((optional || result.length > 0) && result.length <= max, 'HR_INVALID', `${key}는 ${max}자 이내로 입력해 주세요.`);
  return result;
}
function date(input: Record<string, unknown>, key: string, optional = false): string {
  const value = text(input, key, 10, optional);
  if (!value && optional) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, 'HR_INVALID', '날짜를 확인해 주세요.');
  return value;
}
function number(input: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = input[key];
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'HR_INVALID', `${key} 범위를 확인해 주세요.`);
  return value;
}
function option<T extends string>(input: Record<string, unknown>, key: string, choices: readonly T[]): T {
  const value = text(input, key);
  invariant(choices.includes(value as T), 'HR_INVALID', `${key} 선택을 확인해 주세요.`);
  return value as T;
}
function item<T extends { id: string }>(rows: T[], input: Record<string, unknown>): T {
  const value = rows.find(row => row.id === input.id);
  invariant(value, 'HR_NOT_FOUND', '해당 항목을 찾을 수 없습니다.', 404);
  return value;
}
function manage(ctx: HrContext): void { invariant(ctx.manager, 'HR_FORBIDDEN', '관리 권한이 필요합니다.', 403); }
function employee(workspace: HrWorkspace, id: string, active = true) {
  const value = workspace.employees.find(row => row.id === id);
  invariant(value && (!active || value.status === 'active'), 'HR_INVALID', '재직 중인 구성원을 선택해 주세요.');
  return value;
}
function participant(meeting: HrMeeting, ctx: Pick<HrContext, 'actorId' | 'employeeId'>): boolean {
  return Boolean(ctx.employeeId && meeting.participantEmployeeIds.includes(ctx.employeeId));
}
function ids(workspace: HrWorkspace, input: Record<string, unknown>, key: string): string[] {
  invariant(Array.isArray(input[key]) && (input[key] as unknown[]).length <= 200, 'HR_INVALID', '구성원 목록을 확인해 주세요.');
  const result = [...new Set(input[key] as unknown[])];
  invariant(result.length > 0 && result.every(v => typeof v === 'string'), 'HR_INVALID', '구성원을 선택해 주세요.');
  for (const id of result as string[]) employee(workspace, id);
  return result as string[];
}
function reviewOpen(cycle: HrReviewCycle, ctx: HrContext): void {
  invariant(cycle.status === 'open' && ctx.today >= cycle.startDate && ctx.today <= cycle.dueDate,
    'HR_LOCKED', '평가 작성 기간이 아닙니다.', 409);
}
function contractTerms(workspace: HrWorkspace, input: Record<string, unknown>, ctx: HrContext, employeeId: string): HrContractTerms {
  const member = employee(workspace, employeeId);
  const basePay = own(input, 'basePay') && input.basePay !== null ? number(input, 'basePay', 0, 1_000_000_000) : null;
  if (basePay !== null) {
    invariant(ctx.payroll, 'HR_FORBIDDEN', '급여 변경 권한이 필요합니다.', 403);
    invariant(Number.isSafeInteger(basePay), 'HR_INVALID', '급여 금액은 원 단위 정수로 입력해 주세요.');
  }
  const effectiveDate = date(input, 'effectiveDate');
  const endDate = date(input, 'endDate', true);
  invariant(effectiveDate >= member.hireDate && (!endDate || endDate >= effectiveDate), 'HR_INVALID', '계약 적용일과 종료일을 확인해 주세요.');
  return { employmentType: option(input, 'employmentType', ['regular', 'contract', 'part_time']),
    jobTitle: text(input, 'jobTitle', 100, true), effectiveDate, endDate,
    payType: basePay === null ? member.payType : option(input, 'payType', ['monthly', 'hourly']), basePay };
}

/** Only the actor's private notes are returned, including for the highest administrator. */
export function projectHrTalentState(state: HrTalentState, ctx: Pick<HrContext, 'actorId' | 'employeeId' | 'manager' | 'payroll'>): HrTalentState {
  const result = structuredClone(state);
  result.goals = result.goals.filter(goal => ctx.manager || goal.visibility === 'company' || goal.employeeId === ctx.employeeId);
  result.meetings = result.meetings.filter(meeting => participant(meeting, ctx)).map(meeting => ({
    ...meeting, privateNotes: Object.prototype.hasOwnProperty.call(meeting.privateNotes, ctx.actorId)
      ? { [ctx.actorId]: meeting.privateNotes[ctx.actorId]! } : {},
  }));
  if (!ctx.manager) {
    result.reviews = result.reviews.map(cycle => ({ ...cycle,
      assignments: cycle.assignments.filter(row => row.reviewerEmployeeId === ctx.employeeId && cycle.status !== 'draft'),
      reports: cycle.reports.filter(report => report.employeeId === ctx.employeeId && report.sharedAt !== null),
    })).filter(cycle => cycle.assignments.length > 0 || cycle.reports.length > 0);
    result.jobs = []; result.candidates = [];
    result.contracts = result.contracts.filter(contract => contract.employeeId === ctx.employeeId && contract.status === 'completed');
  }
  result.contracts = result.contracts.filter(contract => ctx.payroll || contract.employeeId === ctx.employeeId || contract.terms.basePay === null).map(contract => {
    if (ctx.payroll || contract.employeeId === ctx.employeeId) return contract;
    return { ...contract, terms: { ...contract.terms, basePay: null },
      personnelBefore: contract.personnelBefore ? { ...contract.personnelBefore, basePay: null } : null };
  });
  return result;
}

export function applyHrTalentCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  const s = workspace.talent, p = command.input;
  switch (command.type) {
    case 'goal.create': {
      const employeeId = text(p, 'employeeId'); employee(workspace, employeeId);
      invariant(ctx.manager || ctx.employeeId === employeeId, 'HR_FORBIDDEN', '본인 목표만 작성할 수 있습니다.', 403);
      const goal: HrGoal = { id: ctx.id(), employeeId, title: text(p, 'title'), description: text(p, 'description', 10000, true),
        dueDate: date(p, 'dueDate'), progress: 0, status: 'active', visibility: option(p, 'visibility', ['company', 'private']), createdAt: ctx.now, updatedAt: ctx.now };
      s.goals.push(goal); return true;
    }
    case 'goal.update': {
      const goal = item(s.goals, p);
      invariant(ctx.manager || goal.employeeId === ctx.employeeId, 'HR_FORBIDDEN', '목표 수정 권한이 없습니다.', 403);
      invariant(goal.status === 'active', 'HR_LOCKED', '완료된 목표를 다시 열어 주세요.', 409);
      const values = { title: own(p, 'title') ? text(p, 'title') : goal.title,
        description: own(p, 'description') ? text(p, 'description', 10000, true) : goal.description,
        dueDate: own(p, 'dueDate') ? date(p, 'dueDate') : goal.dueDate,
        progress: own(p, 'progress') ? number(p, 'progress', 0, 100) : goal.progress,
        visibility: own(p, 'visibility') ? option(p, 'visibility', ['company', 'private']) : goal.visibility };
      Object.assign(goal, values, { updatedAt: ctx.now }); return true;
    }
    case 'goal.complete': case 'goal.reopen': case 'goal.delete': {
      const goal = item(s.goals, p);
      invariant(ctx.manager || goal.employeeId === ctx.employeeId, 'HR_FORBIDDEN', '목표 변경 권한이 없습니다.', 403);
      if (command.type === 'goal.delete') s.goals = s.goals.filter(row => row.id !== goal.id);
      else { goal.status = command.type === 'goal.complete' ? 'completed' : 'active'; goal.updatedAt = ctx.now; }
      return true;
    }
    case 'review.create': case 'review.update': {
      manage(ctx);
      const existing = command.type === 'review.update' ? item(s.reviews, p) : null;
      invariant(!existing || existing.status === 'draft', 'HR_LOCKED', '준비 중인 평가만 수정할 수 있습니다.', 409);
      const employeeIds = ids(workspace, p, 'employeeIds');
      const reviewer = text(p, 'reviewerEmployeeId', 100, true); if (reviewer) employee(workspace, reviewer);
      const startDate = date(p, 'startDate'), dueDate = date(p, 'dueDate');
      invariant(startDate <= dueDate, 'HR_INVALID', '평가 종료일은 시작일 이후여야 합니다.');
      invariant(Array.isArray(p.questions) && p.questions.length > 0 && p.questions.length <= 20, 'HR_INVALID', '평가 문항은 1~20개로 설정해 주세요.');
      const questions = (p.questions as unknown[]).map(question => text({ question }, 'question', 300));
      invariant(new Set(questions).size === questions.length, 'HR_INVALID', '평가 문항은 중복될 수 없습니다.');
      const cycle: HrReviewCycle = { id: existing?.id ?? ctx.id(), title: text(p, 'title'), startDate, dueDate, questions, status: 'draft', reports: [], createdAt: existing?.createdAt ?? ctx.now,
        assignments: employeeIds.map(employeeId => ({ id: ctx.id(), employeeId, reviewerEmployeeId: reviewer || employeeId, status: 'draft', answers: [], submittedAt: null })) };
      if (existing) Object.assign(existing, cycle); else s.reviews.push(cycle);
      return true;
    }
    case 'review.delete': {
      manage(ctx); const cycle = item(s.reviews, p);
      invariant(cycle.status === 'draft', 'HR_LOCKED', '준비 중인 평가만 삭제할 수 있습니다.', 409);
      s.reviews = s.reviews.filter(row => row.id !== cycle.id); return true;
    }
    case 'review.open': {
      manage(ctx); const cycle = item(s.reviews, p);
      invariant(cycle.status === 'draft' && cycle.dueDate >= ctx.today, 'HR_LOCKED', '준비 중이며 마감 전인 평가만 시작할 수 있습니다.', 409);
      cycle.status = 'open'; return true;
    }
    case 'review.answer': case 'review.submit': case 'review.withdraw': {
      const cycle = item(s.reviews, p); reviewOpen(cycle, ctx);
      const assignment = cycle.assignments.find(row => row.id === p.assignmentId);
      invariant(assignment && assignment.reviewerEmployeeId === ctx.employeeId, 'HR_FORBIDDEN', '배정받은 평가만 작성할 수 있습니다.', 403);
      if (command.type === 'review.withdraw') {
        invariant(assignment.status === 'submitted', 'HR_LOCKED', '제출한 평가만 회수할 수 있습니다.', 409);
        assignment.status = 'draft'; assignment.submittedAt = null; return true;
      }
      invariant(assignment.status === 'draft', 'HR_LOCKED', '제출한 평가는 회수 후 수정해 주세요.', 409);
      if (command.type === 'review.answer') {
        invariant(Array.isArray(p.answers) && p.answers.length <= cycle.questions.length, 'HR_INVALID', '평가 답변을 확인해 주세요.');
        const answers = (p.answers as unknown[]).map(value => {
          invariant(value && typeof value === 'object' && !Array.isArray(value), 'HR_INVALID', '평가 답변을 확인해 주세요.');
          const answer = value as Record<string, unknown>;
          const question = text(answer, 'question', 300), score = number(answer, 'score', 1, 5);
          invariant(cycle.questions.includes(question) && Number.isInteger(score), 'HR_INVALID', '문항과 1~5점 정수 점수를 확인해 주세요.');
          return { question, score, comment: text(answer, 'comment', 5000, true) };
        });
        invariant(new Set(answers.map(answer => answer.question)).size === answers.length, 'HR_INVALID', '중복 답변을 제거해 주세요.');
        assignment.answers = answers;
      } else {
        invariant(assignment.answers.length === cycle.questions.length, 'HR_INVALID', '모든 문항의 답변을 저장한 후 제출해 주세요.');
        assignment.status = 'submitted'; assignment.submittedAt = ctx.now;
      }
      return true;
    }
    case 'review.close': {
      manage(ctx); const cycle = item(s.reviews, p);
      invariant(cycle.status === 'open' && cycle.assignments.every(row => row.status === 'submitted'), 'HR_LOCKED', '모든 평가가 제출된 후 마감할 수 있습니다.', 409);
      const subjectIds = [...new Set(cycle.assignments.map(row => row.employeeId))];
      cycle.reports = subjectIds.map(employeeId => {
        const rows = cycle.assignments.filter(row => row.employeeId === employeeId);
        const answers = rows.flatMap(row => row.answers);
        return { employeeId, averageScore: Math.round(answers.reduce((sum, answer) => sum + answer.score, 0) / answers.length * 100) / 100,
          responseCount: rows.length, summary: answers.map(answer => `${answer.question}: ${answer.score}점${answer.comment ? ` · ${answer.comment}` : ''}`).join('\n'), sharedAt: null, revokedAt: null };
      });
      cycle.status = 'closed'; return true;
    }
    case 'review.publish': case 'review.revoke': {
      manage(ctx); const cycle = item(s.reviews, p);
      invariant(cycle.status === 'closed', 'HR_LOCKED', '마감된 평가만 결과를 공유할 수 있습니다.', 409);
      const report = cycle.reports.find(row => row.employeeId === p.employeeId);
      invariant(report, 'HR_NOT_FOUND', '평가 결과를 찾을 수 없습니다.', 404);
      if (command.type === 'review.publish') { report.sharedAt = ctx.now; report.revokedAt = null; }
      else { report.sharedAt = null; report.revokedAt = ctx.now; }
      return true;
    }
    case 'meeting.create': {
      invariant(ctx.employeeId, 'HR_FORBIDDEN', '본인 구성원 프로필을 연결해 주세요.', 403); employee(workspace, ctx.employeeId);
      const participants = ids(workspace, p, 'participantEmployeeIds');
      if (!participants.includes(ctx.employeeId)) participants.push(ctx.employeeId);
      s.meetings.push({ id: ctx.id(), title: text(p, 'title'), hostActorId: ctx.actorId, participantEmployeeIds: participants,
        scheduledDate: date(p, 'scheduledDate', true), notes: '', privateNotes: {}, tasks: [], createdAt: ctx.now, updatedAt: ctx.now }); return true;
    }
    case 'meeting.update': case 'meeting.privateNote': case 'meeting.addTask': case 'meeting.toggleTask': case 'meeting.delete': {
      const meeting = item(s.meetings, p);
      invariant(participant(meeting, ctx), 'HR_FORBIDDEN', '미팅 참여자만 접근할 수 있습니다.', 403);
      if (command.type === 'meeting.update') {
        const title = own(p, 'title') ? text(p, 'title') : meeting.title;
        const notes = own(p, 'notes') ? text(p, 'notes', 50000, true) : meeting.notes;
        const scheduledDate = own(p, 'scheduledDate') ? date(p, 'scheduledDate', true) : meeting.scheduledDate;
        Object.assign(meeting, { title, notes, scheduledDate });
      } else if (command.type === 'meeting.privateNote') {
        meeting.privateNotes[ctx.actorId] = text(p, 'note', 50000, true);
      } else if (command.type === 'meeting.addTask') {
        const assigneeEmployeeId = text(p, 'assigneeEmployeeId');
        invariant(meeting.participantEmployeeIds.includes(assigneeEmployeeId), 'HR_INVALID', '미팅 참여자에게 할 일을 배정해 주세요.');
        meeting.tasks.push({ id: ctx.id(), title: text(p, 'title', 300), assigneeEmployeeId, completed: false });
      } else if (command.type === 'meeting.toggleTask') {
        const task = meeting.tasks.find(row => row.id === p.taskId);
        invariant(task, 'HR_NOT_FOUND', '할 일을 찾을 수 없습니다.', 404);
        invariant(typeof p.completed === 'boolean', 'HR_INVALID', '완료 상태를 확인해 주세요.'); task.completed = p.completed;
      } else {
        invariant(meeting.hostActorId === ctx.actorId, 'HR_FORBIDDEN', '주최자만 미팅을 삭제할 수 있습니다.', 403);
        s.meetings = s.meetings.filter(row => row.id !== meeting.id);
      }
      meeting.updatedAt = ctx.now; return true;
    }
    case 'recruitment.createJob': {
      manage(ctx); s.jobs.push({ id: ctx.id(), title: text(p, 'title'), description: text(p, 'description', 10000, true), status: 'draft', createdAt: ctx.now }); return true;
    }
    case 'recruitment.updateJob': case 'recruitment.deleteJob': {
      manage(ctx); const job = item(s.jobs, p);
      if (command.type === 'recruitment.deleteJob') {
        invariant(!s.candidates.some(row => row.jobId === job.id), 'HR_LOCKED', '지원자가 있는 공고는 삭제할 수 없습니다. 마감을 이용해 주세요.', 409);
        s.jobs = s.jobs.filter(row => row.id !== job.id);
      } else {
        const title = own(p, 'title') ? text(p, 'title') : job.title;
        const description = own(p, 'description') ? text(p, 'description', 10000, true) : job.description;
        const status = own(p, 'status') ? option(p, 'status', ['draft', 'open', 'closed']) : job.status;
        Object.assign(job, { title, description, status });
      }
      return true;
    }
    case 'recruitment.addCandidate': {
      manage(ctx); const jobId = text(p, 'jobId'), job = s.jobs.find(row => row.id === jobId);
      invariant(job?.status === 'open', 'HR_LOCKED', '모집 중인 공고에 지원자를 추가해 주세요.', 409);
      const email = text(p, 'email', 254, true);
      invariant(!email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'HR_INVALID', '이메일을 확인해 주세요.');
      s.candidates.push({ id: ctx.id(), jobId, name: text(p, 'name'), email, note: text(p, 'note', 10000, true),
        stage: 'applied', previousStage: null, history: [{ from: null, to: 'applied', at: ctx.now, actorId: ctx.actorId }] }); return true;
    }
    case 'recruitment.moveCandidate': case 'recruitment.reopenCandidate': {
      manage(ctx); const candidate = item(s.candidates, p), terminal = ['hired', 'rejected', 'withdrawn'].includes(candidate.stage);
      let stage: HrCandidateStage;
      if (command.type === 'recruitment.reopenCandidate') {
        invariant(terminal, 'HR_LOCKED', '종료된 전형만 다시 열 수 있습니다.', 409);
        stage = candidate.previousStage ?? 'applied';
      } else {
        invariant(!terminal, 'HR_LOCKED', '종료된 전형을 다시 연 후 변경해 주세요.', 409);
        stage = option(p, 'stage', ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']);
        invariant(stage !== candidate.stage, 'HR_INVALID', '다른 단계로 이동해 주세요.');
      }
      invariant(s.jobs.find(row => row.id === candidate.jobId)?.status === 'open', 'HR_LOCKED', '공고를 모집 중으로 변경한 후 진행해 주세요.', 409);
      candidate.history.push({ from: candidate.stage, to: stage, at: ctx.now, actorId: ctx.actorId });
      candidate.previousStage = candidate.stage; candidate.stage = stage; return true;
    }
    case 'contract.create': {
      manage(ctx); const employeeId = text(p, 'employeeId');
      const terms = contractTerms(workspace, p, ctx, employeeId);
      s.contracts.push({ id: ctx.id(), employeeId, title: text(p, 'title'), body: text(p, 'body', 50000), terms,
        status: 'draft', completionKind: null, completionReference: '', completedAt: null, createdAt: ctx.now,
        appliedAt: null, appliedBy: null, personnelBefore: null }); return true;
    }
    case 'contract.update': {
      manage(ctx); const contract = item(s.contracts, p);
      invariant(contract.status === 'draft', 'HR_LOCKED', '계약 초안만 수정할 수 있습니다.', 409);
      const title = text(p, 'title'), body = text(p, 'body', 50000), terms = contractTerms(workspace, p, ctx, contract.employeeId);
      invariant(contract.terms.basePay === null || ctx.payroll, 'HR_FORBIDDEN', '급여를 포함한 계약은 급여 권한이 필요합니다.', 403);
      Object.assign(contract, { title, body, terms }); return true;
    }
    case 'contract.complete': {
      manage(ctx); const contract = item(s.contracts, p);
      invariant(contract.terms.basePay === null || ctx.payroll, 'HR_FORBIDDEN', '급여를 포함한 계약은 급여 권한이 필요합니다.', 403);
      invariant(contract.status === 'draft', 'HR_LOCKED', '초안 계약만 완료 기록할 수 있습니다.', 409);
      const reference = text(p, 'completionReference', 2000);
      contract.status = 'completed'; contract.completionKind = 'external_record'; contract.completionReference = reference; contract.completedAt = ctx.now; return true;
    }
    case 'contract.cancel': {
      manage(ctx); const contract = item(s.contracts, p);
      invariant(contract.terms.basePay === null || ctx.payroll, 'HR_FORBIDDEN', '급여를 포함한 계약은 급여 권한이 필요합니다.', 403);
      invariant(contract.status === 'draft', 'HR_LOCKED', '완료 기록은 취소하거나 삭제할 수 없습니다. 정정 계약을 작성해 주세요.', 409);
      contract.status = 'cancelled'; return true;
    }
    case 'contract.applyPersonnel': {
      manage(ctx); const contract = item(s.contracts, p);
      invariant(contract.status === 'completed' && contract.appliedAt === null, 'HR_LOCKED', '완료 계약은 인사정보에 한 번만 반영할 수 있습니다.', 409);
      invariant(contract.terms.effectiveDate <= ctx.today, 'HR_LOCKED', '미래 적용일의 계약은 해당 날짜 이후에 반영해 주세요.', 409);
      const member = employee(workspace, contract.employeeId);
      invariant(contract.terms.effectiveDate >= member.hireDate, 'HR_INVALID', '변경된 입사일과 계약 적용일을 확인해 주세요.');
      const contractFields = new Set(['employmentType', 'jobTitle', 'endDate', 'payType', 'basePay', 'hireDate', 'contractId', 'nativeContractId']);
      const newerPersonnel = member.history.some(row => Object.keys(row.changes).some(key => contractFields.has(key))
        && (row.effectiveDate > contract.terms.effectiveDate || Date.parse(row.at) > Date.parse(contract.createdAt)));
      invariant(!newerPersonnel, 'HR_CONTRACT_STALE', '계약 작성 이후 반영된 근로조건이 있습니다. 최신 조건을 확인하고 정정 계약을 작성해 주세요.', 409);
      invariant(contract.terms.basePay === null || ctx.payroll, 'HR_FORBIDDEN', '급여 변경 권한이 필요합니다.', 403);
      contract.personnelBefore = { employmentType: member.employmentType, jobTitle: member.jobTitle, endDate: member.endDate ?? '', payType: member.payType, basePay: member.basePay };
      member.employmentType = contract.terms.employmentType; member.jobTitle = contract.terms.jobTitle;
      if (contract.terms.endDate) member.endDate = contract.terms.endDate; else delete member.endDate;
      if (contract.terms.basePay !== null) { member.basePay = contract.terms.basePay; member.payType = contract.terms.payType; }
      member.history.push({ at: ctx.now, effectiveDate: contract.terms.effectiveDate, reason: `계약 인사정보 반영: ${contract.title}`,
        changes: { contractId: contract.id, employmentType: member.employmentType, jobTitle: member.jobTitle,
          endDate: member.endDate ?? '', ...(contract.terms.basePay !== null ? { basePay: member.basePay, payType: member.payType } : {}) } });
      contract.appliedAt = ctx.now; contract.appliedBy = ctx.actorId; return true;
    }
    default: return false;
  }
}
