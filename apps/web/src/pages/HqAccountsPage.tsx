import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  changePasswordV2,
  deactivateActorV2,
  listActorAccountsV2,
  newIdempotencyKey,
  provisionActorV2,
  resetActorV2,
} from '../api/client';
import { setActorPagesV2, setRolePagesV2, loadAccessSettingsV2, type AccessSettings } from '../api/client';
import { LockKeyhole, RefreshCcw, ShieldCheck, UserRound, UserRoundPlus, X } from '../components/icons';
import { useAccessibleDialog } from '../components/useAccessibleDialog';
import { Button } from '../components/ui';
import type { AdminActorSummary, BootstrapData, ProvisionableActorRole } from '../types';

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

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
const hqRoles = new Set<ProvisionableActorRole>(['hq_ops', 'hq_finance', 'hq_master', 'auditor']);

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
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminActorSummary | null>(null);
  const [detailTarget, setDetailTarget] = useState<AdminActorSummary | null>(null);
  const [access, setAccess] = useState<AccessSettings | null>(null);

  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const [result, accessResult] = await Promise.all([listActorAccountsV2(), loadAccessSettingsV2()]);
      setActors(result.actors);
      setAccess(accessResult);
    } catch (error) {
      setLoadError(errorMessage(error, '계정 목록을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }

  async function refreshAccess() {
    try { setAccess(await loadAccessSettingsV2()); } catch { /* 목록만 유지 */ }
  }

  useEffect(() => { void load(); }, []);

  const storesRequired = storeRoles.has(role);
  const canSubmit = name.trim().length >= 2 && email.trim() && password.length >= 10
    && (!storesRequired || storeIds.length > 0);

  function changeRole(nextRole: ProvisionableActorRole) {
    setRole(nextRole);
    setFormError('');
    if (!storeRoles.has(nextRole)) setStoreIds([]);
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
      }, newIdempotencyKey());
      setActors((current) => [result.actor, ...current.filter((actor) => actor.id !== result.actor.id)]);
      setName('');
      setEmail('');
      setPassword('');
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
    hq: actors.filter((actor) => hqRoles.has(actor.role as ProvisionableActorRole)).length,
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
              <input id="account-password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint" />
              <small id="account-password-hint" className="field-hint">10자 이상, 숫자·특수문자 포함. 생성 후 화면에 다시 표시되지 않습니다.</small>
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
            {formError && <p className="form-alert" role="alert">{formError}</p>}
            <Button type="submit" disabled={!canSubmit || submitting}>{submitting ? '생성 중…' : '계정 생성'}</Button>
          </form>
        </section>

        <section className="panel account-list-panel" aria-labelledby="account-list-title" aria-busy={loading}>
          <header><div><h2 id="account-list-title">등록 계정</h2><p>비밀번호는 목록에 노출되지 않습니다.</p></div><strong>{actors.length}개</strong></header>
          {loadError && <div className="account-load-error" role="alert"><p>{loadError}</p><Button type="button" variant="secondary" onClick={() => void load()}>다시 시도</Button></div>}
          {loading && <p className="account-loading" role="status">계정 목록을 불러오는 중입니다…</p>}
          {!loading && !loadError && actors.length === 0 && <p className="account-loading">등록된 계정이 없습니다.</p>}
          {!loading && actors.length > 0 && (
            <ul className="account-list">
              {actors.map((actor) => {
                const custom = Boolean(access?.actorPages?.[actor.id]);
                return (
                <li key={actor.id} className={!actor.active ? 'inactive' : ''}>
                  <span className="account-avatar" aria-hidden="true">{actor.name.slice(0, 1)}</span>
                  <button type="button" className="account-identity account-open" aria-label={`${actor.name} 상세 설정`} onClick={() => setDetailTarget(actor)}>
                    <strong>{actor.name}</strong><span>{actor.email}</span><small>{actor.storeIds.map((id) => data.stores.find((store) => store.id === id)?.name ?? id).join(', ') || '매장 배정 없음'}</small>
                  </button>
                  <div className="account-security"><span className={`account-status ${actor.active ? 'active' : 'inactive'}`}>{actor.active ? '활성' : '비활성'}</span><small>{roleLabel(actor.role)}{custom ? ' · 개별 페이지' : ''}</small>{actor.lockedUntil && <em>로그인 잠김</em>}</div>
                  <div className="account-actions">
                    <Button type="button" variant="secondary" aria-label={`${actor.name} 상세 설정 열기`} onClick={() => setDetailTarget(actor)}>상세 설정</Button>
                    <Button type="button" variant="secondary" aria-label={`${actor.name} 비밀번호 재설정`} onClick={() => setResetTarget(actor)}>비밀번호 재설정</Button>
                    <Button type="button" variant="danger" aria-label={`${actor.name} 계정 비활성화`} disabled={!actor.active || actor.id === data.actor.id} onClick={() => void deactivate(actor)}>비활성화</Button>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {access && <RolePagesPanel access={access} notify={notify} onSaved={refreshAccess} />}

      <ChangeMyPasswordPanel notify={notify} onChanged={onCurrentSessionRevoked} />

      <section className="safety-strip"><LockKeyhole size={25} /><div><strong>민감정보 비표시 원칙</strong><p>비밀번호 해시는 API 응답과 이 화면 어디에도 표시되지 않습니다.</p></div><span className="safe-mode">SANITIZED ADMIN VIEW</span></section>
      {resetTarget && <ResetAccountDialog actor={resetTarget} onClose={() => setResetTarget(null)} onSaved={(updated) => {
        replaceActor(updated);
        setResetTarget(null);
        if (updated.id === data.actor.id) onCurrentSessionRevoked?.();
        else notify(`${updated.name} 자격정보를 재설정했습니다.`, 'success');
      }} />}
      {detailTarget && access && <AccountDetailDialog actor={detailTarget} access={access} data={data} notify={notify}
        onClose={() => setDetailTarget(null)}
        onReset={() => { setResetTarget(detailTarget); setDetailTarget(null); }}
        onDeactivate={() => { void deactivate(detailTarget); setDetailTarget(null); }}
        onAccessSaved={refreshAccess} />}
    </main>
  );
}

function ResetAccountDialog({ actor, onClose, onSaved }: {
  actor: AdminActorSummary;
  onClose: () => void;
  onSaved: (actor: AdminActorSummary) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useAccessibleDialog(() => { if (!busy) onClose(); });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || password.length < 10) return;
    setBusy(true);
    setError('');
    try {
      const result = await resetActorV2(actor.id, actor.version, password, newIdempotencyKey());
      setPassword('');
      onSaved(result.actor);
    } catch (caught) {
      setError(errorMessage(caught, '비밀번호를 재설정하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="step-up-dialog account-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-account-title" tabIndex={-1}>
        <header><span className="auth-symbol"><LockKeyhole size={24} /></span><div><p className="eyebrow"><span /> PASSWORD RESET</p><h2 id="reset-account-title">{actor.name} 비밀번호 재설정</h2></div><button type="button" className="icon-button" aria-label={`${actor.name} 재설정 닫기`} onClick={onClose} disabled={busy}><X size={20} /></button></header>
        <p>새 비밀번호를 저장하면 이 계정의 기존 로그인 세션이 모두 종료됩니다.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="reset-password">새 비밀번호
            <input data-dialog-initial id="reset-password" type="password" minLength={10} maxLength={200} required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="reset-password-hint" />
            <small id="reset-password-hint" className="field-hint">10자 이상, 숫자·특수문자 포함. 저장 후 화면에 다시 표시되지 않습니다.</small>
          </label>
          {error && <p className="form-alert" role="alert">{error}</p>}
          <footer><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>취소</Button><Button type="submit" disabled={busy || password.length < 10}>{busy ? '저장 중…' : '재설정'}</Button></footer>
        </form>
      </section>
    </div>
  );
}

function ChangeMyPasswordPanel({ notify, onChanged }: { notify: Notify; onChanged?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 10 && next === confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      await changePasswordV2(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      notify('비밀번호를 변경했습니다. 다른 기기의 세션은 모두 종료됩니다.', 'success');
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught, '비밀번호를 변경하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel account-create-panel" aria-labelledby="change-password-title">
      <header><span className="panel-symbol"><LockKeyhole size={22} /></span><div><h2 id="change-password-title">내 비밀번호 변경</h2><p>현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다. 변경하면 다른 기기의 로그인은 종료됩니다.</p></div></header>
      <form onSubmit={submit} noValidate>
        <label htmlFor="my-current-password">현재 비밀번호
          <input id="my-current-password" type="password" required autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
        <label htmlFor="my-new-password">새 비밀번호
          <input id="my-new-password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} aria-describedby="my-new-password-hint" />
          <small id="my-new-password-hint" className="field-hint">10자 이상, 숫자·특수문자 포함.</small>
        </label>
        <label htmlFor="my-confirm-password">새 비밀번호 확인
          <input id="my-confirm-password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} aria-invalid={mismatch} aria-describedby={mismatch ? 'my-confirm-error' : undefined} />
        </label>
        {mismatch && <p id="my-confirm-error" className="form-alert" role="alert">새 비밀번호가 서로 일치하지 않습니다.</p>}
        {error && <p className="form-alert" role="alert">{error}</p>}
        <Button type="submit" disabled={!canSubmit || busy}>{busy ? '변경 중…' : '비밀번호 변경'}</Button>
      </form>
    </section>
  );
}

/** 계정 유형(역할)별로 노출되는 페이지를 설정한다. */
function RolePagesPanel({ access, notify, onSaved }: { access: AccessSettings; notify: Notify; onSaved: () => Promise<void> | void }) {
  const [role, setRole] = useState<ProvisionableActorRole>('store_owner');
  const [busy, setBusy] = useState(false);
  const domain = role === 'driver' ? 'driver' : (role.startsWith('hq_') || role === 'auditor') ? 'hq' : 'store';
  const domainPages = access.pages.filter((page) => page.domain === domain);
  const effective = access.rolePages[role] ?? access.roleDefaults[role] ?? [];
  const [selected, setSelected] = useState<string[]>(effective);

  useEffect(() => {
    setSelected(access.rolePages[role] ?? access.roleDefaults[role] ?? []);
  }, [role, access]);

  const isDefault = !access.rolePages[role];
  const dirty = !sameSet(selected, access.rolePages[role] ?? access.roleDefaults[role] ?? []);

  function toggle(path: string) {
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }

  async function save(pages: string[] | null) {
    setBusy(true);
    try {
      await setRolePagesV2(role, pages, newIdempotencyKey());
      notify(`${roleLabel(role)} 노출 페이지를 저장했습니다.`, 'success');
      await onSaved();
    } catch (error) {
      notify(errorMessage(error, '노출 페이지를 저장하지 못했습니다.'), 'warning');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel account-create-panel access-panel" aria-labelledby="role-pages-title">
      <header><span className="panel-symbol"><ShieldCheck size={22} /></span><div><h2 id="role-pages-title">계정 유형별 노출 페이지</h2><p>계정 유형(역할)마다 보이는 메뉴·페이지를 지정합니다. 계정별로 다르게 하려면 위 목록에서 계정을 눌러 상세 설정하세요.</p></div></header>
      <div className="access-body">
        <label htmlFor="role-pages-role">계정 유형
          <select id="role-pages-role" value={role} onChange={(event) => setRole(event.target.value as ProvisionableActorRole)}>
            {roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <p className="access-status">{isDefault ? '기본값 사용 중' : '개별 지정됨'}</p>
        <fieldset className="access-pages">
          <legend>노출 페이지</legend>
          <div className="access-page-grid">
            {domainPages.map((page) => (
              <label key={page.path} className="access-page-option">
                <input type="checkbox" checked={selected.includes(page.path)} onChange={() => toggle(page.path)} disabled={busy} />
                <span>{page.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="access-actions">
          <Button type="button" onClick={() => void save(selected)} disabled={busy || !dirty}>{busy ? '저장 중…' : '저장'}</Button>
          <Button type="button" variant="secondary" onClick={() => void save(null)} disabled={busy || isDefault}>기본값으로</Button>
        </div>
      </div>
    </section>
  );
}

/** 등록 계정을 눌렀을 때 열리는 상세 설정: 노출 페이지(계정별) + 비밀번호 재설정·비활성화. */
function AccountDetailDialog({ actor, access, data, notify, onClose, onReset, onDeactivate, onAccessSaved }: {
  actor: AdminActorSummary;
  access: AccessSettings;
  data: BootstrapData;
  notify: Notify;
  onClose: () => void;
  onReset: () => void;
  onDeactivate: () => void;
  onAccessSaved: () => Promise<void> | void;
}) {
  const dialogRef = useAccessibleDialog(() => { if (!busy) onClose(); });
  const domain = actor.role === 'driver' ? 'driver' : (actor.role.startsWith('hq_') || actor.role === 'auditor') ? 'hq' : 'store';
  const domainPages = access.pages.filter((page) => page.domain === domain);
  const roleEffective = access.rolePages[actor.role] ?? access.roleDefaults[actor.role] ?? [];
  const hasOverride = Boolean(access.actorPages[actor.id]);
  const [custom, setCustom] = useState(hasOverride);
  const [selected, setSelected] = useState<string[]>(access.actorPages[actor.id] ?? roleEffective);
  const [busy, setBusy] = useState(false);

  function toggle(path: string) {
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }

  async function saveAccess() {
    setBusy(true);
    try {
      await setActorPagesV2(actor.id, custom ? selected : null, newIdempotencyKey());
      notify(custom ? `${actor.name} 노출 페이지를 개별 지정했습니다.` : `${actor.name}을(를) 역할 기본값으로 되돌렸습니다.`, 'success');
      await onAccessSaved();
      onClose();
    } catch (error) {
      notify(errorMessage(error, '노출 페이지를 저장하지 못했습니다.'), 'warning');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="step-up-dialog account-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="account-detail-title" tabIndex={-1}>
        <header><span className="auth-symbol"><UserRound size={24} /></span><div><p className="eyebrow"><span /> ACCOUNT</p><h2 id="account-detail-title">{actor.name} 상세 설정</h2></div><button type="button" className="icon-button" aria-label={`${actor.name} 상세 설정 닫기`} onClick={onClose} disabled={busy}><X size={20} /></button></header>
        <p className="account-detail-meta">{actor.email} · {roleLabel(actor.role)} · {actor.storeIds.map((id) => data.stores.find((store) => store.id === id)?.name ?? id).join(', ') || '매장 배정 없음'}</p>

        <div className="account-detail-section">
          <h3>노출 페이지</h3>
          <div className="access-page-grid access-mode">
            <label className="access-page-option"><input type="radio" name="access-mode" checked={!custom} onChange={() => setCustom(false)} disabled={busy} /><span>역할 기본값 따르기</span></label>
            <label className="access-page-option"><input type="radio" name="access-mode" checked={custom} onChange={() => { setCustom(true); setSelected(access.actorPages[actor.id] ?? roleEffective); }} disabled={busy} /><span>이 계정만 지정</span></label>
          </div>
          <fieldset className="access-pages" disabled={!custom || busy}>
            <legend className="sr-only">이 계정의 노출 페이지</legend>
            <div className="access-page-grid">
              {domainPages.map((page) => {
                const on = custom ? selected.includes(page.path) : roleEffective.includes(page.path);
                return (
                  <label key={page.path} className="access-page-option">
                    <input type="checkbox" checked={on} onChange={() => toggle(page.path)} disabled={!custom || busy} />
                    <span>{page.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="access-actions"><Button type="button" onClick={() => void saveAccess()} disabled={busy}>{busy ? '저장 중…' : '노출 페이지 저장'}</Button></div>
        </div>

        <div className="account-detail-section">
          <h3>계정 관리</h3>
          <div className="account-actions">
            <Button type="button" variant="secondary" onClick={onReset} disabled={busy}>비밀번호 재설정</Button>
            <Button type="button" variant="danger" onClick={onDeactivate} disabled={busy || !actor.active || actor.id === data.actor.id}>비활성화</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
