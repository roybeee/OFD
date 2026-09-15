import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { HqAccountsPage } from '../pages/HqAccountsPage';
import type { BootstrapData } from '../types';
vi.mock('../lib/brand', () => ({ isOdaBrand: true, workstationName: 'ODA 워크스테이션' }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('shows only local settlement/account navigation and accurately labels local storage', async () => {
  await act(async () => root.render(<AppShell appMode="local" role="hq" path="/hq/oda-settlement" actorName="지원자" actorRole="hq_finance" storeName="등록 매장" deliveryCount={0} capabilities={['oda.finance.read', 'hq.accounts.manage', 'hq.orders.read', 'hq.shipments.manage', 'hq.pos.read', 'hq.invoices.read']} onNavigate={vi.fn()} onLogout={vi.fn()}><main>정산</main></AppShell>));
  expect([...container.querySelectorAll('nav button')].map(button => button.textContent)).toEqual(['ODA 월 정산', '계정 관리']);
  expect(container.textContent).toContain('이 컴퓨터에 저장 · 외부 공유 안 됨');
  expect(container.textContent).toContain('운영 지원자 B');
  expect(container.textContent).not.toContain('운영 API 연결');
});
it('loads local accounts without querying unsupported page policy and hides unsupported roles and settings', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).not.toContain('access-policy');
    return new Response(JSON.stringify({ actors: [{ id: 'a1', name: '지원자', role: 'hq_finance', storeIds: ['s1'], email: 'partner@example.com', active: true, version: 1 }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const data = { actor: { id: 'm1', name: '관리자', role: 'hq_master' }, stores: [{ id: 's1', name: '매장' }], meta: { appMode: 'local' } } as BootstrapData;
  await act(async () => root.render(<HqAccountsPage data={data} notify={vi.fn()} />));
  expect(container.textContent).toContain('partner@example.com');
  expect([...container.querySelectorAll('#account-role option')].map(item => item.getAttribute('value'))).toEqual(['store_owner', 'store_staff', 'hq_finance', 'hq_master', 'auditor']);
  expect(container.querySelector('[aria-label="지원자 상세 설정 열기"]')).toBeNull();
  expect(container.querySelector('[aria-label="지원자 비밀번호 재설정"]')).toBeTruthy();
  expect(container.textContent).not.toContain('역할별 노출');
});
