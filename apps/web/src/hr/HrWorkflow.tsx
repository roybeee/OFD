import { useState } from 'react';
import { Button } from '../components/ui';
import { HrDialog, HrEmpty, hrError, hrToday, type HrPanelProps } from './shared';
import { canHrApprove, projectHrWorkflowState, type HrApprovalStep, type HrWorkflowRequest } from '../../../../packages/domain/src/oda-hr-workflow';

import { unavailableStaffRecord, useStaffEntryIntent, type StaffEntryIntent } from './StaffDestination';

const statuses: Record<string,string>={draft:'임시저장',pending:'결재 진행',approved:'승인 완료',rejected:'반려',withdrawn:'회수',submitted:'제출',reviewed:'검토 완료'};
const money=(value:number)=>`${value.toLocaleString('ko-KR')}원`;
export function HrWorkflow(props:HrPanelProps & {tab:'approvals'|'expenses'; entryIntent?: StaffEntryIntent}) {
  const {workspace,permissions,mutate,busy,actorId,tab}=props;
  const [dialog,setDialog]=useState<'request'|'template'|'expense'|'delegation'|'editRequest'|'editExpense'|null>(null);
  const [editId,setEditId]=useState<string|null>(null);
  const [error,setError]=useState('');const [selected,setSelected]=useState<string|null>(null);
  const [selectedExpense,setSelectedExpense]=useState<string|null>(null);
  const [filter,setFilter]=useState('all');const [search,setSearch]=useState('');
  const [steps,setSteps]=useState<HrApprovalStep[]>([{approverIds:[actorId],mode:'all'}]);
  const state=projectHrWorkflowState(workspace.workflow,{actorId, employeeId:props.employeeId, manager:permissions.manage,payroll:permissions.payroll,today:hrToday(),now:new Date().toISOString(),id:()=>''});
  const actors=Array.from(new Map([{id:actorId,name:'나'},...workspace.employees.filter(e=>e.actorId&&e.status==='active').map(e=>({id:e.actorId!,name:e.name}))].map(e=>[e.id,e])).values());
  const name=(id:string)=>actors.find(a=>a.id===id)?.name??'연결된 계정';
  const request=state.requests.find(r=>r.id===selected);
  const editingRequest=state.requests.find(r=>r.id===editId);
  const editingExpense=state.expenses.find(r=>r.id===editId);
  const expense=state.expenses.find(r=>r.id===selectedExpense);
  useStaffEntryIntent(JSON.stringify([workspace.storeId,actorId,props.employeeId,tab]),props.entryIntent,intent=>{
    setDialog(null);setSelected(null);setSelectedExpense(null);setEditId(null);setError('');
    if(intent?.action==='create'){if(permissions.manage||permissions.self)open(tab==='approvals'?'request':'expense');return;}
    if(!intent?.recordId)return;
    const target=(tab==='approvals'?state.requests:state.expenses).find(row=>row.id===intent.recordId);
    if(!target){setError(unavailableStaffRecord);return;}
    setFilter('all');setSearch('');
    if(tab==='approvals')setSelected(target.id);else setSelectedExpense(target.id);
  });
  async function run(type:string,input:Record<string,unknown>,close=false){setError('');try{await mutate(type,input);if(close)setDialog(null);}catch(e){setError(hrError(e));}}
  function open(value:typeof dialog){setSelected(null);setSelectedExpense(null);setError('');setEditId(null);setDialog(value);if(value==='template')setSteps([{approverIds:[actorId],mode:'all'}]);}
  function edit(value:'editRequest'|'editExpense',id:string){setSelected(null);setSelectedExpense(null);setError('');setEditId(id);setDialog(value);}
  function eligible(row:HrWorkflowRequest){return (permissions.manage||permissions.self)&&canHrApprove(row,state,{actorId,...(props.employeeId?{employeeId:props.employeeId}:{}),manager:permissions.manage,payroll:permissions.payroll,today:hrToday(),now:new Date().toISOString(),id:()=>''});}
  const rows=state.requests.filter(r=>(filter==='all'||r.status===filter)&&(r.title.includes(search)||r.category.includes(search)));
  return <div className="hr-workflow">
    <header className="hr-section-heading"><div><h2>{tab==='approvals'?'전자결재':'비용 요청'}</h2><p>{tab==='approvals'?'양식을 선택해 요청하고, 결재 단계별로 처리하세요.':'증빙 정보를 기록하고 승인된 결재 문서와 연결하세요.'}</p></div><div className="hr-actions">
      {tab==='approvals'&&permissions.manage&&<Button type="button" variant="secondary" onClick={()=>open('template')}>결재 양식 만들기</Button>}
      {tab==='approvals'&&(permissions.manage||permissions.self)&&<Button type="button" variant="secondary" onClick={()=>open('delegation')}>대결 설정</Button>}
      {(permissions.manage||permissions.self)&&<Button type="button" onClick={()=>open(tab==='approvals'?'request':'expense')} disabled={busy}>{tab==='approvals'?'결재 요청 작성':'비용 요청 작성'}</Button>}
    </div></header>
    {error&&<p role="alert" className="hr-error">{error}</p>}
    {tab==='approvals'?<>
      <div className="hr-toolbar"><label>문서 검색<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="제목 또는 분류"/></label><label>처리 상태<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체</option>{['draft','pending','approved','rejected','withdrawn'].map(s=><option key={s} value={s}>{statuses[s]}</option>)}</select></label></div>
      {!rows.length?<HrEmpty title="결재 문서가 없습니다">관리자가 결재 양식을 만든 후 요청을 작성할 수 있습니다.</HrEmpty>:<div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>문서</th><th>작성자</th><th>금액</th><th>상태</th><th>진행</th><th>상세</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><strong>{r.title}</strong><small>{r.category}</small></td><td>{name(r.authorId)}</td><td>{money(r.amount)}</td><td><span className="hr-badge">{statuses[r.status]}</span></td><td>{Math.min(r.currentStep+1,r.steps.length)} / {r.steps.length}단계</td><td><Button type="button" variant="ghost" onClick={()=>{setSelected(r.id);setError('');}}>열기</Button></td></tr>)}</tbody></table></div>}
      <details className="hr-card"><summary>결재 양식 · 대결 현황</summary><h3>사용 가능한 양식</h3>{state.templates.filter(t=>!t.archived).map(t=><p key={t.id}>{t.title} · {t.category} · {t.steps.length}단계 {permissions.manage&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run('workflow.template.archive',{id:t.id})}>보관</Button>}</p>)}{!state.templates.some(t=>!t.archived)&&<p>등록한 양식이 없습니다.</p>}<h3>대결</h3>{state.delegations.filter(d=>d.active).map(d=><p key={d.id}>{name(d.fromActorId)} → {name(d.toActorId)} · {d.startDate} ~ {d.endDate} {(permissions.manage||d.fromActorId===actorId)&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run('workflow.delegation.revoke',{id:d.id})}>해제</Button>}</p>)}</details>
    </>:<>
      <p className="hr-inline-note">여기서는 비용의 요청과 증빙 검토를 관리합니다. 월 손익에 반영할 금액과 원본 파일은 기존 <a href={`${window.location.pathname.startsWith('/hq/')?'/hq':'/store'}/oda-settlement?tab=expenses`}>월 손익·정산</a>에서 등록하세요.</p>
      {!state.expenses.length?<HrEmpty title="비용 요청이 없습니다">날짜·금액·증빙의 보관 위치를 기록해 시작하세요.</HrEmpty>:<div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>일자 / 내역</th><th>금액</th><th>증빙 정보</th><th>상태</th><th>처리</th></tr></thead><tbody>{state.expenses.map(e=><tr key={e.id}><td>{e.date}<br/><strong>{e.title}</strong><small>{e.category}</small></td><td>{money(e.amount)}</td><td className="hr-prewrap">{e.evidenceNote}</td><td>{statuses[e.status]}{e.workflowId&&<small>연결 결재: {statuses[state.requests.find(r=>r.id===e.workflowId)?.status??'']??'확인 필요'}</small>}</td><td><Button type="button" variant="ghost" onClick={()=>{setSelectedExpense(e.id);setError('');}}>상세 보기</Button>{e.status==='draft'&&e.authorId===actorId&&(permissions.manage||permissions.self)&&<form onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run('expense.submit',{id:e.id,workflowId:f.get('workflowId')});}}><label>연결할 결재<select name="workflowId" required><option value="">문서 선택</option>{state.requests.filter(r=>r.authorId===actorId&&r.amount===e.amount&&['pending','approved'].includes(r.status)&&!state.expenses.some(other=>other.id!==e.id&&other.workflowId===r.id)).map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label><Button type="submit" disabled={busy}>제출</Button></form>}{e.status==='submitted'&&(permissions.manage||permissions.payroll)&&<div className="hr-actions"><Button type="button" disabled={busy||state.requests.find(r=>r.id===e.workflowId)?.status!=='approved'} onClick={()=>void run('expense.review',{id:e.id,decision:'reviewed'})}>검토 완료</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>void run('expense.review',{id:e.id,decision:'rejected'})}>반려</Button></div>}{e.authorId===actorId&&(permissions.manage||permissions.self)&&<div className="hr-actions">{e.status==='draft'&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>edit('editExpense',e.id)}>수정</Button>}{['draft','submitted'].includes(e.status)&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run('expense.withdraw',{id:e.id})}>회수</Button>}{['rejected','withdrawn'].includes(e.status)&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run('expense.reopen',{id:e.id})}>다시 작성</Button>}</div>}</td></tr>)}</tbody></table></div>}
    </>}
    {expense&&<HrDialog title={expense.title} onClose={()=>setSelectedExpense(null)} busy={busy}>
      <p>{statuses[expense.status]} · {expense.date} · {money(expense.amount)}</p><p>{expense.category}</p>
      <h3>증빙 정보</h3><p className="hr-prewrap">{expense.evidenceNote || '등록된 증빙 정보가 없습니다.'}</p>
      {expense.workflowId&&<p>연결 결재: {statuses[state.requests.find(row=>row.id===expense.workflowId)?.status??'']??'확인 필요'}</p>}
      {expense.workflowId&&state.requests.some(row=>row.id===expense.workflowId)&&<Button type="button" variant="secondary" onClick={()=>{setSelected(expense.workflowId!);setSelectedExpense(null);}}>연결 결재 열기</Button>}
      {expense.authorId===actorId&&(permissions.manage||permissions.self)&&expense.status==='draft'&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>edit('editExpense',expense.id)}>비용 요청 수정</Button>}
    </HrDialog>}
    {request&&<HrDialog title={request.title} onClose={()=>setSelected(null)} busy={busy}><p>{statuses[request.status]} · {money(request.amount)}</p><p className="hr-prewrap">{request.body}</p><ol>{request.steps.map((s,i)=><li key={i}>{s.approverIds.map(name).join(', ')} · {s.mode==='all'?'전원 승인':'한 명 승인'} {i<request.currentStep?'완료':i===request.currentStep&&request.status==='pending'?'진행 중':''}</li>)}</ol><h3>처리 이력</h3>{request.decisions.map((d,i)=><p key={i}>{d.step+1}단계 · {name(d.actorId)} {d.actorId!==d.approverId?`(${name(d.approverId)} 대결)`:''} · {statuses[d.decision]} · {d.at.slice(0,10)}<br/>{d.comment}</p>)}{error&&<p role="alert">{error}</p>}
      {request.authorId===actorId&&(permissions.manage||permissions.self)&&['draft','pending'].includes(request.status)&&<div className="hr-actions">{request.status==='draft'&&<><Button type="button" variant="secondary" disabled={busy} onClick={()=>edit('editRequest',request.id)}>수정</Button><Button type="button" disabled={busy} onClick={()=>void run('workflow.submit',{id:request.id})}>결재 제출</Button></>}<Button type="button" variant="secondary" disabled={busy} onClick={()=>void run('workflow.withdraw',{id:request.id})}>회수</Button></div>}
      {eligible(request)&&<form className="hr-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void run(f.get('decision')==='rejected'?'workflow.reject':'workflow.approve',{id:request.id,comment:f.get('comment')});}}><label>처리<select name="decision"><option value="approved">승인</option><option value="rejected">반려</option></select></label><label>처리 의견<textarea name="comment" maxLength={2000} placeholder="반려할 때는 사유가 필요합니다."/></label><Button type="submit" disabled={busy}>처리하기</Button></form>}
    </HrDialog>}
    {dialog&&<HrDialog title={{request:'결재 요청 작성',template:'결재 양식 만들기',expense:'비용 요청 작성',delegation:'대결 설정',editRequest:'결재 요청 수정',editExpense:'비용 요청 수정'}[dialog]} onClose={()=>setDialog(null)} busy={busy}>
      {error&&<p role="alert" className="hr-error">{error}</p>}
      <form className="hr-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const input=Object.fromEntries(f.entries());
        if(dialog==='template')void run('workflow.template.save',{...input,steps},true);
        if(dialog==='request')void run('workflow.create',{...input,amount:Number(f.get('amount'))},true);
        if(dialog==='expense')void run('expense.create',{...input,amount:Number(f.get('amount'))},true);
        if(dialog==='editRequest')void run('workflow.update',{...input,id:editId,amount:Number(f.get('amount'))},true);
        if(dialog==='editExpense')void run('expense.update',{...input,id:editId,amount:Number(f.get('amount'))},true);
        if(dialog==='delegation')void run('workflow.delegation.save',input,true);
      }}>
      {(dialog==='request'||dialog==='editRequest')&&<>{dialog==='request'&&<label>결재 양식<select name="templateId" required><option value="">선택</option>{state.templates.filter(t=>!t.archived).map(t=><option value={t.id} key={t.id}>{t.title}</option>)}</select></label>}<label>제목<input name="title" required maxLength={200} defaultValue={editingRequest?.title??''}/></label><label>내용<textarea name="body" required maxLength={10000} defaultValue={editingRequest?.body??''}/></label><label>금액 (원)<input name="amount" type="number" min={0} max={1e12} step={1} defaultValue={editingRequest?.amount??0} required/></label></>}
      {dialog==='template'&&<><label>양식 이름<input name="title" required maxLength={120}/></label><label>분류<input name="category" required maxLength={80} placeholder="예: 일반 업무, 비용"/></label><h3>순서대로 진행할 결재 단계</h3>{steps.map((step,index)=><fieldset key={index}><legend>{index+1}단계</legend><label>승인 조건<select value={step.mode} onChange={e=>setSteps(rows=>rows.map((row,i)=>i===index?{...row,mode:e.target.value as 'all'|'any'}:row))}><option value="all">지정한 사람 전원</option><option value="any">지정한 사람 중 한 명</option></select></label>{actors.map(a=><label key={a.id} className="hr-checkbox"><input type="checkbox" checked={step.approverIds.includes(a.id)} onChange={e=>setSteps(rows=>rows.map((row,i)=>i===index?{...row,approverIds:e.target.checked?[...row.approverIds,a.id]:row.approverIds.filter(id=>id!==a.id)}:row))}/>{a.name}</label>)}{steps.length>1&&<Button type="button" variant="ghost" onClick={()=>setSteps(rows=>rows.filter((_,i)=>i!==index))}>단계 삭제</Button>}</fieldset>)}<Button type="button" variant="secondary" disabled={steps.length>=10} onClick={()=>setSteps(rows=>[...rows,{approverIds:[],mode:'all'}])}>단계 추가</Button></>}
      {(dialog==='expense'||dialog==='editExpense')&&<><label>지출일<input name="date" type="date" required defaultValue={editingExpense?.date??hrToday()}/></label><label>내용<input name="title" required maxLength={200} defaultValue={editingExpense?.title??''}/></label><label>금액 (원)<input name="amount" type="number" min={1} max={1e12} step={1} required defaultValue={editingExpense?.amount}/></label><label>분류<input name="category" required maxLength={80} defaultValue={editingExpense?.category??''}/></label><label>증빙 정보<textarea name="evidenceNote" required maxLength={2000} defaultValue={editingExpense?.evidenceNote??''} placeholder="영수증 번호 또는 월 정산 증빙의 파일명·보관 위치"/></label><p>원본 파일은 월 손익·정산의 증빙에 보관하세요.</p></>}
      {dialog==='delegation'&&<><p className="hr-inline-note">대결 기간이 지나거나 해제되면 대결 권한이 사라집니다. 전원 승인 단계에서는 한 사람이 한 번만 승인할 수 있습니다.</p><label>원결재자<select name="fromActorId" required>{actors.filter(a=>permissions.manage||a.id===actorId).map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label><label>대결자<select name="toActorId" required><option value="">선택</option>{actors.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label><label>시작일<input name="startDate" type="date" defaultValue={hrToday()} required/></label><label>종료일<input name="endDate" type="date" defaultValue={hrToday()} required/></label></>}
      <div className="hr-actions"><Button type="submit" disabled={busy}>{busy?'저장 중…':'저장'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>취소</Button></div></form>
    </HrDialog>}
  </div>;
}
