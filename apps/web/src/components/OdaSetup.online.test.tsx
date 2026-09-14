// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://oda.example.test"}
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OdaSetupGate, usesOnlineOdaSetup } from './OdaSetup';
vi.mock('../lib/brand', () => ({ isOdaBrand: true }));
const token = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefg';
const expiresAt = '2031-01-02T03:04:05.000Z';
const status = (extra = {}) => ({ enabled: true, initialized: false, setupMode: 'online', expiresAt, expired: false, ...extra });
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  window.history.replaceState({}, '', '/'); window.localStorage.clear(); window.sessionStorage.clear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<StrictMode><OdaSetupGate><p>정상 로그인 화면</p></OdaSetupGate></StrictMode>)); }
async function enter(id: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`#${id}`)!; expect(element).toBeTruthy();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string) { await act(async () => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text); expect(button).toBeTruthy(); button!.click();
}); }
const sample = {
  store: { code: 'oda-test', name: '검증용 매장', openDate: '', business: { businessNumber: '2223344444', legalName: '검증매장상호', representativeName: '검증대표', address: '검증매장주소', businessType: '음식점업', businessCategory: '피자', email: 'store@example.test' } },
  headquarters: { businessNumber: '1112233333', legalName: '검증본부', representativeName: '검증본부대표', address: '검증본부주소', businessType: '서비스업', businessCategory: '운영지원', email: 'hq@example.test' },
  master: { name: '관리자', email: 'master@example.test', password: 'Oda-master-123!' },
  operatorA: { name: '운영자', email: 'operator@example.test', password: 'Oda-operator-123!' },
  partnerB: { name: '지원자', email: 'partner@example.test', password: 'Oda-partner-123!' },
};
async function completeForm() {
  await enter('setup-store-name', sample.store.name); await enter('setup-store-code', sample.store.code); await click('다음');
  for (const target of ['headquarters', 'store'] as const)
    for (const [key, value] of Object.entries(target === 'headquarters' ? sample.headquarters : sample.store.business)) await enter(`setup-${target}-${key}`, value);
  await click('다음');
  for (const role of ['master', 'operatorA', 'partnerB'] as const)
    for (const [key, value] of Object.entries(sample[role])) await enter(`setup-${role}-${key}`, value);
  await click('다음');
}

describe('ODA online setup', () => {
  it('uses HTTPS only for online ODA and allows normal login when setup is not registered', async () => {
    expect(usesOnlineOdaSetup('https://oda.example.test', true)).toBe(true);
    expect(usesOnlineOdaSetup('http://oda.example.test', true)).toBe(false);
    expect(usesOnlineOdaSetup('https://oda.example.test/path', true)).toBe(false);
    expect(usesOnlineOdaSetup('https://oda.example.test', false)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)));
    await render(); expect(container.textContent).toContain('정상 로그인 화면');
  });

  it('accepts a manually entered secret without asking for identities or storing it first', async () => {
    const fetchMock = vi.fn(async () => json(status())); vi.stubGlobal('fetch', fetchMock);
    await render();
    expect(container.textContent).toContain('일회성 설정 키를 입력해 주세요');
    expect(container.querySelector('#setup-store-name')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#setup-token')!.type).toBe('password');
    await enter('setup-token', token); await click('첫 설정 시작');
    expect(container.querySelector('#setup-token')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#setup-store-name')!.value).toBe('');
    expect(container.textContent).not.toContain(token);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(token);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('removes the fragment before any request and submits the secret only as a header after reviewing online storage', async () => {
    window.history.replaceState({}, '', `/#setup=${token}`);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(window.location.hash).toBe('');
      return init?.method === 'POST' ? json({ created: true, storeName: sample.store.name }, 201) : json(status());
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(); await completeForm();
    expect(container.textContent).toContain('ODA 전용 공간에 온라인 저장');
    expect(container.textContent).toContain('올드페리도넛 자료와 구분');
    expect(container.textContent).not.toContain('이 컴퓨터에 저장');
    expect(container.textContent).not.toContain(token);
    expect(container.textContent).not.toContain(sample.master.password);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); await click('매장과 계정 등록');
    const [url, request] = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(url).toBe('/api/v2/oda-setup');
    expect(request?.headers).toMatchObject({ 'x-oda-setup-token': token });
    expect(String(request?.body)).not.toContain(token);
    expect(JSON.parse(String(request?.body))).toMatchObject({ store: { name: sample.store.name }, master: sample.master });
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(container.textContent).toContain('등록이 끝났습니다');
    expect(container.querySelector('input')).toBeNull();
    await click('로그인으로 이동'); expect(container.textContent).toContain('정상 로그인 화면');
  });

  it('does not solicit identities on expiry, and expired setup does not prevent existing users logging in', async () => {
    const fetchMock = vi.fn(async () => json(status({ expired: true }))); vi.stubGlobal('fetch', fetchMock);
    await render(); expect(container.textContent).toContain('설정 키가 만료됐습니다'); expect(container.querySelector('input')).toBeNull();
    await act(async () => root.unmount()); root = createRoot(container);
    fetchMock.mockImplementation(async () => json(status({ initialized: true, expired: false })));
    await render(); expect(container.textContent).toContain('정상 로그인 화면');
  });
});
