import { LockKeyhole } from './icons';
import { Button } from './ui';

export function SessionRequiredScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="auth-title">
        <span className="auth-symbol" aria-hidden="true"><LockKeyhole size={28} /></span>
        <p className="eyebrow"><span /> OFD SESSION REQUIRED</p>
        <h1 id="auth-title">기존 워크스테이션 로그인이 필요합니다</h1>
        <p>OFD 워크스테이션 로그인 화면에서 본사 또는 매장 계정으로 로그인한 뒤 통합 발주·정산 메뉴를 다시 열어 주세요.</p>
        <a className="button button-primary" href="/">로그인 화면으로 이동</a>
        <Button type="button" variant="secondary" onClick={onRetry}>로그인 후 다시 확인</Button>
        <small>별도의 V2 계정이나 비밀번호는 사용하지 않습니다.</small>
      </section>
    </main>
  );
}

export function UnauthorizedScreen({ onLogout }: { onLogout: () => void }) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="unauthorized-title">
        <span className="auth-symbol" aria-hidden="true"><LockKeyhole size={28} /></span>
        <p className="eyebrow"><span /> ACCESS CONTROL</p>
        <h1 id="unauthorized-title">접근 가능한 업무가 없습니다</h1>
        <p>현재 계정에 워크스테이션 메뉴 권한이 배정되지 않았습니다. 본사 관리자에게 권한을 요청해 주세요.</p>
        <a className="button button-primary" href="/">워크스테이션 홈으로 돌아가기</a>
        <Button type="button" variant="secondary" onClick={onLogout}>다른 계정으로 로그인</Button>
      </section>
    </main>
  );
}
