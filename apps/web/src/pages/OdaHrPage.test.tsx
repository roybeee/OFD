import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { ApiError, normalizeBootstrap } from '../api/client';
import type { HrResponse } from '../api/oda-hr-client';
import { OdaHrPage, hrTabs, odaHrLocation } from './OdaHrPage';
import { HrPersonnel } from '../hr/HrPersonnel';
import { AppShell } from '../components/AppShell';
import { canAccessPath, defaultPathFor } from '../lib/access';

vi.mock('../lib/brand', () => ({ isOdaBrand: true, workstationName: 'ODA 워크스테이션' }));
const api = vi.hoisted(() => ({ get: vi.fn(), command: vi.fn() }));
vi.mock('../api/oda-hr-client', () => ({ getOdaHr: api.get, commandOdaHr: api.command }));

const data = () => normalizeBootstrap({ currentActor: { id: 'manager-1', name: '담당자', role: 'hq_master' },
  stores: [{ id: 'store-1', name: '첫 매장', business: {} }, { id: 'store-2', name: '둘째 매장', business: {} }],
  capabilities: ['oda.master.manage', 'oda.hr.hq.read'], meta: { appMode: 'production', odaSettlementOnly: true } });
function response(storeId = 'store-1'): HrResponse {
  const workspace = createHrWorkspace(storeId, '인사관리 매장', '2026-09-15T00:00:00.000Z');
  return { workspace, permissions: { manage: true, payroll: true, self: false }, accounts: [{ id: 'staff-1', name: '직원 계정', role: 'store_staff' }] };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/hq/oda-hr?tab=overview&store=store-1');
  api.get.mockImplementation(async (storeId: string) => response(storeId));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(text: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  expect(button, `button ${text}`).toBeTruthy(); await act(async () => button!.click());
}
async function fill(name: string, value: string, within: ParentNode = container) {
  const element = within.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  expect(element, `field ${name}`).toBeTruthy();
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function submit(within: ParentNode) {
  await act(async () => within.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function employeeForm() {
  await click('직원·조직'); await click('직원 등록');
  const dialog = container.querySelector('[role="dialog"]')!;
  await fill('name', '새 직원', dialog); await fill('employeeNumber', 'E-001', dialog);
  await fill('hireDate', '2026-09-01', dialog); await fill('basePay', '2500000', dialog);
  await fill('actorId', 'staff-1', dialog);
  return dialog;
}

describe('ODA HR workspace integration', () => {
  it('routes staff help to working personal pages and back to the same store home without writes', async () => {
    const staffData = normalizeBootstrap({ currentActor: { id: 'staff-1', name: '직원', role: 'store_staff' },
      stores: [{ id: 'store-1', name: '첫 매장', business: {} }, { id: 'store-2', name: '둘째 매장', business: {} }],
      capabilities: ['oda.hr.read'], meta: { appMode: 'production', odaSettlementOnly: true } });
    api.get.mockImplementation(async (storeId: string) => ({ ...response(storeId), permissions: { manage: false, payroll: false, self: false }, accounts: undefined }));
    window.history.replaceState({}, '', '/store/oda-hr?store=store-2');
    await act(async () => root.render(<OdaHrPage data={staffData} notify={vi.fn()} />));
    await click('더 보기', container.querySelector('nav[aria-label="직원 앱 메뉴"]')!);
    await click('인사 도움말');
    expect(container.textContent).toContain('직원 이용 안내');
    expect(container.textContent).not.toContain('조직과 직원 등록');
    expect(container.textContent).not.toContain('직원 화면 준비 현황');
    await click('내 근무 기록 열기');
    expect(container.querySelector('.hr-content')?.getAttribute('aria-label')).toBe('근무 기록');
    const menu = container.querySelector<HTMLSelectElement>('[aria-label="내 인사 메뉴"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(menu, 'help'); menu.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('직원 홈에서 일정·공지 확인');
    expect(container.querySelector('.oda-staff-page')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('store')).toBe('store-2');
    expect(api.command).not.toHaveBeenCalled();
  });

  it('adds HR to ODA navigation for assigned staff and preserves financial home priorities', async () => {
    expect(canAccessPath('/store/oda-hr', ['oda.hr.read'])).toBe(true);
    expect(canAccessPath('/hq/oda-hr', ['oda.hr.read'])).toBe(false);
    expect(defaultPathFor(['oda.hr.read'])).toBe('/store/oda-hr');
    expect(defaultPathFor(['oda.master.manage', 'oda.hr.hq.read'])).toBe('/hq/oda-master');
    await act(async () => root.render(<AppShell role="store" path="/store/oda-hr" appMode="local" actorName="직원" actorRole="store_staff" storeName="매장" deliveryCount={0} capabilities={['oda.hr.read']} onNavigate={vi.fn()} onLogout={vi.fn()}><div /></AppShell>));
    expect(container.querySelector('nav[aria-label="주요 메뉴"] [aria-current="page"]')?.textContent).toContain('직원 홈');
    expect(container.querySelector('nav')?.textContent).not.toContain('월 손익');
  });

  it('validates URL state against assigned stores and renders all modules from empty server data', async () => {
    expect(odaHrLocation('?store=foreign&tab=unknown', [{ id: 's1' }])).toEqual({ storeId: 's1', tab: 'overview' });
    expect(odaHrLocation('?store=s2&tab=leave', [{ id: 's1' }, { id: 's2' }])).toEqual({ storeId: 's2', tab: 'leave' });
    await act(async () => root.render(<OdaHrPage data={data()} notify={vi.fn()} />));
    expect(api.get).toHaveBeenCalledWith('store-1', expect.any(AbortSignal));
    expect(container.textContent).toContain('첫 구성원부터 등록');
    for (const [id, label] of hrTabs) {
      await click(label, container.querySelector('nav[aria-label="인사관리 메뉴"]')!);
      expect(container.querySelector('.hr-content')?.getAttribute('aria-label')).toBe(label);
      expect(new URLSearchParams(window.location.search).get('tab')).toBe(id);
    }
    expect(api.command).not.toHaveBeenCalled();
  });

  it('saves an explicitly entered employee and updates the visible server workspace', async () => {
    const saved = response(); saved.workspace.version = 1;
    saved.workspace.employees.push({ id: 'employee-1', employeeNumber: 'E-001', name: '새 직원', actorId: 'staff-1', departmentId: '', jobTitle: '', employmentType: 'regular', status: 'active', hireDate: '2026-09-01', payType: 'monthly', basePay: 2500000, history: [] });
    api.command.mockResolvedValue(saved);
    const notify = vi.fn(); await act(async () => root.render(<OdaHrPage data={data()} notify={notify} />));
    const dialog = await employeeForm(); await submit(dialog);
    expect(api.command).toHaveBeenCalledWith('store-1', 0, 'employee.create', expect.objectContaining({ employeeNumber: 'E-001', name: '새 직원', basePay: 2500000, actorId: 'staff-1' }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('새 직원'); expect(notify).toHaveBeenCalledOnce();
  });

  it('preserves form input on CAS conflict, refreshes the version, and retries with that version', async () => {
    const latest = response(); latest.workspace.version = 8;
    api.get.mockResolvedValueOnce(response()).mockResolvedValue(latest);
    api.command.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.')).mockResolvedValueOnce({ ...latest, workspace: { ...latest.workspace, version: 9 } });
    const notify = vi.fn(); await act(async () => root.render(<OdaHrPage data={data()} notify={notify} />));
    const dialog = await employeeForm(); await submit(dialog);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"] input[name="name"]')?.getAttribute('name')).toBe('name');
    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('새 직원');
    expect(container.textContent).toContain('최신 정보를 불러왔습니다'); expect(notify).not.toHaveBeenCalled();
    await submit(container.querySelector('[role="dialog"]')!);
    expect(api.command.mock.calls[1][1]).toBe(8); expect(notify).toHaveBeenCalledOnce();
  });

  it('preserves business conflict messages without pretending there was a version conflict', async () => {
    api.command.mockRejectedValue(new ApiError(409, 'HR_EMPLOYEE_NUMBER_EXISTS', '이미 사용 중인 사번입니다.'));
    await act(async () => root.render(<OdaHrPage data={data()} notify={vi.fn()} />));
    await submit(await employeeForm());
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('이미 사용 중인 사번');
    expect(container.textContent).not.toContain('최신 정보를 불러왔습니다');
    expect((container.querySelector('[name="employeeNumber"]') as HTMLInputElement).value).toBe('E-001');
  });

  it('shows permission errors without invented records and allows explicit refresh', async () => {
    api.get.mockRejectedValueOnce(new ApiError(403, 'HR_ACCESS_DENIED', '이 매장의 인사관리 권한이 없습니다.')).mockResolvedValueOnce(response());
    await act(async () => root.render(<OdaHrPage data={data()} notify={vi.fn()} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('인사관리 권한이 없습니다');
    expect(container.querySelector('.hr-content')).toBeNull();
    await click('다시 불러오기'); expect(container.textContent).toContain('첫 구성원부터 등록');
    expect(api.command).not.toHaveBeenCalled();
  });

  it('blocks edits if refreshing a conflicted workspace fails until a successful refresh', async () => {
    api.get.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('연결 끊김')).mockResolvedValue(response());
    api.command.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '버전 충돌'));
    await act(async () => root.render(<OdaHrPage data={data()} notify={vi.fn()} />));
    await submit(await employeeForm());
    expect(container.textContent).toContain('최신 정보를 다시 불러온 뒤');
    expect(container.querySelector<HTMLFieldSetElement>('[role="dialog"] fieldset')!.disabled).toBe(true);
    await click('입력 유지하고 다시 불러오기', container.querySelector('[role="dialog"]')!);
    expect(container.querySelector<HTMLFieldSetElement>('[role="dialog"] fieldset')!.disabled).toBe(false);
    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('새 직원');
  });

  it('hides salary placeholders and manager actions from the employee directory', async () => {
    const value = response(); value.permissions = { manage: false, payroll: false, self: true }; value.employeeId = 'me';
    value.workspace.employees.push({ id: 'other', name: '동료 직원', employeeNumber: 'E-002', departmentId: '', jobTitle: '크루', employmentType: 'regular', status: 'active', hireDate: '', payType: 'monthly', basePay: 0, history: [] });
    await act(async () => root.render(<HrPersonnel workspace={value.workspace} permissions={value.permissions} actorId="actor-self" employeeId="me" busy={false} mutate={vi.fn()} tab="people" onTabChange={vi.fn()} />));
    expect([...container.querySelectorAll('button')].some(row => row.textContent === '직원 등록')).toBe(false);
    await click('상세 보기');
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('기본 월급');
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('0원');
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('정보 수정');
  });
});


function linkedStaffData() {
  return normalizeBootstrap({ currentActor: { id: 'staff-1', name: '직원', role: 'store_staff' },
    stores: [{ id: 'store-1', name: '첫 매장', business: {} }, { id: 'store-2', name: '둘째 매장', business: {} }],
    capabilities: ['oda.hr.read'], meta: { appMode: 'production', odaSettlementOnly: true } });
}
function linkedStaffResponse(storeId: string): HrResponse {
  const value=response(storeId); value.permissions={ manage:false,payroll:false,self:true }; value.employeeId=`employee-${storeId}`; delete value.accounts;
  value.workspace.employees=[{ id:value.employeeId,actorId:'staff-1',name:`${storeId} 직원`,employeeNumber:'E1',departmentId:'',jobTitle:'크루',employmentType:'regular',status:'active',hireDate:'2026-01-01',payType:'monthly',basePay:0,history:[] }];
  value.workspace.attendance.leaveTypes=[{ id:'annual',name:'연차',paid:true,deductBalance:false,unitMinutes:30,requireApproval:true }];
  return value;
}
async function selectByLabel(label: string,value: string) {
  const select=container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(select).toBeTruthy();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,value);select.dispatchEvent(new Event('change',{bubbles:true}));});
}

describe('staff intent and browser navigation integration',()=>{
  it('opens leave creation directly from the home quick action without creating a request',async()=>{
    api.get.mockImplementation(async(storeId:string)=>linkedStaffResponse(storeId));
    window.history.replaceState({},'','/store/oda-hr?store=store-1&view=today');
    await act(async()=>root.render(<OdaHrPage data={linkedStaffData()} notify={vi.fn()}/>));
    await click('휴가 등록');
    const dialog=container.querySelector('[role="dialog"]')!;
    expect(dialog?.getAttribute('aria-label')).toBe('휴가 신청');
    expect(dialog.querySelector('[name="startDate"]')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('action')).toBe('create');
    expect(api.command).not.toHaveBeenCalled();
    await click('닫기',dialog);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const refresh=container.querySelector<HTMLButtonElement>('[aria-label="인사 정보 새로고침"]')!;
    await act(async()=>refresh.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('clears the record destination when changing stores rather than opening a same-ID record in the new store',async()=>{
    api.get.mockImplementation(async(storeId:string)=>{
      const value=linkedStaffResponse(storeId);
      value.workspace.attendance.leaveRequests=[{id:'shared-id',employeeId:value.employeeId!,typeId:'annual',startDate:'2026-09-16',endDate:'2026-09-16',slots:[{date:'2026-09-16',startTime:'09:00',endTime:'18:00',minutes:480}],minutes:480,paid:true,note:`${storeId} 신청 사유`,status:'pending',revision:1,createdAt:'2026-09-15T00:00:00Z',createdBy:'staff-1',reviewedAt:'',reviewedBy:''}];
      return value;
    });
    window.history.replaceState({},'','/store/oda-hr?store=store-1&view=tasks&tab=leave&record=shared-id');
    await act(async()=>root.render(<OdaHrPage data={linkedStaffData()} notify={vi.fn()}/>));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('store-1 신청 사유');
    await click('닫기',container.querySelector('[role="dialog"]')!);
    await selectByLabel('인사관리 매장','store-2');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('store-1 신청 사유');
    expect(new URLSearchParams(window.location.search).get('store')).toBe('store-2');
    expect(new URLSearchParams(window.location.search).has('record')).toBe(false);
    expect(api.command).not.toHaveBeenCalled();
  });

  it('keeps the current store URL and interface when Back is pressed during a notice write after switching stores',async()=>{
    const values=new Map(['store-1','store-2'].map(storeId=>{
      const value=linkedStaffResponse(storeId);
      value.workspace.notices=[{id:`notice-${storeId}`,title:`${storeId} 운영 공지`,body:'확인이 필요한 운영 안내',pinned:false,status:'published',createdBy:'manager',createdAt:'2026-09-15T00:00:00Z',updatedAt:'2026-09-15T00:00:00Z'}];
      return [storeId,value] as const;
    }));
    api.get.mockImplementation(async(storeId:string)=>values.get(storeId)!);
    let finish!:(value:HrResponse)=>void;
    api.command.mockImplementation(()=>new Promise<HrResponse>(resolve=>{finish=resolve;}));
    window.history.replaceState({},'','/store/oda-hr?store=store-1&view=today');
    await act(async()=>root.render(<OdaHrPage data={linkedStaffData()} notify={vi.fn()}/>));
    await click('더 보기',container.querySelector('nav[aria-label="직원 앱 메뉴"]')!);
    await selectByLabel('직원 홈 매장','store-2');
    await click('공지');
    const dialog=container.querySelector('[role="dialog"]')!;
    const titleButton=[...dialog.querySelectorAll('button')].find(row=>row.textContent?.includes('store-2 운영 공지'))!;
    await act(async()=>titleButton.click());
    await click('확인했어요',dialog);
    expect(api.command).toHaveBeenCalledExactlyOnceWith('store-2',0,'notice.acknowledge',{id:'notice-store-2',updatedAt:'2026-09-15T00:00:00Z'});
    await act(async()=>{
      const popped=new Promise<void>(resolve=>window.addEventListener('popstate',()=>resolve(),{once:true}));
      window.history.back(); await popped;
    });
    expect(new URLSearchParams(window.location.search).get('store')).toBe('store-2');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="직원 홈 매장"]')?.value).toBe('store-2');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('store-2 운영 공지');
    await act(async()=>finish({...values.get('store-2')!,workspace:{...values.get('store-2')!.workspace,version:1}}));
    expect(new URLSearchParams(window.location.search).get('store')).toBe('store-2');
    expect(api.command).toHaveBeenCalledTimes(1);
  });
});
