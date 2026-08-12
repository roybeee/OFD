import { useEffect, useState } from 'react';
import { Button } from './ui';
import { X } from './icons';

/** 안드로이드 Chrome이 설치 가능 시점에 던지는 이벤트(표준화 전 API라 타입을 직접 둔다). */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const DISMISS_KEY = 'ofd.install.dismissed';

/* 사파리 사생활 보호 모드·저장소 차단 환경에서는 localStorage 접근 자체가 던진다.
 * 설치 안내는 부가 기능이므로 실패해도 앱 동작을 막지 않는다. */
const dismissedBefore = () => {
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
};
const rememberDismissal = () => {
  try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 저장 못 해도 이번 세션은 닫힌다 */ }
};

const isStandalone = () => Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches)
  || (window.navigator as { standalone?: boolean }).standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent)
  /* iPadOS 13+는 데스크톱 Safari로 위장하므로 터치 지원으로 함께 판별한다 */
  || (/macintosh/i.test(window.navigator.userAgent) && window.navigator.maxTouchPoints > 1);

/**
 * 홈 화면 설치 안내.
 * - 안드로이드: 브라우저가 주는 설치 프롬프트를 버튼으로 연결한다.
 * - iOS: 사파리는 설치 프롬프트를 제공하지 않으므로 '공유 → 홈 화면에 추가' 절차를 안내한다.
 * 이미 설치해 실행 중이거나 사용자가 닫았으면 다시 뜨지 않는다.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [showIosGuide, setShowIosGuide] = useState(false);

  useEffect(() => {
    if (isStandalone() || dismissedBefore()) return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    /* iOS는 위 이벤트가 없다 — 모바일 사파리로 접속한 경우에만 수동 안내를 띄운다 */
    if (isIos()) setShowIosGuide(true);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  function dismiss() {
    rememberDismissal();
    setDeferred(null);
    setShowIosGuide(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  if (!deferred && !showIosGuide) return null;

  return (
    <aside className="install-prompt" role="complementary" aria-label="앱 설치 안내" data-testid="install-prompt">
      <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width={38} height={38} />
      <div className="install-copy">
        <strong>홈 화면에 앱으로 추가</strong>
        {deferred
          ? <span>설치하면 주소창 없이 앱처럼 열리고, 다음부터 아이콘으로 바로 들어옵니다.</span>
          : <span>사파리 하단 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>를 누르면 앱처럼 사용할 수 있어요.</span>}
      </div>
      {deferred && <Button type="button" onClick={() => void install()}>설치</Button>}
      <button type="button" className="icon-button" aria-label="설치 안내 닫기" onClick={dismiss}><X size={18} /></button>
    </aside>
  );
}
