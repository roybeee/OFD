// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:4175"}
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeSetupFragment, OdaSetupGate, setupStepError, usesLocalOdaSetup, type OdaSetupForm } from './OdaSetup';
vi.mock('../lib/brand', () => ({ isOdaBrand: true }));
let root: Root;
let container: HTMLDivElement;
const token = 'a'.repeat(43);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); window.history.replaceState({}, '', '/'); window.localStorage.clear(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<StrictMode><OdaSetupGate><p>정상 로그인 화면</p></OdaSetupGate></StrictMode>)); }
async function enter(id: string, value: string) { await act(async () => { const element = container.querySelector<HTMLInputElement>(`#${id}`)!; expect(element).toBeTruthy(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(text: string) { await act(async () => { const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text); expect(button).toBeTruthy(); button!.click(); }); }
const form: OdaSetupForm = {
  store: { code: 'oda-one', name: '테스트 매장', openDate: '2026-08-12', business: { businessNumber: '2223344444', legalName: '매장상호', representativeName: '매장대표', address: '매장 주소', businessType: '음식점업', businessCategory: '피자', email: 'store@example.com' } },
  headquarters: { businessNumber: '1112233333', legalName: '운영본부', representativeName: '본부대표', address: '본부 주소', businessType: '서비스업', businessCategory: '경영지원', email: 'hq@example.com' },
  master: { name: '관리자', email: 'master@example.com', password: 'Oda-master-123!' },
  operatorA: { name: '운영자', email: 'operator@example.com', password: 'Oda-operator-123!' },
  partnerB: { name: '지원자', email: 'partner@example.com', password: 'Oda-partner-123!' },
};
async function completeForm() {
  for (const key of ['name', 'code', 'openDate'] as const) await enter(`setup-store-${key}`, form.store[key]);
  await click('다음');
  for (const target of ['headquarters', 'store'] as const) for (const [key, value] of Object.entries(target === 'headquarters' ? form.headquarters : form.store.business)) await enter(`setup-${target}-${key}`, value);
  await click('다음');
  for (const target of ['master', 'operatorA', 'partnerB'] as const) for (const [key, value] of Object.entries(form[target])) await enter(`setup-${target}-${key}`, value);
  await click('다음');
}

describe('ODA local initialization', () => {
  it('permits only the exact ODA local origin', () => {
    expect(usesLocalOdaSetup('http://127.0.0.1:4175', true)).toBe(true);
    for (const origin of ['https://127.0.0.1:4175', 'http://localhost:4175', 'http://127.0.0.1:5173', 'https://oda.example.com', 'http://127.0.0.1:4175.evil.example']) expect(usesLocalOdaSetup(origin, true)).toBe(false);
    expect(usesLocalOdaSetup('http://127.0.0.1:4175', false)).toBe(false);
  });
  it('removes the setup token from the fragment and retains unrelated navigation state', () => {
    window.history.replaceState({ view: 'start' }, '', `/hq/oda-settlement?month=2026-08#setup=${token}&view=help`);
    expect(consumeSetupFragment(window.location, window.history)).toBe(token);
    expect(window.location.hash).toBe('#view=help');
    expect(window.location.search).toBe('?month=2026-08');
    expect(window.history.state).toEqual({ view: 'start' });
    expect(window.localStorage.length).toBe(0);
  });
  it('opens normal login on a 404 but blocks on an invalid or failed status response until retry succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ enabled: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    await render();
    expect(container.textContent).toContain('설정 상태를 확인하지 못했습니다');
    expect(container.textContent).not.toContain('정상 로그인 화면');
    fetchMock.mockResolvedValue(json({}, 404));
    await click('다시 확인');
    expect(container.textContent).toContain('정상 로그인 화면');
  });
  it('does not render the wizard for an initialized workstation', async () => {
    window.history.replaceState({}, '', `/#setup=${token}`);
    vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: true, initialized: true })));
    await render();
    expect(window.location.hash).toBe('');
    expect(container.textContent).toContain('정상 로그인 화면');
    expect(container.querySelector('input')).toBeNull();
  });
  it('keeps actual identity fields blank and requests missing values before continuing', async () => {
    window.history.replaceState({}, '', `/#setup=${token}`);
    vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: true, initialized: false })));
    await render();
    expect(container.querySelector<HTMLInputElement>('#setup-store-name')!.value).toBe('');
    await click('다음');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('매장명과 매장 코드');
    expect(container.textContent).not.toContain('사업자등록증을 기준으로 입력해 주세요');
  });
  it('explains how to relaunch before asking for identity data if the setup token is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: true, initialized: false })));
    await render();
    expect(container.textContent).toContain('Start-ODA.command를 다시 열어');
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });
  it('checks distinct account emails, strong passwords, valid dates, and actual business identifiers', () => {
    expect(setupStepError(form, 0)).toBe(''); expect(setupStepError(form, 1)).toBe(''); expect(setupStepError(form, 2)).toBe('');
    expect(setupStepError({ ...form, partnerB: { ...form.partnerB, email: ' MASTER@example.com ' } }, 2)).toContain('서로 다른 이메일');
    expect(setupStepError({ ...form, operatorA: { ...form.operatorA, password: 'longbutnosymbol12' } }, 2)).toContain('숫자·특수문자');
    expect(setupStepError({ ...form, headquarters: { ...form.headquarters, businessNumber: '123' } }, 1)).toContain('숫자 10자리');
    expect(setupStepError({ ...form, store: { ...form.store, openDate: '2026-99-99' } }, 0)).toContain('올바른 날짜');
    expect(setupStepError({ ...form, store: { ...form.store, openDate: '2026-02-30' } }, 0)).toContain('올바른 날짜');
  });
  it('submits token only in the body after review and does not persist secrets even in StrictMode', async () => {
    window.history.replaceState({}, '', `/#setup=${token}`);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(window.location.hash).toBe('');
      return init?.method === 'POST' ? json({ created: true, storeName: form.store.name }, 201) : json({ enabled: true, initialized: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await completeForm();
    expect(container.textContent).toContain('이 컴퓨터에 저장 · 외부 공유 안 됨');
    expect(container.textContent).not.toContain(form.master.password);
    expect(container.querySelector('#setup-token')).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await click('매장과 계정 등록');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(request[0]).toBe('/api/v2/oda-setup');
    expect(JSON.parse(String(request[1]?.body))).toEqual({ token, ...form });
    expect(window.localStorage.length).toBe(0);
    expect(container.textContent).toContain('등록이 끝났습니다');
    expect(container.querySelector('input[type=password]')).toBeNull();
    await click('로그인으로 이동');
    expect(container.textContent).toContain('정상 로그인 화면');
  });
  it('shows a recoverable message after registration failure and never announces success', async () => {
    window.history.replaceState({}, '', `/#setup=${token}`);
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? json({ error: { message: '저장 공간이 부족합니다.' } }, 500) : json({ enabled: true, initialized: false })));
    await render(); await completeForm();
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await click('매장과 계정 등록');
    expect(container.textContent).toContain('저장 공간이 부족합니다.');
    expect(container.textContent).not.toContain('등록이 끝났습니다');
    expect(container.textContent).toContain(form.store.name);
    expect(container.querySelector('#setup-token')).toBeNull();
  });
});
