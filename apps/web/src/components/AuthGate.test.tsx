import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginV2 } from '../api/client';
import { LoginScreen, StepUpDialog } from './AuthGate';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  loginV2: vi.fn(),
}));

/* 실행 환경(Node 실험 localStorage)의 window.localStorage는 메서드가 빠진 스텁이라 인메모리 구현으로 대체한다 */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
}

describe('login options (아이디 저장 · 자동 로그인)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAuthenticated = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() });
    vi.mocked(loginV2).mockResolvedValue({
      authenticated: true,
      actor: { id: 'a-1', name: '점주', role: 'store_owner' },
    } as Awaited<ReturnType<typeof loginV2>>);
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // 인트로는 jsdom에서 자동재생이 불가능해 즉시 폼이 뜬다
  async function renderLogin() {
    await act(async () => {
      root = createRoot(container);
      root.render(<LoginScreen onAuthenticated={onAuthenticated} />);
    });
  }

  async function setInput(selector: string, value: string) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function submit() {
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  }

  it('로그인 버튼 아래에 아이디 저장·자동 로그인 체크박스가 있다', async () => {
    await renderLogin();
    const options = container.querySelector('.auth-options')!;
    expect(options).not.toBeNull();
    expect(options.textContent).toContain('아이디 저장');
    expect(options.textContent).toContain('자동 로그인');
    // 기본값: 둘 다 해제
    const boxes = options.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(Array.from(boxes).every((box) => !box.checked)).toBe(true);
  });

  it('아이디 저장을 체크하고 로그인하면 이메일이 저장되고, 다음 렌더에서 미리 채워진다', async () => {
    await renderLogin();
    await setInput('#login-email', 'owner@ofd.local');
    await setInput('#login-password', 'secret-password');
    await act(async () => container.querySelector<HTMLInputElement>('#save-email')!.click());
    await submit();
    expect(window.localStorage.getItem('ofd.login.saved-email')).toBe('owner@ofd.local');

    await act(async () => root.unmount());
    await renderLogin();
    expect(container.querySelector<HTMLInputElement>('#login-email')!.value).toBe('owner@ofd.local');
    expect(container.querySelector<HTMLInputElement>('#save-email')!.checked).toBe(true);
  });

  it('아이디 저장을 해제하고 로그인하면 저장된 이메일이 삭제된다', async () => {
    window.localStorage.setItem('ofd.login.saved-email', 'owner@ofd.local');
    await renderLogin();
    await setInput('#login-password', 'secret-password');
    await act(async () => container.querySelector<HTMLInputElement>('#save-email')!.click()); // 체크 해제
    await submit();
    expect(window.localStorage.getItem('ofd.login.saved-email')).toBeNull();
  });

  it('자동 로그인 체크 시 rememberMe로 로그인하고 선택이 저장된다', async () => {
    await renderLogin();
    await setInput('#login-email', 'owner@ofd.local');
    await setInput('#login-password', 'secret-password');
    await act(async () => container.querySelector<HTMLInputElement>('#auto-login')!.click());
    await submit();
    expect(loginV2).toHaveBeenCalledWith('owner@ofd.local', 'secret-password', true);
    expect(window.localStorage.getItem('ofd.login.auto-login')).toBe('true');
    expect(onAuthenticated).toHaveBeenCalled();
  });

  it('자동 로그인 미체크 시 rememberMe 없이 로그인한다', async () => {
    await renderLogin();
    await setInput('#login-email', 'owner@ofd.local');
    await setInput('#login-password', 'secret-password');
    await submit();
    expect(loginV2).toHaveBeenCalledWith('owner@ofd.local', 'secret-password', false);
    expect(window.localStorage.getItem('ofd.login.auto-login')).toBeNull();
  });
});

describe('login intro video', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderLogin() {
    await act(async () => {
      root = createRoot(container);
      root.render(<LoginScreen onAuthenticated={vi.fn()} />);
    });
  }

  function video() {
    return container.querySelector<HTMLVideoElement>('video.auth-intro-video')!;
  }

  it('영상이 재생되는 동안 로그인 폼을 숨기고, 끝날 때쯤 어두워지며 폼을 보여준다', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();

    const intro = video();
    expect(intro).not.toBeNull();
    expect(intro.getAttribute('src')).toContain('login-intro.mp4');
    expect(intro.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    // 영상 재생 중에는 폼이 없고 건너뛰기만 노출된다
    expect(container.querySelector('#login-email')).toBeNull();
    expect(container.querySelector('.auth-intro-skip')).not.toBeNull();
    expect(container.querySelector('.auth-intro-dim')?.classList.contains('visible')).toBe(false);

    // 끝나기 직전(잔여 1.5초 이내) 시점 도달 → 어두워지며 폼 등장
    Object.defineProperty(intro, 'duration', { configurable: true, value: 8.064 });
    Object.defineProperty(intro, 'currentTime', { configurable: true, value: 7 });
    await act(async () => intro.dispatchEvent(new Event('timeupdate')));

    expect(container.querySelector('.auth-intro-dim')?.classList.contains('visible')).toBe(true);
    expect(container.querySelector('#login-email')).not.toBeNull();
    expect(container.querySelector('#login-password')).not.toBeNull();
    expect(container.querySelector('.auth-intro-skip')).toBeNull();
  });

  it('재생이 실제로 시작되기 전에는 영상을 숨겨 브라우저 재생 버튼 오버레이가 보이지 않게 한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();

    const intro = video();
    // 인앱 브라우저(카카오톡 등)가 일시정지 상태에서 그리는 재생 버튼이 노출되지 않도록,
    // playing 이벤트 전에는 숨김(playing 클래스 없음) + autoplay로 재생을 최대한 앞당긴다
    expect(intro.hasAttribute('autoplay')).toBe(true);
    expect(intro.classList.contains('playing')).toBe(false);

    await act(async () => intro.dispatchEvent(new Event('playing')));
    expect(video().classList.contains('playing')).toBe(true);
  });

  it('playing 이벤트가 누락돼도 재생이 진행 중이면(timeupdate) 영상을 표시한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();

    const intro = video();
    Object.defineProperty(intro, 'duration', { configurable: true, value: 8.064 });
    Object.defineProperty(intro, 'currentTime', { configurable: true, value: 0.4 });
    await act(async () => intro.dispatchEvent(new Event('timeupdate')));
    expect(video().classList.contains('playing')).toBe(true);
    // 초반 재생 중이므로 아직 폼은 나오지 않는다
    expect(container.querySelector('#login-email')).toBeNull();
  });

  it('건너뛰기 버튼을 누르면 즉시 로그인 폼이 나타난다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();
    await act(async () => container.querySelector<HTMLButtonElement>('.auth-intro-skip')!.click());
    expect(container.querySelector('#login-email')).not.toBeNull();
  });

  it('영상이 끝까지 재생되면 폼이 나타난다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();
    await act(async () => video().dispatchEvent(new Event('ended')));
    expect(container.querySelector('#login-email')).not.toBeNull();
  });

  it('자동재생이 거부되면 인트로 없이 바로 폼을 보여준다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('NotAllowedError'));
    await renderLogin();
    expect(container.querySelector('#login-email')).not.toBeNull();
  });

  it('세로(모바일) 화면에서는 세로 버전 영상을 사용한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const original = window.matchMedia;
    vi.stubGlobal('matchMedia', (query: string) => ({
      ...original(query),
      matches: query.includes('orientation: portrait'),
    }));
    try {
      await renderLogin();
      expect(video().getAttribute('src')).toContain('login-intro-portrait.mp4');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('가로 화면에서는 기본(가로) 영상을 사용한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    await renderLogin();
    expect(video().getAttribute('src')).toContain('login-intro.mp4');
    expect(video().getAttribute('src')).not.toContain('portrait');
  });

  it('감속 모션 환경에서는 인트로를 건너뛴다', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const original = window.matchMedia;
    vi.stubGlobal('matchMedia', (query: string) => ({
      ...original(query),
      matches: query.includes('prefers-reduced-motion'),
    }));
    try {
      await renderLogin();
      expect(container.querySelector('#login-email')).not.toBeNull();
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('step-up authentication dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
  });

  it('captures password only, reports server errors, and supports Escape cancellation', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('비밀번호가 올바르지 않습니다.'));
    const onCancel = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(<StepUpDialog onSubmit={onSubmit} onCancel={onCancel} />);
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // MFA 코드 입력은 제거됐다 — 비밀번호 한 칸만 남는다
    expect(container.querySelector('input[inputmode="numeric"]')).toBeNull();

    async function enter(selector: string, value: string) {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await enter('input[type="password"]', 'CorrectHorseBatteryStaple!');
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(onSubmit).toHaveBeenCalledWith('CorrectHorseBatteryStaple!');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('비밀번호가 올바르지 않습니다.');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
