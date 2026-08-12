import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen, StepUpDialog } from './AuthGate';

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
