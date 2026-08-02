import { useState, type FormEvent } from 'react';
import { completeMfaV2, loginV2 } from '../api/client';
import { LockKeyhole, ShieldCheck } from './icons';
import { Button } from './ui';

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await loginV2(email.trim(), password);
      if (result.mfaRequired) {
        if (!result.challengeToken) throw new Error('2단계 인증 정보를 받지 못했습니다. 다시 로그인해 주세요.');
        setChallengeToken(result.challengeToken);
        setPassword('');
      } else {
        onAuthenticated();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '로그인하지 못했습니다.');
    } finally {
      setPending(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await completeMfaV2(challengeToken, code.trim());
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '인증번호를 확인하지 못했습니다.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card" aria-labelledby="auth-title">
        <span className="auth-symbol" aria-hidden="true">{challengeToken ? <ShieldCheck size={28} /> : <LockKeyhole size={28} />}</span>
        <p className="eyebrow"><span /> OFD SECURE ACCESS</p>
        <h1 id="auth-title">{challengeToken ? '2단계 인증' : 'OFD 워크스테이션 로그인'}</h1>
        <p>{challengeToken ? '인증 앱에 표시된 6자리 번호를 입력해 주세요.' : '승인된 계정으로 로그인하면 담당 업무 메뉴만 표시됩니다.'}</p>
        {challengeToken ? (
          <form onSubmit={submitMfa}>
            <label><span>인증번호</span><input data-dialog-initial inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <Button type="submit" disabled={pending || code.trim().length < 6}>{pending ? '확인 중…' : '인증하고 계속'}</Button>
            <button className="auth-back" type="button" onClick={() => { setChallengeToken(''); setCode(''); setError(''); }}>로그인으로 돌아가기</button>
          </form>
        ) : (
          <form onSubmit={submitLogin}>
            <label><span>이메일</span><input autoFocus type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label><span>비밀번호</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <Button type="submit" disabled={pending}>{pending ? '로그인 중…' : '로그인'}</Button>
          </form>
        )}
        <small>계정이나 권한이 필요하면 본사 관리자에게 요청해 주세요.</small>
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
        <Button type="button" variant="secondary" onClick={onLogout}>다른 계정으로 로그인</Button>
      </section>
    </main>
  );
}
