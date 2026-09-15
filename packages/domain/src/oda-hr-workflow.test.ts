import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHrWorkspace, applyHrCommand, type HrContext } from './oda-hr.ts';
import { projectHrWorkflowState } from './oda-hr-workflow.ts';

function setup(){let i=0;const manager:HrContext={actorId:'manager',manager:true,payroll:true,today:'2026-09-15',now:'2026-09-15T03:00:00Z',id:()=>`id-${++i}`};
 const w=createHrWorkspace('s','ODA',manager.now);
 for(const id of ['requestor','a','b','c'])applyHrCommand(w,{type:'employee.create',input:{employeeNumber:id,name:id,actorId:id,hireDate:'2026-01-01'}},manager);
 const context=(id:string):HrContext=>({...manager,actorId:id,employeeId:w.employees.find(e=>e.actorId===id)!.id,manager:false,payroll:false});
 const run=(type:string,input:Record<string,unknown>,ctx=manager)=>applyHrCommand(w,{type,input},ctx);
 run('workflow.template.save',{title:'구매',category:'비용',steps:[{approverIds:['a','b'],mode:'all'},{approverIds:['manager'],mode:'any'}]});
 run('workflow.create',{templateId:w.workflow.templates[0]!.id,title:'비품 구매',body:'의자 구매',amount:25000},context('requestor'));
 return {w,manager,context,run,id:w.workflow.requests[0]!.id};}

test('순차 개인 전원 결재는 다음 단계의 선행 승인과 중복 처리를 차단한다',()=>{
 const {w,run,id,context,manager}=setup();run('workflow.submit',{id},context('requestor'));
 assert.throws(()=>run('workflow.approve',{id},manager),/현재 단계/);
 run('workflow.approve',{id},context('a'));assert.equal(w.workflow.requests[0]!.currentStep,0);
 assert.throws(()=>run('workflow.approve',{id},context('a')),/현재 단계/);
 run('workflow.approve',{id},context('b'));assert.equal(w.workflow.requests[0]!.currentStep,1);
 run('workflow.approve',{id},manager);assert.equal(w.workflow.requests[0]!.status,'approved');
 assert.throws(()=>run('workflow.withdraw',{id},context('requestor')),/회수/);
});
test('기간 내 대결은 원결재자와 실제 처리자를 보존하며 연쇄 위임을 차단한다',()=>{
 const {w,run,id,context}=setup();run('workflow.delegation.save',{fromActorId:'a',toActorId:'c',startDate:'2026-09-15',endDate:'2026-09-16'});
 assert.throws(()=>run('workflow.delegation.save',{fromActorId:'c',toActorId:'b',startDate:'2026-09-15',endDate:'2026-09-16'}),/연쇄/);
 run('workflow.submit',{id},context('requestor'));
 assert.equal(projectHrWorkflowState(w.workflow,context('c')).requests.length,1);
 run('workflow.approve',{id,comment:'대결 확인'},context('c'));
 assert.deepEqual(w.workflow.requests[0]!.decisions[0],{step:0,approverId:'a',actorId:'c',decision:'approved',at:'2026-09-15T03:00:00Z',comment:'대결 확인'});
 const expiry={...context('c'),today:'2026-09-17'};assert.equal(projectHrWorkflowState(w.workflow,expiry).requests.length,0);
});
test('양식 변경은 이미 작성한 결재 단계 스냅샷에 영향을 주지 않는다',()=>{
 const {w,run}=setup();const templateId=w.workflow.templates[0]!.id;
 run('workflow.template.save',{id:templateId,title:'변경',category:'구매',steps:[{approverIds:['manager'],mode:'any'}]});
 assert.deepEqual(w.workflow.requests[0]!.steps[0]!.approverIds,['a','b']);
});
test('비용 검토는 동일금액 결재의 최종승인을 요구하고 결재 하나의 중복비용 연결을 거절한다',()=>{
 const {w,run,id,context,manager}=setup();const requester=context('requestor');
 run('expense.create',{date:'2026-09-15',title:'의자',amount:25000,category:'비품',evidenceNote:'영수증 R-1'},requester);
 const expenseId=w.workflow.expenses[0]!.id;
 assert.throws(()=>run('expense.submit',{id:expenseId,workflowId:id},requester),/결재 문서/);
 run('workflow.submit',{id},requester);run('expense.submit',{id:expenseId,workflowId:id},requester);
 assert.throws(()=>run('expense.review',{id:expenseId,decision:'reviewed'}),/최종 승인/);
 run('workflow.approve',{id},context('a'));run('workflow.approve',{id},context('b'));run('workflow.approve',{id},manager);
 run('expense.review',{id:expenseId,decision:'reviewed'});assert.equal(w.workflow.expenses[0]!.status,'reviewed');
 run('expense.create',{date:'2026-09-15',title:'복제',amount:25000,category:'비품',evidenceNote:'R-2'},requester);
 assert.throws(()=>run('expense.submit',{id:w.workflow.expenses[1]!.id,workflowId:id},requester),/다른 비용/);
});
test('타인 문서 본문·금액은 관계없는 직원과 읽기전용 계정에게 공개하지 않는다',()=>{
 const {w,context,manager}=setup();assert.equal(projectHrWorkflowState(w.workflow,context('c')).requests.length,0);
 assert.equal(projectHrWorkflowState(w.workflow,{...manager,actorId:'auditor',manager:false,payroll:false}).requests.length,0);
});

test('제출 전 결재와 비용 초안은 지정 결재자·관리자·재무에게도 공개하지 않는다',()=>{
 const {w,context,manager,run}=setup();
 run('expense.create',{date:'2026-09-15',title:'개인 초안',amount:25000,category:'비품',evidenceNote:'제출 전 민감 내용'},context('requestor'));
 for(const ctx of [context('a'),manager,{...manager,actorId:'finance',manager:false,payroll:true}]){
  const result=projectHrWorkflowState(w.workflow,ctx);assert.equal(result.requests.length,0);assert.equal(result.expenses.length,0);
 }
 assert.equal(projectHrWorkflowState(w.workflow,context('requestor')).requests.length,1);
});

test('한 명 승인 단계는 첫 승인으로 다음 단계로 진행하고 이전 단계 추가승인은 차단한다',()=>{
 const {w,context,run}=setup();
 run('workflow.template.save',{title:'선택 결재',category:'비용',steps:[{approverIds:['a','b'],mode:'any'},{approverIds:['c'],mode:'all'}]});
 run('workflow.create',{templateId:w.workflow.templates[1]!.id,title:'요청',body:'내용'},context('requestor'));
 const id=w.workflow.requests[1]!.id;run('workflow.submit',{id},context('requestor'));run('workflow.approve',{id},context('b'));
 assert.equal(w.workflow.requests[1]!.currentStep,1);assert.throws(()=>run('workflow.approve',{id},context('a')),/현재 단계/);
 run('workflow.approve',{id},context('c'));assert.equal(w.workflow.requests[1]!.status,'approved');
});

test('전원 승인 단계에서 한 사람이 자신의 승인과 대결 승인을 중복 행사할 수 없다',()=>{
 const {w,run,context,id}=setup();run('workflow.submit',{id},context('requestor'));
 run('workflow.delegation.save',{fromActorId:'a',toActorId:'b',startDate:'2026-09-15',endDate:'2026-09-16'});
 run('workflow.approve',{id},context('b'));assert.equal(w.workflow.requests[0]!.decisions[0]!.approverId,'b');
 assert.throws(()=>run('workflow.approve',{id},context('b')),/현재 단계/);assert.equal(w.workflow.requests[0]!.currentStep,0);
 run('workflow.approve',{id},context('a'));assert.equal(w.workflow.requests[0]!.currentStep,1);
});

test('대결 기간 시작 전·종료 후·회수 후에는 결재와 본문 조회 권한이 사라진다',()=>{
 const {w,run,context,id}=setup();run('workflow.submit',{id},context('requestor'));
 run('workflow.delegation.save',{fromActorId:'a',toActorId:'c',startDate:'2026-09-15',endDate:'2026-09-16'});
 for(const today of ['2026-09-14','2026-09-17']){
  const ctx={...context('c'),today};assert.equal(projectHrWorkflowState(w.workflow,ctx).requests.length,0);assert.throws(()=>run('workflow.approve',{id},ctx),/현재 단계/);
 }
 run('workflow.delegation.revoke',{id:w.workflow.delegations[0]!.id},context('a'));
 assert.equal(projectHrWorkflowState(w.workflow,context('c')).requests.length,0);assert.throws(()=>run('workflow.approve',{id},context('c')),/현재 단계/);
});

test('결재 반려·회수는 연결 비용도 종료시키고 작성자는 이력을 보존해 다시 작성한다',()=>{
 for(const action of ['workflow.reject','workflow.withdraw']){
  const {w,run,context,id}=setup();const requester=context('requestor');run('workflow.submit',{id},requester);
  run('expense.create',{date:'2026-09-15',title:'비용',amount:25000,category:'비품',evidenceNote:'R-1'},requester);
  const expenseId=w.workflow.expenses[0]!.id;run('expense.submit',{id:expenseId,workflowId:id},requester);
  run(action,{id,comment:'수정 필요'},action==='workflow.reject'?context('a'):requester);
  assert.equal(w.workflow.expenses[0]!.status,action==='workflow.reject'?'rejected':'withdrawn');
  assert.throws(()=>run('expense.review',{id:expenseId,decision:'reviewed'}),/제출된 비용/);
  run('expense.reopen',{id:expenseId},requester);const expense=w.workflow.expenses[0]!;assert.equal(expense.status,'draft');assert.equal(expense.workflowId,undefined);
  assert.equal(expense.history?.some(event=>event.workflowId===id),true);
  run('expense.update',{id:expenseId,date:'2026-09-15',title:'수정 비용',amount:30000,category:'비품',evidenceNote:'R-2'},requester);assert.equal(expense.amount,30000);
 }
});

test('직원 프로필이 없는 관리자가 만든 양식과 본인 요청도 정상 결재할 수 있다',()=>{
 const {w,run,manager}=setup();run('workflow.template.save',{title:'관리자 결재',category:'일반',steps:[{approverIds:['manager'],mode:'all'}]});
 run('workflow.create',{templateId:w.workflow.templates[1]!.id,title:'관리자 요청',body:'본사 문서'},manager);
 const row=w.workflow.requests[1]!;assert.equal(row.employeeId,undefined);run('workflow.submit',{id:row.id},manager);run('workflow.approve',{id:row.id},manager);assert.equal(row.status,'approved');
});
