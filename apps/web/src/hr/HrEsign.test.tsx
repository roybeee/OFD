import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { createNativeContract, createNativeEmployer, requestNativeContract, type NativeEsignContext } from '../../../../packages/domain/src/oda-esign';
import { HrEsign, EsignPendingCard } from './HrEsign';
import type { EsignOverview } from '../api/oda-esign-client';
import { ApiError } from '../api/client';
import { esignTiming, matchesEsignTask } from './esign-followup';
import { EsignComparison, comparisonCandidates } from './EsignComparison';
import { esignRegisterCsv, filterEsignRegister } from './esign-register';

const api = vi.hoisted(() => ({ get: vi.fn(), detail: vi.fn(), mutate: vi.fn(), download: vi.fn() }));
vi.mock('../api/oda-esign-client', () => ({ getOdaEsign: api.get, getOdaEsignContract: api.detail, mutateOdaEsign: api.mutate, downloadOdaEsign: api.download }));
function fixture(storeId = 'store-a') {
  let id = 0;
  const ctx: NativeEsignContext = { actorId: 'owner', manager: true, now: new Date().toISOString(), id: () => `record-${++id}`, hash: () => 'a'.repeat(64) };
  const employer = createNativeEmployer({ storeId, legalName: '법인 A', businessNumber: '2208162517', representativeName: '대표', address: '서울 주소', signerActorId: 'owner', signerName: '담당자' }, ctx);
  const contract = requestNativeContract(createNativeContract({ storeId, employeeId: 'employee', employeeActorId: 'staff', employeeName: '김직원', title: '김직원 근로계약서', templateKey: 'test-v1', terms: { employmentType: 'part_time', payType: 'hourly', basePay: 12000, effectiveDate: '2026-09-16', endDate: '', jobTitle: '매장 업무', workplace: '서울 매장', workDays: '월 수 금', dailyWorkHours: '월 수 금 각 8시간', workStart: '09:00', workEnd: '18:00', breakMinutes: 60, payday: '10일', payCalculation: '시급 x 근로시간', payMethod: '계좌이체', holidays: '일요일', annualLeave: '관련 법령에 따라', additionalTerms: '' } }, employer, ctx), { expectedVersion: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() }, ctx);
  const overview: EsignOverview = { storeId, employers: [employer], contracts: [contract], permissions: { manage: false, sign: true }, currentActorId: 'staff' };
  return { contract, employer, overview };
}
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const button = (text: string) => [...container.querySelectorAll('button')].find(row => row.textContent?.includes(text));
async function click(text: string) { const node = button(text); expect(node).toBeTruthy(); await act(async () => node!.click()); }
async function input(name: string, value: string) { const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function render(storeId = 'store-a') { await act(async () => root.render(<HrEsign workspace={createHrWorkspace(storeId, '매장', new Date().toISOString())} actorId="staff" employeeId="employee" permissions={{ manage: false, payroll: false, self: true }} mutate={vi.fn()} busy={false} accounts={[]} />)); }

describe('native employee electronic contract safety', () => {
  it.each([false, true])('prevents stale draft retry after conflict even when refresh fails: %s', async refreshFails => {
    const { contract, overview } = fixture(); contract.status = 'draft'; overview.permissions.manage = true;
    const latest = { ...contract, version: contract.version + 1, terms: { ...contract.terms, basePay: 16000 }, documentText: '동료가 수정한 최신 계약 원문' };
    api.get.mockResolvedValueOnce(overview).mockResolvedValue({ ...overview, contracts: [latest] });
    api.detail.mockResolvedValueOnce({ contract });
    if (refreshFails) api.detail.mockRejectedValueOnce(new Error('새 계약 조회 실패'));
    else api.detail.mockResolvedValue({ contract: latest });
    api.mutate.mockRejectedValueOnce(new ApiError(409, 'ESIGN_VERSION_CONFLICT', '계약이 변경되었습니다.'))
      .mockResolvedValue({ ...overview, contracts: [latest], contract: { ...latest, version: latest.version + 1 } });
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'employee', name: '김직원', employeeNumber: '001', actorId: 'staff', departmentId: '', jobTitle: '매장 업무', employmentType: 'part_time', status: 'active', hireDate: '2026-09-16', payType: 'hourly', basePay: 11000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} />));
    await click('김직원 근로계약서'); await click('초안 수정'); await input('basePay', '12500');
    await click('초안 저장 후 미리보기');
    expect(api.mutate.mock.calls[0][2]).toMatchObject({ expectedVersion: contract.version, terms: { basePay: 12500 } });
    expect(button('초안 저장 후 미리보기')).toBeUndefined();
    if (refreshFails) {
      expect(container.querySelector('form')).toBeNull();
      expect(container.textContent).toContain('계약을 다시 열어 최신 내용을 확인해 주세요.');
      expect(api.mutate).toHaveBeenCalledOnce();
      return;
    }
    expect(container.textContent).toContain('수정 내용은 저장되지 않았습니다. 최신 계약을 확인한 뒤');
    expect(container.textContent).toContain(latest.documentText);
    await click('초안 수정');
    expect(container.querySelector<HTMLInputElement>('[name="basePay"]')!.value).toBe('16000');
    await click('초안 저장 후 미리보기');
    expect(api.mutate.mock.calls[1][2]).toMatchObject({ expectedVersion: latest.version, terms: { basePay: 16000 } });
  });
  it('requires reviewing changed employer and template versions again after a batch conflict', async () => {
    const { contract, employer, overview } = fixture(); overview.permissions.manage = true;
    const { effectiveDate: _start, endDate: _end, ...terms } = contract.terms;
    const template = { id: 'batch-template', storeId: 'store-a', employerId: employer.id, version: 1, name: '공통 시급', active: true, terms, createdAt: contract.createdAt, createdBy: 'owner', updatedAt: contract.createdAt, updatedBy: 'owner' };
    overview.templates = [template]; overview.accounts = [{ id: 'staff', name: '김직원', role: 'store_staff' }];
    const updatedEmployer = { ...employer, version: employer.version + 1, legalName: '변경된 고용주' };
    const updatedTemplate = { ...template, version: template.version + 1, terms: { ...terms, basePay: 15000 } };
    const latest = { ...overview, employers: [updatedEmployer], templates: [updatedTemplate] };
    api.get.mockResolvedValueOnce(overview).mockResolvedValue(latest);
    api.mutate.mockRejectedValueOnce(new ApiError(409, 'ESIGN_VERSION_CONFLICT', '고용주 정보가 변경되었습니다.'))
      .mockResolvedValue({ ...latest, createdContractIds: [] });
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'employee', name: '김직원', employeeNumber: '001', actorId: 'staff', departmentId: '', jobTitle: '매장 업무', employmentType: 'part_time', status: 'active', hireDate: '2026-09-16', payType: 'hourly', basePay: 11000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} onReload={vi.fn()} />));
    await click('저장한 양식'); await click('여러 직원 초안 만들기'); await input('batchStart', '2026-10-01');
    await click('검색 결과 모두 선택'); await click('선택한 직원과 조건 검토');
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('1명 초안 저장');
    expect(container.textContent).toContain('직원·고용주 또는 양식 정보가 갱신되었습니다.');
    expect(container.textContent).toContain('변경된 고용주');
    expect(container.textContent).toContain('새 계약 초안: 시급 15,000원');
    expect(button('1명 초안 저장')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await click('대상자 선택으로'); await click('선택한 직원과 조건 검토');
    expect(button('1명 초안 저장')?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('1명 초안 저장');
    expect(api.mutate.mock.calls[1][2]).toMatchObject({ expectedEmployerVersion: updatedEmployer.version, savedTemplateVersion: updatedTemplate.version, expectedHrVersion: workspace.version });
  });
  it('returns to current templates when a selected batch template was archived', async () => {
    const { contract, employer, overview } = fixture(); overview.permissions.manage = true;
    const { effectiveDate: _start, endDate: _end, ...terms } = contract.terms;
    const template = { id: 'batch-template', storeId: 'store-a', employerId: employer.id, version: 1, name: '공통 시급', active: true, terms, createdAt: contract.createdAt, createdBy: 'owner', updatedAt: contract.createdAt, updatedBy: 'owner' };
    overview.templates = [template]; overview.accounts = [{ id: 'staff', name: '김직원', role: 'store_staff' }];
    api.get.mockResolvedValueOnce(overview).mockResolvedValue({ ...overview, templates: [{ ...template, active: false, version: 2 }] });
    api.mutate.mockRejectedValueOnce(new ApiError(409, 'ESIGN_VERSION_CONFLICT', '양식이 변경되었습니다.'));
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'employee', name: '김직원', employeeNumber: '001', actorId: 'staff', departmentId: '', jobTitle: '매장 업무', employmentType: 'part_time', status: 'active', hireDate: '2026-09-16', payType: 'hourly', basePay: 11000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} />));
    await click('저장한 양식'); await click('여러 직원 초안 만들기'); await input('batchStart', '2026-10-01');
    await click('검색 결과 모두 선택'); await click('선택한 직원과 조건 검토');
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('1명 초안 저장');
    expect(container.textContent).toContain('최신 양식을 확인하고 계약 작성을 다시 시작해 주세요.');
    expect(container.textContent).toContain('보관됨');
    expect(button('1명 초안 저장')).toBeUndefined();
    expect(button('여러 직원 초안 만들기')?.disabled).toBe(true);
  });
  it('exports only filtered rows with safe spreadsheet text and Korean timestamps', () => {
    const { contract } = fixture();
    contract.title = '=HYPERLINK("untrusted")\n쉼표,문구';
    contract.employeeName = '  +SUM(1,1)';
    contract.expiresAt = '2026-09-16T14:59:59Z';
    const now = Date.parse('2026-09-16T15:00:00Z');
    const filter = { employerId: contract.employer.id, search: '쉼표', status: 'pending' as const, task: 'expired' as const };
    const rows = filterEsignRegister([contract, { ...contract, id: 'other', employer: { ...contract.employer, id: 'other-company' } }], filter, 'owner', now);
    expect(rows).toEqual([contract]);
    expect(filterEsignRegister(rows, { ...filter, status: 'draft' }, 'owner', now)).toEqual([]);
    const csv = esignRegisterCsv(rows, now);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""untrusted"")\n쉼표,문구"');
    expect(csv).toContain('"\'  +SUM(1,1)"');
    expect(csv).toContain('2026-09-17 00:00:00');
    expect(csv).toContain('2026-09-16 23:59:59');
    expect(csv).toContain('서명 기한 경과');
    expect(csv).not.toContain(contract.documentText);
    expect(csv).not.toContain('password');
  });
  it('refreshes authorization and data for filtered CSV downloads and blocks revoked manager access', async () => {
    const { contract, overview } = fixture(); overview.permissions.manage = true; overview.currentActorId = 'staff';
    const draft = { ...contract, id: 'draft', title: '검토 초안', status: 'draft' as const };
    api.get.mockResolvedValueOnce({ ...overview, contracts: [contract, draft] })
      .mockResolvedValueOnce({ ...overview, contracts: [contract, { ...draft, title: '최신 초안' }] })
      .mockResolvedValueOnce({ ...overview, permissions: { manage: false, sign: true }, contracts: [] });
    const createUrl = vi.fn().mockReturnValue('blob:csv-test');
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = vi.fn(); });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await render();
      const select = container.querySelector<HTMLSelectElement>('[aria-label="계약 진행 상태"]')!;
      await act(async () => { select.value = 'draft'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(button('김직원 근로계약서')).toBeUndefined();
      await click('계약 관리대장 CSV');
      expect(api.get).toHaveBeenCalledTimes(2); expect(anchorClick).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('계약 1건의 CSV');
      expect(container.textContent).toContain('최신 초안');
      await click('계약 관리대장 CSV');
      expect(anchorClick).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('내려받을 권한이 없습니다');
      expect(button('계약 관리대장 CSV')).toBeUndefined();
      expect(api.mutate).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('compares only the same employee and legal employer, highlights all term changes and switches baselines without writes', async () => {
    const { contract, overview } = fixture(); overview.permissions.manage = true;
    const old = { ...contract, id: 'old-contract', title: '이전 계약', status: 'completed' as const, completedAt: '2026-08-01T15:30:00Z', terms: { ...contract.terms, basePay: 11000, additionalTerms: '주말 근무 협의', effectiveDate: '2026-08-01' } };
    const latest = { ...old, id: 'latest-contract', title: '최근 계약', completedAt: '2026-09-01T12:00:00Z', terms: { ...contract.terms, payType: 'monthly' as const, effectiveDate: '2026-10-01' } };
    const unrelated = [ { ...latest, id: 'another-person', employeeId: 'another' }, { ...latest, id: 'another-account', employeeActorId: 'different-account' },
      { ...latest, id: 'another-employer', employer: { ...latest.employer, id: 'another-company' } }, { ...latest, id: 'another-business', employer: { ...latest.employer, businessNumber: '1234567890' } },
      { ...latest, id: 'another-store', storeId: 'another' }, { ...latest, id: 'uncompleted', status: 'pending' as const } ];
    overview.contracts = [contract, old, ...unrelated, latest];
    expect(comparisonCandidates(contract, overview.contracts).map(row => row.id)).toEqual(['latest-contract', 'old-contract']);
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    await render(); await click('김직원 근로계약서');
    const panel = container.querySelector('[aria-label="체결 계약과 근로조건 비교"]')!;
    expect(panel.textContent).toContain('월급·시급 기준이 달라');
    expect(panel.textContent).toContain('비교 계약의 시작일이 현재 계약보다 나중');
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(3);
    const select = panel.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map(option => option.value)).toEqual(['latest-contract', 'old-contract']);
    await act(async () => { select.value = old.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(panel.textContent).toContain('시급 11,000원');
    expect(panel.textContent).toContain('시급 12,000원');
    expect(panel.textContent).toContain('주말 근무 협의');
    expect(panel.textContent).not.toContain('월급·시급 기준이 달라');
    await click('전체 항목 보기');
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(Object.keys(contract.terms).length);
    expect(api.mutate).not.toHaveBeenCalled();
    overview.permissions.manage = false; api.get.mockResolvedValue({ ...overview, storeId: 'store-b', contracts: [{ ...contract, storeId: 'store-b' }] });
    api.detail.mockResolvedValue({ contract: { ...contract, storeId: 'store-b' } });
    await render('store-b'); await click('김직원 근로계약서');
    expect(container.querySelector('[aria-label="체결 계약과 근로조건 비교"]')).toBeNull();
  });
  it('distinguishes no comparison contract from identical terms', async () => {
    const { contract } = fixture();
    await act(async () => root.render(<EsignComparison current={contract} contracts={[]} busy={false} />));
    expect(container.textContent).toContain('비교 가능한 체결 계약이 없습니다');
    const identical = { ...contract, id: 'identical', status: 'completed' as const };
    await act(async () => root.render(<EsignComparison current={contract} contracts={[identical]} busy={false} />));
    expect(container.textContent).toContain('변경 항목 0개');
    expect(container.textContent).toContain('근로조건이 동일합니다');
  });
  it('reviews a batch before saving, preserves retry identity and opens only newly created drafts', async () => {
    const { contract, overview } = fixture(); overview.permissions.manage = true;
    const { effectiveDate: _start, endDate: _end, ...terms } = contract.terms;
    const template = { id: 'batch-template', storeId: 'store-a', employerId: contract.employer.id, version: 1, name: '공통 시급', active: true, terms, createdAt: contract.createdAt, createdBy: 'owner', updatedAt: contract.createdAt, updatedBy: 'owner' };
    overview.templates = [template]; overview.accounts = [{ id: 'staff', name: '김직원', role: 'store_staff' }];
    api.get.mockResolvedValue(overview);
    const draft = { ...contract, id: 'batch-draft', title: '공통 시급 근로계약서', status: 'draft', version: 1, signatures: [] };
    api.mutate.mockRejectedValueOnce(new Error('응답 연결 끊김')).mockResolvedValueOnce({ ...overview, contracts: [...overview.contracts, draft], createdContractIds: [draft.id] });
    api.detail.mockResolvedValue({ contract: draft });
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'employee', name: '김직원', employeeNumber: '001', actorId: 'staff', departmentId: '', jobTitle: '매장 업무', employmentType: 'part_time', status: 'active', hireDate: '2026-09-16', payType: 'hourly', basePay: 11000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} />));
    await click('저장한 양식'); await click('여러 직원 초안 만들기');
    expect(button('선택한 직원과 조건 검토')?.disabled).toBe(true);
    await input('batchStart', '2026-10-01'); await click('검색 결과 모두 선택'); await click('선택한 직원과 조건 검토');
    expect(api.mutate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('현재 인사정보: 시급 11,000원');
    expect(container.textContent).toContain('새 계약 초안: 시급 12,000원');
    expect(button('1명 초안 저장')?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('1명 초안 저장'); expect(container.textContent).toContain('응답 연결 끊김');
    await click('1명 초안 저장');
    expect(api.mutate.mock.calls[0][3]).toBe(api.mutate.mock.calls[1][3]);
    expect(api.mutate.mock.calls[1][2]).toEqual({ expectedVersion: 0, savedTemplateId: template.id, savedTemplateVersion: 1, expectedEmployerVersion: contract.employer.version,
      expectedHrVersion: workspace.version, title: '공통 시급 근로계약서', effectiveDate: '2026-10-01', endDate: '', employeeIds: ['employee'] });
    expect(container.textContent).toContain('생성한 계약 초안 1건');
    await click('김직원 · 공통 시급 근로계약서');
    expect(api.detail).toHaveBeenCalledWith('store-a', 'batch-draft');
  });
  it('saves reviewed conditions and reuses the employer template without carrying over employee or dates', async () => {
    const { contract, overview } = fixture(); overview.permissions.manage = true;
    const { effectiveDate: _start, endDate: _end, ...conditions } = contract.terms;
    const template = { id: 'saved-template', storeId: 'store-a', employerId: contract.employer.id, version: 1, name: '평일 시급', active: true, terms: conditions, createdAt: contract.createdAt, createdBy: 'owner', updatedAt: contract.createdAt, updatedBy: 'owner' };
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    api.mutate.mockResolvedValueOnce({ ...overview, templates: [template], template }).mockResolvedValueOnce({ ...overview, templates: [template], contract: { ...contract, id: 'new-template-draft', version: 1, status: 'draft', signatures: [] } });
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'different-employee', name: '다른 직원', employeeNumber: '002', actorId: 'other-staff', departmentId: '', jobTitle: '기존 업무', employmentType: 'regular', status: 'active', hireDate: '2026-09-16', payType: 'monthly', basePay: 3500000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} />));
    await click('김직원 근로계약서'); await click('근로조건을 양식으로 저장');
    await input('templateName', '평일 시급'); await click('검토한 조건으로 양식 저장');
    expect(api.mutate.mock.calls[0][1]).toBe('/templates');
    expect(api.mutate.mock.calls[0][2]).toEqual({ expectedVersion: 0, sourceContractId: contract.id, sourceContractVersion: contract.version, name: '평일 시급' });
    await click('이 양식으로 계약 작성');
    const employee = container.querySelector<HTMLSelectElement>('[name="employeeId"]')!;
    expect(employee.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('[name="effectiveDate"]')!.value).toBe('');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(employee, 'different-employee'); employee.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector<HTMLInputElement>('[name="basePay"]')!.value).toBe('12000');
    expect(container.querySelector<HTMLInputElement>('[name="jobTitle"]')!.value).toBe(contract.terms.jobTitle);
    await input('effectiveDate', '2026-10-01'); await click('초안 저장 후 미리보기');
    expect(api.mutate.mock.calls[1][2]).toMatchObject({ expectedVersion: 0, savedTemplateId: template.id, savedTemplateVersion: 1, employerId: template.employerId, employeeId: 'different-employee', terms: { effectiveDate: '2026-10-01', basePay: 12000 } });
    expect(api.mutate.mock.calls[1][2]).not.toHaveProperty('id');
  });
  it('refreshes the employee reminder after returning to the app', async () => {
    const { overview } = fixture();
    api.get.mockResolvedValueOnce({ ...overview, contracts: [] }).mockResolvedValueOnce(overview);
    await act(async () => root.render(<EsignPendingCard storeId="store-a" actorId="staff" onOpen={vi.fn()} />));
    expect(container.querySelector('.esign-employee-card')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('서명할 근로계약 1건');
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it('separates request expiry from employment end dates at the Korean midnight boundary', () => {
    const { contract } = fixture();
    const before = Date.parse('2026-09-16T14:59:59Z'), after = Date.parse('2026-09-16T15:00:00Z');
    contract.expiresAt = new Date(after).toISOString();
    expect(matchesEsignTask(contract, 'mine', 'staff', before)).toBe(true);
    expect(matchesEsignTask(contract, 'mine', 'unrelated', before)).toBe(false);
    expect(matchesEsignTask(contract, 'mine', 'staff', after)).toBe(false);
    expect(matchesEsignTask(contract, 'expired', 'staff', after)).toBe(true);
    contract.status = 'completed'; contract.terms.endDate = '2026-09-16';
    expect(matchesEsignTask(contract, 'expired', 'staff', after)).toBe(false);
    expect(esignTiming(contract, before).daysLeft).toBe(0);
    expect(matchesEsignTask(contract, 'ending', 'staff', before)).toBe(true);
    expect(matchesEsignTask(contract, 'ended', 'staff', after)).toBe(true);
    contract.terms.endDate = '2026-10-17';
    expect(matchesEsignTask(contract, 'ending', 'staff', after)).toBe(true);
    contract.terms.endDate = '2026-10-18';
    expect(matchesEsignTask(contract, 'ending', 'staff', after)).toBe(false);
    contract.terms.endDate = '';
    expect(matchesEsignTask(contract, 'ended', 'staff', after)).toBe(false);
  });
  it('filters expired requests and keeps expired employee reminders visible without offering a signature', async () => {
    const { contract, overview } = fixture(); contract.expiresAt = new Date(Date.now() - 1000).toISOString();
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    await render(); await click('내 서명 대기');
    expect(button('김직원 근로계약서')).toBeUndefined();
    await click('서명 기한 경과'); await click('김직원 근로계약서');
    expect(button('본인 확인 후 서명')).toBeUndefined();
    expect(container.textContent).toContain('서명 기한이 지나 서명할 수 없습니다.');
    await act(async () => root.render(<EsignPendingCard storeId="store-a" actorId="staff" onOpen={vi.fn()} />));
    expect(container.textContent).toContain('서명 기한 경과 1건');
  });
  it('copies only editable conditions into a fresh unsigned draft and requires new dates', async () => {
    const { contract, overview } = fixture(); contract.status = 'completed';
    contract.terms.employmentType = 'contract'; contract.terms.endDate = '2026-09-30';
    overview.permissions.manage = true;
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    api.mutate.mockResolvedValue({ ...overview, contract: { ...contract, id: 'new-draft', version: 1, status: 'draft', signatures: [], documentHash: '', expiresAt: '', terms: { ...contract.terms, effectiveDate: '2026-10-01', endDate: '2027-09-30' } } });
    const workspace = createHrWorkspace('store-a', '매장', new Date().toISOString());
    workspace.employees.push({ id: 'employee', name: '김직원', employeeNumber: '001', actorId: 'staff', departmentId: '', jobTitle: '매장 업무', employmentType: 'contract', status: 'active', hireDate: '2026-09-16', payType: 'hourly', basePay: 12000, history: [] });
    await act(async () => root.render(<HrEsign workspace={workspace} actorId="owner" permissions={{ manage: true, payroll: false, self: false }} mutate={vi.fn()} busy={false} accounts={[]} />));
    await click('김직원 근로계약서'); await click('기존 조건으로 새 계약 작성');
    expect(container.querySelector<HTMLInputElement>('[name="effectiveDate"]')!.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('[name="endDate"]')!.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('[name="basePay"]')!.value).toBe('12000');
    expect(container.querySelector('canvas')).toBeNull(); expect(api.mutate).not.toHaveBeenCalled();
    await input('effectiveDate', '2026-10-01'); await input('endDate', '2027-09-30');
    await click('초안 저장 후 미리보기');
    expect(api.mutate).toHaveBeenCalledWith('store-a', '/contracts', expect.objectContaining({ expectedVersion: 0, terms: expect.objectContaining({ effectiveDate: '2026-10-01', endDate: '2027-09-30' }) }), expect.any(String));
    const sent = api.mutate.mock.calls[0][2];
    for (const key of ['id', 'signatures', 'audit', 'artifacts', 'documentHash', 'appliedAt']) expect(sent).not.toHaveProperty(key);
    await click('초안 수정');
    expect(container.querySelector<HTMLInputElement>('[name="effectiveDate"]')!.value).toBe('2026-10-01');
  });
  it('requires a real signature, explicit consent and password before submitting the exact frozen document and consent snapshot', async () => {
    const { contract, overview } = fixture();
    contract.consentVersion = 'stored-consent-v1'; contract.intentText = '이 계약에 보관된 동의 문구';
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    api.mutate.mockResolvedValue({ ...overview, contract: { ...contract, version: contract.version + 1, signatures: [{ actorId: 'staff', role: 'employee', name: '김직원', at: new Date().toISOString() }] } });
    await render(); await click('김직원 근로계약서');
    expect(container.textContent).toContain(contract.documentText);
    expect(container.textContent).toContain(contract.intentText);
    expect(button('본인 확인 후 서명')?.disabled).toBe(true);
    await input('typedName', '김직원'); await input('password', 'test-password');
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(button('본인 확인 후 서명')?.disabled).toBe(true);
    const canvas = container.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 100 } as DOMRect);
    // Three disconnected taps satisfy the old point-count check but are not a signature.
    for (const x of [10, 70, 170]) for (const type of ['pointerdown', 'pointerup']) {
      await act(async () => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }); Object.defineProperty(event, 'pointerId', { value: 1 }); canvas.dispatchEvent(event); });
    }
    expect(button('본인 확인 후 서명')?.disabled).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
    await click('서명 지우기');
    for (const [type, x, y] of [['pointerdown', 10, 10], ['pointermove', 70, 55], ['pointermove', 170, 15], ['pointerup', 170, 15]] as const) {
      await act(async () => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); canvas.dispatchEvent(event); });
    }
    expect(button('본인 확인 후 서명')?.disabled).toBe(false);
    await click('본인 확인 후 서명');
    expect(api.mutate).toHaveBeenCalledWith('store-a', `/contracts/${contract.id}/sign`, expect.objectContaining({ expectedVersion: contract.version, documentHash: contract.documentHash, consent: true, consentVersion: 'stored-consent-v1', role: 'employee', typedName: '김직원', password: 'test-password' }), expect.any(String));
    expect(api.mutate.mock.calls[0][2].strokes).toEqual([[{ x: .0333, y: .1 }, { x: .2333, y: .55 }, { x: .5667, y: .15 }]]);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('상대방 서명이 완료되면');
  });
  it('clears old store contract data immediately and ignores an old detail response after navigating away', async () => {
    const first = fixture(); api.get.mockResolvedValue(first.overview);
    let finish!: (value: { contract: typeof first.contract }) => void;
    api.detail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('김직원 근로계약서'); await click('계약 목록');
    expect(button('김직원 근로계약서')?.disabled).toBe(false);
    await act(async () => finish({ contract: first.contract }));
    expect(container.querySelector('[aria-label="계약서 전체 내용"]')).toBeNull();
    api.get.mockImplementation(() => new Promise(() => {}));
    await render('store-b');
    expect(container.textContent).not.toContain('김직원 근로계약서');
    expect(container.textContent).not.toContain('법인 A');
  });
  it('reuses the idempotency key after a lost request response and never claims success locally', async () => {
    const { contract, overview } = fixture();
    contract.status = 'draft'; contract.documentHash = ''; contract.expiresAt = '';
    overview.permissions.manage = true; overview.currentActorId = 'owner';
    api.get.mockResolvedValue(overview); api.detail.mockResolvedValue({ contract });
    api.mutate.mockRejectedValueOnce(new Error('연결이 끊겼습니다.')).mockResolvedValueOnce({ ...overview, contract: { ...contract, version: 3, status: 'pending', documentHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86400000).toISOString() } });
    await render(); await click('김직원 근로계약서');
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('앱 내 서명 요청');
    expect(container.textContent).toContain('연결이 끊겼습니다.');
    expect(container.textContent).not.toContain('앱 내 서명 요청을 등록했습니다.');
    await click('앱 내 서명 요청');
    expect(api.mutate).toHaveBeenCalledTimes(2);
    expect(api.mutate.mock.calls[0][3]).toBe(api.mutate.mock.calls[1][3]);
    expect(container.textContent).toContain('앱 내 서명 요청을 등록했습니다.');
  });
  it('keeps legacy records accessible and shows only the current employees pending-signature badge', async () => {
    const { overview } = fixture(); api.get.mockResolvedValue(overview);
    await render(); await click('기존 계약 기록');
    expect(container.textContent).toContain('외부 체결 기록');
    const onOpen = vi.fn();
    await act(async () => root.render(<EsignPendingCard storeId="store-a" actorId="staff" onOpen={onOpen} />));
    await click('서명할 근로계약 1건'); expect(onOpen).toHaveBeenCalledOnce();
    await act(async () => root.render(<EsignPendingCard storeId="store-a" actorId="another" onOpen={onOpen} />));
    expect(container.querySelector('.esign-employee-card')).toBeNull();
  });
});
