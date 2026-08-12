import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, loginV2 } from '../api/client';
import type { PublicActor } from '../types';
import { LockKeyhole, ShieldCheck } from './icons';
import { useAccessibleDialog } from './useAccessibleDialog';
import { Button } from './ui';

function messageFor(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function LoginScreen({ onAuthenticated }: { onAuthenticated: (actor: PublicActor) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await loginV2(email.trim(), password);
      if (!result.authenticated) throw new Error('로그인에 실패했습니다. 다시 시도해 주세요.');
      onAuthenticated(result.actor);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="auth-title">
        <span className="auth-symbol" aria-hidden="true"><LockKeyhole size={28} /></span>
        <p className="eyebrow"><span /> SECURE OFD WORKSPACE</p>
        <h1 id="auth-title">OFD 워크스테이션 로그인</h1>
        <p>점주·매장 직원·배송기사·본사 담당자 계정으로 로그인해 주세요.</p>

        <form onSubmit={submitLogin} noValidate>
          <label htmlFor="login-email">이메일
            <input ref={emailRef} id="login-email" type="email" autoComplete="username" inputMode="email" required value={email}
              aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined}
              onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label htmlFor="login-password">비밀번호
            <input id="login-password" type="password" autoComplete="current-password" required value={password}
              aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p className="form-alert" id="login-error" role="alert">{error}</p>}
          <Button type="submit" disabled={busy || !email.trim() || !password}>{busy ? '로그인 중…' : '로그인'}</Button>
        </form>
        <small>비밀번호는 OFD 운영 담당자도 확인할 수 없습니다.</small>
      </section>
    </main>
  );
}

/** 최초 로그인(또는 관리자 재설정) 직후 강제 비밀번호 변경 화면. 바꾸기 전에는 업무 화면에 들어갈 수 없다. */
export function ForcePasswordChangeScreen({ onSubmit, onLogout }: {
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentRef = useRef<HTMLInputElement>(null);
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 10 && next === confirm;

  useEffect(() => { currentRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setError('');
    setBusy(true);
    try {
      await onSubmit(current, next);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="force-password-title" data-testid="force-password-screen">
        <span className="auth-symbol" aria-hidden="true"><ShieldCheck size={28} /></span>
        <p className="eyebrow"><span /> FIRST SIGN-IN</p>
        <h1 id="force-password-title">비밀번호를 변경해 주세요</h1>
        <p>관리자가 발급한 초기 비밀번호로 로그인했습니다. 안전을 위해 본인만 아는 비밀번호로 바꿔야 업무 화면을 사용할 수 있습니다.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="force-current">현재 비밀번호
            <input ref={currentRef} id="force-current" type="password" required autoComplete="current-password"
              value={current} onChange={(event) => setCurrent(event.target.value)} />
          </label>
          <label htmlFor="force-next">새 비밀번호
            <input id="force-next" type="password" required minLength={10} maxLength={200} autoComplete="new-password"
              value={next} onChange={(event) => setNext(event.target.value)} aria-describedby="force-next-hint" />
          </label>
          <small id="force-next-hint" className="field-hint">10자 이상, 숫자·특수문자 포함.</small>
          <label htmlFor="force-confirm">새 비밀번호 확인
            <input id="force-confirm" type="password" required minLength={10} maxLength={200} autoComplete="new-password"
              value={confirm} onChange={(event) => setConfirm(event.target.value)} aria-invalid={mismatch} />
          </label>
          {mismatch && <p className="form-alert" role="alert">새 비밀번호가 서로 일치하지 않습니다.</p>}
          {error && <p className="form-alert" role="alert">{error}</p>}
          <Button type="submit" disabled={!canSubmit || busy}>{busy ? '변경 중…' : '비밀번호 변경하고 시작'}</Button>
          <Button type="button" variant="ghost" onClick={onLogout} disabled={busy}>다른 계정으로 로그인</Button>
        </form>
      </section>
    </main>
  );
}

export function StepUpDialog({ onSubmit, onCancel }: {
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useAccessibleDialog(() => { if (!busy) onCancel(); });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await onSubmit(password);
    } catch (caught) {
      setError(messageFor(caught));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="step-up-dialog" role="dialog" aria-modal="true" aria-labelledby="step-up-title"
        aria-describedby="step-up-description" tabIndex={-1}>
        <header>
          <span className="auth-symbol" aria-hidden="true"><ShieldCheck size={24} /></span>
          <div>
            <p className="eyebrow"><span /> SECURITY CHECK</p>
            <h2 id="step-up-title">중요 작업 본인 확인</h2>
          </div>
        </header>
        <p id="step-up-description">계정·정산 등 중요한 정보를 변경하기 전에 비밀번호를 다시 확인합니다.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="step-up-password">비밀번호
            <input data-dialog-initial id="step-up-password" type="password" autoComplete="current-password" required value={password}
              aria-invalid={Boolean(error)} aria-describedby={error ? 'step-up-error' : undefined}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p id="step-up-error" className="form-alert" role="alert">{error}</p>}
          <footer>
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>취소</Button>
            <Button type="submit" disabled={busy || !password}>{busy ? '확인 중…' : '확인 후 계속'}</Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function UnauthorizedScreen({ onLogout, logoutError = '', logoutPending = false }: {
  onLogout: () => void;
  logoutError?: string;
  logoutPending?: boolean;
}) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="unauthorized-title">
        <span className="auth-symbol" aria-hidden="true"><LockKeyhole size={28} /></span>
        <p className="eyebrow"><span /> ACCESS CONTROL</p>
        <h1 id="unauthorized-title">접근 가능한 업무가 없습니다</h1>
        <p>현재 계정에 워크스테이션 메뉴 권한이 배정되지 않았습니다. 본사 관리자에게 권한을 요청해 주세요.</p>
        {logoutError && <p className="form-alert" role="alert">{logoutError} 현재 로그인 상태는 유지됩니다. 아래 버튼으로 다시 시도해 주세요.</p>}
        <a className="button button-primary" href="/">워크스테이션 홈으로 돌아가기</a>
        <Button type="button" variant="secondary" onClick={onLogout} disabled={logoutPending}>{logoutPending ? '로그아웃 중…' : logoutError ? '로그아웃 다시 시도' : '다른 계정으로 로그인'}</Button>
      </section>
    </main>
  );
}
