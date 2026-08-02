import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

let container: HTMLDivElement;
let root: Root;

function button(name: RegExp | string) {
  const match = [...container.querySelectorAll('button')].find((element) => {
    const accessibleName = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return typeof name === 'string' ? accessibleName.trim() === name : name.test(accessibleName);
  });
  if (!match) throw new Error(`button not found: ${String(name)}`);
  return match as HTMLButtonElement;
}

function hasHeading(name: string) {
  return [...container.querySelectorAll('h1,h2,h3')].some((element) => element.textContent?.trim() === name);
}

async function waitFor(assertion: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (assertion()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error('condition not reached');
}

async function renderApp() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
    await Promise.resolve();
  });
}

describe('role-aware OFD workspace', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    window.history.replaceState({}, '', '/?role=store&view=orders&demo=1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('guides a novice owner through a three-step order', async () => {
    await renderApp();
    await waitFor(() => hasHeading('발주·입고'));
    await act(async () => button(/새 발주 시작/).click());
    expect(container.textContent).toContain('1. 상품 담기');
    expect(container.textContent).toContain('2. 수량 확인');
    expect(container.textContent).toContain('3. 발주 제출');
  });

  it('switches to the HQ exception queue', async () => {
    await renderApp();
    await waitFor(() => Boolean(container.querySelector('[data-testid="store-order-screen"]')));
    await act(async () => button(/본사 운영/).click());
    await waitFor(() => hasHeading('주문 운영'));
    expect(container.textContent).toContain('확인이 필요한 주문부터 보여드려요');
  });

  it('keeps delivery completion disabled until a proof photo is attached', async () => {
    await renderApp();
    await waitFor(() => Boolean(container.querySelector('[data-testid="store-order-screen"]')));
    await act(async () => button(/배송 기사/).click());
    await waitFor(() => Boolean(container.querySelector('[data-testid="driver-today-screen"]')));
    await act(async () => button(/배송 시작|배송 상세/).click());
    expect(button('배송 완료 처리').disabled).toBe(true);
    expect(container.textContent).toContain('사진을 올려야 완료할 수 있어요');
  });

  it('fails closed instead of silently showing demo data when the live API is down', async () => {
    window.history.replaceState({}, '', '/store/orders');
    await renderApp();
    await waitFor(() => hasHeading('운영 서버에 연결할 수 없습니다'));
    expect(container.textContent).not.toContain('데모 데이터');
    expect(button('다시 연결')).toBeTruthy();
  });
});
