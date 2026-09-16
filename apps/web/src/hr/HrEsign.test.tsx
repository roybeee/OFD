import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { createNativeContract, createNativeEmployer, requestNativeContract, type NativeEsignContext } from '../../../../packages/domain/src/oda-esign';
import { HrEsign, EsignPendingCard } from './HrEsign';
import type { EsignOverview } from '../api/oda-esign-client';

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
