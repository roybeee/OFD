import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  deactivateActorV2,
  listActorAccountsV2,
  newIdempotencyKey,
  provisionActorV2,
  resetActorV2,
} from '../api/client';
import { LockKeyhole, RefreshCcw, ShieldCheck, UserRound, UserRoundPlus, X } from '../components/icons';
import { useAccessibleDialog } from '../components/useAccessibleDialog';
import { Button } from '../components/ui';
import type { AdminActorSummary, BootstrapData, ProvisionableActorRole } from '../types';

type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;

const roles: Array<{ value: ProvisionableActorRole; label: string }> = [
  { value: 'store_owner', label: '점주' },
  { value: 'store_staff', label: '매장 직원' },
  { value: 'driver', label: '배송기사' },
  { value: 'hq_ops', label: '본사 운영' },
  { value: 'hq_finance', label: '본사 재무' },
  { value: 'hq_master', label: '본사 최고관리자' },
  { value: 'auditor', label: '감사자' },
];
const storeRoles = new Set<ProvisionableActorRole>(['store_owner', 'store_staff']);
const privilegedRoles = new Set<ProvisionableActorRole>(['hq_ops', 'hq_finance', 'hq_master', 'auditor']);

function roleLabel(role: string) {
  return roles.find((item) => item.value === role)?.label ?? role;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function HqAccountsPage({ data, notify, onCurrentSessionRevoked }: {
  data: BootstrapData;
  notify: Notify;
  onCurrentSessionRevoked?: () => void;
}) {
  const [actors, setActors] = useState<AdminActorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ProvisionableActorRole>('store_owner');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminActorSummary | null>(null);

  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const result = await listActorAccountsV2();
      setActors(result.actors);
    } catch (error) {
      setLoadError(errorMessage(error, '계정 목록을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const storesRequired = storeRoles.has(role);
  const mfaRequired = privilegedRoles.has(role);
  const canSubmit = name.trim().length >= 2 && email.trim() && password.length >= 12
    && (!storesRequired || storeIds.length > 0) && (!mfaRequired || mfaSecret.trim().length >= 16);

  function changeRole(nextRole: ProvisionableActorRole) {
    setRole(nextRole);
    setFormError('');
    if (!storeRoles.has(nextRole)) setStoreIds([]);
    if (!privilegedRoles.has(nextRole)) setMfaSecret('');
  }

  function toggleStore(storeId: string) {
    setStoreIds((current) => current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId]);
  }

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setFormError('');
    try {
      const result = await provisionActorV2({
        name: name.trim(), role, storeIds: storesRequired ? storeIds : [], email: email.trim().toLowerCase(), password,
        ...(mfaRequired ? { mfaSecret: mfaSecret.trim().toUpperCase().replace(/\s/g, '') } : {}),
      }, newIdempotencyKey());
      setActors((current) => [result.actor, ...current.filter((actor) => actor.id !== result.actor.id)]);
      setName('');
      setEmail('');
      setPassword('');
      setMfaSecret('');
      setStoreIds([]);
      notify(`${result.actor.name} 계정을 생성했습니다.`, 'success');
    } catch (error) {
      setFormError(errorMessage(error, '계정을 생성하지 못했습니다.'));
    } finally {
      setSubmitting(false);
    }
  }

  function replaceActor(updated: AdminActorSummary) {
    setActors((current) => current.map((actor) => actor.id === updated.id ? updated : actor));
  }

  async function deactivate(actor: AdminActorSummary) {
    if (!window.confirm(`${actor.name} 계정을 비활성화할까요? 현재 세션이 모두 종료됩니다.`)) return;
    try {
      const result = await deactivateActorV2(actor.id, actor.version, newIdempotencyKey());
      replaceActor(result.actor);
      notify(`${actor.name} 계정을 비활성화했습니다.`, 'success');
    } catch (error) {
      notify(errorMessage(error, '계정을 비활성화하지 못했습니다.'), 'warning');
    }
  }

  const counts = useMemo(() => ({
    active: actors.filter((actor) => actor.active).length,
    store: actors.filter((actor) => storeRoles.has(actor.role as ProvisionableActorRole)).length,
    hq: actors.filter((actor) => privilegedRoles.has(actor.role as ProvisionableActorRole)).length,
  }), [actors]);

  return (
    <main id="main-content" className="page page-hq accounts-page" tabIndex={-1}>
      <section className="page-heading hq-heading">
        <div><p className="eyebrow"><span /> HQ IDENTITY</p><h1>계정 관리</h1><p>점주·매장 직원·배송기사·본사 계정을 안전하게 생성하고 관리합니다.</p></div>
        <div className="heading-tools"><Button variant="secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshCcw size={17} /> 새로고침</Button></div>
      </section>

      <section className="account-metrics" aria-label="계정 현황">
        <article><span><UserRound size={20} /></span><div><small>활성 계정</small><strong>{counts.active}개</strong></div></article>
        <article><span><UserRoundPlus size={20} /></span><div><small>매장 계정</small><strong>{counts.store}개</strong></div></article>
        <article><span><ShieldCheck size={20} /></span><div><small>본사·감사 계정</small><strong>{counts.hq}개</strong></div></article>
      </section>

      <div className="accounts-layout">
        <section className="panel account-create-panel" aria-labelledby="create-account-title">
          <header><span className="panel-symbol"><UserRoundPlus size={22} /></span><div><h2 id="create-account-title">새 계정 만들기</h2><p>초기 로그인 정보는 안전한 채널로 당사자에게 전달해 주세요.</p></div></header>
          <form onSubmit={createAccount} noValidate>
            <label htmlFor="account-role">계정 유형
              <select id="account-role" value={role} onChange={(event) => changeRole(event.target.value as ProvisionableActorRole)}>
                {roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label htmlFor="account-name">이름
              <input id="account-name" required minLength={2} maxLength={100} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label htmlFor="account-email">로그인 이메일
              <input id="account-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label htmlFor="account-password">초기 비밀번호
              <input id="account-password" type="password" required minLength={12} maxLength={200} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint" />
              <small id="account-password-hint" className="field-hint">12자 이상. 생성 후 화면에 다시 표시되지 않습니다.</small>
            </label>
            {storesRequired && (
              <fieldset className="store-assignment">
                <legend>배정 매장 <span aria-hidden="true">*</span></legend>
                <p>하나 이상의 운영 매장을 선택하세요.</p>
                <div>{data.stores.map((store) => (
                  <label key={store.id} htmlFor={`account-store-${store.id}`}>
                    <input id={`account-store-${store.id}`} type="checkbox" checked={storeIds.includes(store.id)} onChange={() => toggleStore(store.id)} />
                    <span>{store.name}</span>
                  </label>
                ))}</div>
              </fieldset>
            )}
            {mfaRequired && (
              <label htmlFor="account-mfa">TOTP 비밀키
                <input id="account-mfa" type="password" required minLength={16} maxLength={128} autoComplete="off" spellCheck={false} value={mfaSecret} onChange={(event) => setMfaSecret(event.target.value)} aria-describedby="account-mfa-hint" />
                <small id="account-mfa-hint" className="field-hint">인증 앱 등록용 Base32 키입니다. 저장 후 다시 표시되지 않습니다.</small>
              </label>
            )}
            {formError && <p className="form-alert" role="alert">{formError}</p>}
            <Button type="submit" disabled={!canSubmit || submitting}>{submitting ? '생성 중…' : '계정 생성'}</Button>
          </form>
        </section>

        <section className="panel account-list-panel" aria-labelledby="account-list-title" aria-busy={loading}>
          <header><div><h2 id="account-list-title">등록 계정</h2><p>비밀번호와 TOTP 키는 목록에 노출되지 않습니다.</p></div><strong>{actors.length}개</strong></header>
          {loadError && <div className="account-load-error" role="alert"><p>{loadError}</p><Button type="button" variant="secondary" onClick={() => void load()}>다시 시도</Button></div>}
          {loading && <p className="account-loading" role="status">계정 목록을 불러오는 중입니다…</p>}
          {!loading && !loadError && actors.length === 0 && <p className="account-loading">등록된 계정이 없습니다.</p>}
          {!loading && actors.length > 0 && (
            <ul className="account-list">
              {actors.map((actor) => (
                <li key={actor.id} className={!actor.active ? 'inactive' : ''}>
                  <span className="account-avatar" aria-hidden="true">{actor.name.slice(0, 1)}</span>
                  <div className="account-identity"><strong>{actor.name}</strong><span>{actor.email}</span><small>{actor.storeIds.map((id) => data.stores.find((store) => store.id === id)?.name ?? id).join(', ') || '매장 배정 없음'}</small></div>
                  <div className="account-security"><span className={`account-status ${actor.active ? 'active' : 'inactive'}`}>{actor.active ? '활성' : '비활성'}</span><small>{roleLabel(actor.role)} · MFA {actor.mfaEnabled ? '사용' : '미사용'}</small>{actor.lockedUntil && <em>로그인 잠김</em>}</div>
                  <div className="account-actions">
                    <Button type="button" variant="secondary" aria-label={`${actor.name} 자격정보 재설정`} onClick={() => setResetTarget(actor)}>자격정보 재설정</Button>
                    <Button type="button" variant="danger" aria-label={`${actor.name} 계정 비활성화`} disabled={!actor.active || actor.id === data.actor.id} onClick={() => void deactivate(actor)}>비활성화</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="safety-strip"><LockKeyhole size={25} /><div><strong>민감정보 비표시 원칙</strong><p>비밀번호 해시와 TOTP 비밀키는 API 응답과 이 화면 어디에도 표시되지 않습니다.</p></div><span className="safe-mode">SANITIZED ADMIN VIEW</span></section>
      {resetTarget && <ResetAccountDialog actor={resetTarget} onClose={() => setResetTarget(null)} onSaved={(updated) => {
        replaceActor(updated);
        setResetTarget(null);
        if (updated.id === data.actor.id) onCurrentSessionRevoked?.();
        else notify(`${updated.name} 자격정보를 재설정했습니다.`, 'success');
      }} />}
    </main>
  );
}

function ResetAccountDialog({ actor, onClose, onSaved }: {
  actor: AdminActorSummary;
  onClose: () => void;
  onSaved: (actor: AdminActorSummary) => void;
}) {
  const [password, setPassword] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useAccessibleDialog(() => { if (!busy) onClose(); });
  const privileged = privilegedRoles.has(actor.role as ProvisionableActorRole);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || password.length < 12) return;
    setBusy(true);
    setError('');
    try {
      const result = await resetActorV2(actor.id, actor.version, password,
        mfaSecret.trim() ? mfaSecret.trim().toUpperCase().replace(/\s/g, '') : undefined, newIdempotencyKey());
      setPassword('');
      setMfaSecret('');
      onSaved(result.actor);
    } catch (caught) {
      setError(errorMessage(caught, '자격정보를 재설정하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="step-up-dialog account-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-account-title" tabIndex={-1}>
        <header><span className="auth-symbol"><LockKeyhole size={24} /></span><div><p className="eyebrow"><span /> CREDENTIAL RESET</p><h2 id="reset-account-title">{actor.name} 자격정보 재설정</h2></div><button type="button" className="icon-button" aria-label={`${actor.name} 재설정 닫기`} onClick={onClose} disabled={busy}><X size={20} /></button></header>
        <p>새 비밀번호를 저장하면 이 계정의 기존 로그인 세션이 모두 종료됩니다.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="reset-password">새 비밀번호
            <input data-dialog-initial id="reset-password" type="password" minLength={12} maxLength={200} required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {privileged && <label htmlFor="reset-mfa">새 TOTP 비밀키 (선택)
            <input id="reset-mfa" type="password" minLength={16} maxLength={128} autoComplete="off" spellCheck={false} value={mfaSecret} onChange={(event) => setMfaSecret(event.target.value)} aria-describedby="reset-mfa-hint" />
            <small id="reset-mfa-hint" className="field-hint">비워 두면 현재 MFA 등록을 유지합니다.</small>
          </label>}
          {error && <p className="form-alert" role="alert">{error}</p>}
          <footer><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>취소</Button><Button type="submit" disabled={busy || password.length < 12}>{busy ? '저장 중…' : '재설정'}</Button></footer>
        </form>
      </section>
    </div>
  );
}
