import type { HrWorkspace, HrCommand, HrContext } from './oda-hr.ts';
import { hrDate, hrEmployee, hrEnum, hrFail, hrManager, hrNumber, hrStringArray, hrText } from './oda-hr-utils.ts';

export interface HrApprovalStep { approverIds: string[]; mode: 'all' | 'any'; }
export interface HrWorkflowTemplate { id: string; title: string; category: string; steps: HrApprovalStep[]; archived: boolean; createdBy: string; }
export interface HrDecision { step: number; approverId: string; actorId: string; decision: 'approved' | 'rejected'; at: string; comment: string; }
export interface HrWorkflowRequest { id: string; title: string; category: string; body: string; amount: number; employeeId?: string; authorId: string; templateId: string; steps: HrApprovalStep[]; currentStep: number; status: 'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn'; decisions: HrDecision[]; createdAt: string; submittedAt?: string; completedAt?: string; }
export interface HrDelegation { id: string; fromActorId: string; toActorId: string; startDate: string; endDate: string; active: boolean; }
export interface HrExpenseEvidence { id: string; employeeId?: string; authorId: string; date: string; title: string; amount: number; category: string; evidenceNote: string; workflowId?: string; status: 'draft' | 'submitted' | 'reviewed' | 'rejected' | 'withdrawn'; reviewedAt?: string; reviewerId?: string;
  history?: Array<{ at: string; actorId: string; action: string; status: HrExpenseEvidence['status']; workflowId?: string }>; }
export interface HrWorkflowState { templates: HrWorkflowTemplate[]; requests: HrWorkflowRequest[]; delegations: HrDelegation[]; expenses: HrExpenseEvidence[]; }
export function createHrWorkflowState(): HrWorkflowState { return { templates: [], requests: [], delegations: [], expenses: [] }; }

function actorKnown(workspace: HrWorkspace, id: string, ctx: HrContext) {
  if (!(ctx.manager && id === ctx.actorId) && !workspace.employees.some(row => row.actorId === id && row.status === 'active')) hrFail('결재자는 로그인 계정이 연결된 재직 구성원이어야 합니다.');
}
function stepsFrom(input: Record<string, unknown>, workspace: HrWorkspace, ctx: HrContext): HrApprovalStep[] {
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 10) hrFail('결재 단계를 1~10개 지정해 주세요.');
  return input.steps.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) hrFail('올바른 결재 단계를 입력해 주세요.');
    const step = value as Record<string, unknown>;
    const approverIds = hrStringArray(step, 'approverIds', 30);
    if (!approverIds.length) hrFail('각 단계에 결재자가 필요합니다.');
    approverIds.forEach(id => actorKnown(workspace, id, ctx));
    return { approverIds, mode: hrEnum(step, 'mode', ['all', 'any'] as const) };
  });
}
export function canHrApprove(request: HrWorkflowRequest, state: HrWorkflowState, ctx: HrContext): boolean {
  return request.status === 'pending' && !!eligibleApprover(request, state, ctx);
}
function eligibleApprover(request: HrWorkflowRequest, state: HrWorkflowState, ctx: HrContext): string | undefined {
  const step = request.steps[request.currentStep];
  // A person cannot supply multiple votes in one all-approval step through delegation.
  if (request.decisions.some(d => d.step === request.currentStep && d.actorId === ctx.actorId)) return undefined;
  const ids = [...(step?.approverIds ?? [])].sort((a, b) => Number(b === ctx.actorId) - Number(a === ctx.actorId));
  return ids.find(id => !request.decisions.some(d => d.step === request.currentStep && d.approverId === id)
    && (id === ctx.actorId || state.delegations.some(d => d.active && d.fromActorId === id && d.toActorId === ctx.actorId && d.startDate <= ctx.today && d.endDate >= ctx.today)));
}
function own(request: {authorId: string}, ctx: HrContext) { if (request.authorId !== ctx.actorId) hrFail('작성자만 처리할 수 있습니다.', 'HR_FORBIDDEN', 403); }
function expenseEvent(row: HrExpenseEvidence, ctx: HrContext, action: string): void {
  (row.history ??= []).push({ at: ctx.now, actorId: ctx.actorId, action, status: row.status, ...(row.workflowId ? { workflowId: row.workflowId } : {}) });
}
function closeLinkedExpenses(state: HrWorkflowState, requestId: string, status: 'rejected' | 'withdrawn', ctx: HrContext): void {
  for (const expense of state.expenses.filter(row => row.workflowId === requestId && row.status === 'submitted')) {
    expense.status = status; expenseEvent(expense, ctx, `workflow.${status}`);
  }
}

export function applyHrWorkflowCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  const {type,input} = command; const state = workspace.workflow;
  if (!type.startsWith('workflow.') && !type.startsWith('expense.')) return false;
  switch (type) {
    case 'workflow.template.save': {
      hrManager(ctx); const id = hrText(input, 'id', 120, true); const existing = state.templates.find(row => row.id === id);
      if (id && !existing) hrFail('결재 양식을 찾을 수 없습니다.');
      if (existing?.archived) hrFail('보관한 양식은 수정할 수 없습니다.', 'HR_LOCKED', 409);
      const values = {title: hrText(input,'title',120),category: hrText(input,'category',80),steps: stepsFrom(input,workspace,ctx)};
      if(existing) Object.assign(existing,values); else state.templates.push({id:ctx.id(),...values,archived:false,createdBy:ctx.actorId});
      return true;
    }
    case 'workflow.template.archive': { hrManager(ctx); const row=state.templates.find(row=>row.id===hrText(input,'id',120)); if(!row) hrFail('양식을 찾을 수 없습니다.'); row.archived=true; return true; }
    case 'workflow.create': {
      if (!ctx.manager && !ctx.employeeId) hrFail('구성원 연결이 필요합니다.', 'HR_FORBIDDEN',403);
      const templateId=hrText(input,'templateId',120); const template=state.templates.find(row=>row.id===templateId&&!row.archived);
      if(!template) hrFail('사용 가능한 결재 양식을 선택해 주세요.');
      state.requests.push({id:ctx.id(),title:hrText(input,'title',200),body:hrText(input,'body',10000),category:template.category,amount:input.amount===undefined?0:hrNumber(input,'amount',0,1e12,true),...(ctx.employeeId?{employeeId:ctx.employeeId}:{}),authorId:ctx.actorId,templateId,steps:structuredClone(template.steps),currentStep:0,status:'draft',decisions:[],createdAt:ctx.now}); return true;
    }
    case 'workflow.update': {
      const row=state.requests.find(row=>row.id===hrText(input,'id',120)); if(!row) hrFail('결재 문서를 찾을 수 없습니다.'); own(row,ctx);
      if(row.status!=='draft') hrFail('임시저장 문서만 수정할 수 있습니다.', 'HR_LOCKED',409);
      row.title=hrText(input,'title',200); row.body=hrText(input,'body',10000); row.amount=hrNumber(input,'amount',0,1e12,true); return true;
    }
    case 'workflow.submit': {
      const row=state.requests.find(row=>row.id===hrText(input,'id',120)); if(!row) hrFail('결재 문서를 찾을 수 없습니다.'); own(row,ctx);
      if(row.status!=='draft') hrFail('임시저장 상태에서 제출해 주세요.', 'HR_STATE',409);
      const template=state.templates.find(t=>t.id===row.templateId);
      row.steps.forEach(step=>step.approverIds.forEach(id=>{if(id!==template?.createdBy)actorKnown(workspace,id,ctx);}));
      row.status='pending';row.submittedAt=ctx.now;return true;
    }
    case 'workflow.approve': case 'workflow.reject': {
      const row=state.requests.find(row=>row.id===hrText(input,'id',120)); if(!row) hrFail('결재 문서를 찾을 수 없습니다.');
      if(row.status!=='pending') hrFail('진행 중인 결재만 처리할 수 있습니다.','HR_STATE',409);
      const approverId=eligibleApprover(row,state,ctx); if(!approverId) hrFail('현재 단계의 결재자만 처리할 수 있습니다.','HR_FORBIDDEN',403);
      const decision=type==='workflow.approve'?'approved':'rejected';
      const comment=hrText(input,'comment',2000,decision==='approved');
      row.decisions.push({step:row.currentStep,approverId,actorId:ctx.actorId,decision,at:ctx.now,comment});
      if(decision==='rejected'){row.status='rejected';row.completedAt=ctx.now;closeLinkedExpenses(state,row.id,'rejected',ctx);return true;}
      const step=row.steps[row.currentStep]!;
      if(step.mode==='any'||step.approverIds.every(id=>row.decisions.some(d=>d.step===row.currentStep&&d.approverId===id&&d.decision==='approved'))){
        row.currentStep++; if(row.currentStep===row.steps.length){row.status='approved';row.completedAt=ctx.now;}
      } return true;
    }
    case 'workflow.withdraw': {
      const row=state.requests.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('결재 문서를 찾을 수 없습니다.');own(row,ctx);
      if(!['draft','pending'].includes(row.status))hrFail('임시저장·진행 중인 문서만 회수할 수 있습니다.','HR_STATE',409);
      row.status='withdrawn';row.completedAt=ctx.now;closeLinkedExpenses(state,row.id,'withdrawn',ctx);return true;
    }
    case 'workflow.delegation.save': {
      const fromActorId=hrText(input,'fromActorId',120),toActorId=hrText(input,'toActorId',120);
      if(!ctx.manager&&fromActorId!==ctx.actorId)hrFail('본인의 대결만 설정할 수 있습니다.','HR_FORBIDDEN',403);
      actorKnown(workspace,fromActorId,ctx);actorKnown(workspace,toActorId,ctx);if(fromActorId===toActorId)hrFail('다른 대결자를 선택해 주세요.');
      const startDate=hrDate(input,'startDate'),endDate=hrDate(input,'endDate');if(startDate>endDate)hrFail('대결 종료일을 확인해 주세요.');
      if(state.delegations.some(d=>d.active&&d.startDate<=endDate&&d.endDate>=startDate&&(d.fromActorId===fromActorId||d.toActorId===fromActorId||d.fromActorId===toActorId)))hrFail('같은 기간의 중복·연쇄 대결은 허용되지 않습니다.');
      state.delegations.push({id:ctx.id(),fromActorId,toActorId,startDate,endDate,active:true});return true;
    }
    case 'workflow.delegation.revoke': {
      const row=state.delegations.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('대결 설정을 찾을 수 없습니다.');
      if(!ctx.manager&&row.fromActorId!==ctx.actorId)hrFail('대결을 해제할 권한이 없습니다.','HR_FORBIDDEN',403);row.active=false;return true;
    }
    case 'expense.create': {
      if(!ctx.manager&&!ctx.employeeId)hrFail('구성원 연결이 필요합니다.','HR_FORBIDDEN',403);
      state.expenses.push({id:ctx.id(),...(ctx.employeeId?{employeeId:ctx.employeeId}:{}),authorId:ctx.actorId,date:hrDate(input,'date'),title:hrText(input,'title',200),amount:hrNumber(input,'amount',1,1e12,true),category:hrText(input,'category',80),evidenceNote:hrText(input,'evidenceNote',2000),status:'draft'});return true;
    }
    case 'expense.submit': {
      const row=state.expenses.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('비용을 찾을 수 없습니다.');own(row,ctx);
      if(row.status!=='draft')hrFail('임시저장한 비용만 제출할 수 있습니다.','HR_STATE',409);
      const workflowId=hrText(input,'workflowId',120);const request=state.requests.find(r=>r.id===workflowId);
      if(!request||request.authorId!==ctx.actorId||!['pending','approved'].includes(request.status)||request.amount!==row.amount)hrFail('동일 금액의 본인 결재 문서를 제출한 후 연결해 주세요.');
      if(state.expenses.some(e=>e.id!==row.id&&e.workflowId===workflowId))hrFail('이미 다른 비용에 연결된 결재 문서입니다.');
      row.workflowId=workflowId;row.status='submitted';expenseEvent(row,ctx,type);return true;
    }
    case 'expense.update': {
      const row=state.expenses.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('비용을 찾을 수 없습니다.');own(row,ctx);
      if(row.status!=='draft')hrFail('작성 중인 비용만 수정할 수 있습니다.','HR_STATE',409);
      const values={date:hrDate(input,'date'),title:hrText(input,'title',200),amount:hrNumber(input,'amount',1,1e12,true),category:hrText(input,'category',80),evidenceNote:hrText(input,'evidenceNote',2000)};
      Object.assign(row,values);expenseEvent(row,ctx,type);return true;
    }
    case 'expense.withdraw': {
      const row=state.expenses.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('비용을 찾을 수 없습니다.');own(row,ctx);
      if(!['draft','submitted'].includes(row.status))hrFail('작성 중이거나 검토 전인 비용만 회수할 수 있습니다.','HR_STATE',409);
      row.status='withdrawn';expenseEvent(row,ctx,type);return true;
    }
    case 'expense.reopen': {
      const row=state.expenses.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('비용을 찾을 수 없습니다.');own(row,ctx);
      if(!['rejected','withdrawn'].includes(row.status))hrFail('반려·회수한 비용만 다시 작성할 수 있습니다.','HR_STATE',409);
      expenseEvent(row,ctx,type);row.status='draft';delete row.workflowId;delete row.reviewedAt;delete row.reviewerId;return true;
    }
    case 'expense.review': {
      if(!ctx.manager&&!ctx.payroll)hrFail('비용 검토 권한이 필요합니다.','HR_FORBIDDEN',403);
      const row=state.expenses.find(row=>row.id===hrText(input,'id',120));if(!row)hrFail('비용을 찾을 수 없습니다.');
      if(row.status!=='submitted')hrFail('제출된 비용만 검토할 수 있습니다.','HR_STATE',409);
      const accepted=hrEnum(input,'decision',['reviewed','rejected'] as const);
      if(accepted==='reviewed'&&state.requests.find(r=>r.id===row.workflowId)?.status!=='approved')hrFail('연결된 결재가 최종 승인되어야 합니다.','HR_APPROVAL_REQUIRED',409);
      row.status=accepted;row.reviewerId=ctx.actorId;row.reviewedAt=ctx.now;expenseEvent(row,ctx,type);return true;
    }
    default:return false;
  }
}

export function projectHrWorkflowState(state: HrWorkflowState, ctx: HrContext): HrWorkflowState {
  const visible=(row:HrWorkflowRequest)=>row.authorId===ctx.actorId||(row.status!=='draft'&&(ctx.manager
    ||row.steps.some(step=>step.approverIds.includes(ctx.actorId))||canHrApprove(row,state,ctx)
    ||(ctx.payroll&&state.expenses.some(expense=>expense.workflowId===row.id&&expense.status!=='draft'))));
  const requests=state.requests.filter(visible);
  return {templates:structuredClone(state.templates.filter(row=>ctx.manager||!row.archived)),requests:structuredClone(requests),delegations:structuredClone(state.delegations.filter(row=>ctx.manager||row.fromActorId===ctx.actorId||row.toActorId===ctx.actorId)),expenses:structuredClone(state.expenses.filter(row=>row.authorId===ctx.actorId||(row.status!=='draft'&&(ctx.manager||ctx.payroll||requests.some(request=>request.id===row.workflowId)))))};
}
