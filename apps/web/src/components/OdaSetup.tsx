import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isOdaBrand } from '../lib/brand';
import { Button, SkeletonScreen } from './ui';
import './OdaSetup.css';

const SETUP_PATH = '/api/v2/oda-setup';
export const ODA_LOCAL_ORIGIN = 'http://127.0.0.1:4175';
export function usesLocalOdaSetup(origin: string, odaBrand = isOdaBrand) {
  return odaBrand && origin === ODA_LOCAL_ORIGIN;
}
export function usesOnlineOdaSetup(origin: string, odaBrand = isOdaBrand) {
  if (!odaBrand) return false;
  try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin; }
  catch { return false; }
}

/** The launch token lives only in a ref and the request body; remove it before requesting status. */
export function consumeSetupFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState' | 'state'>) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('setup')) return '';
  const token = params.get('setup') ?? '';
  params.delete('setup');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  return /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : '';
}

type GateStatus = 'checking' | 'ready' | 'setup' | 'error' | 'created';
export function OdaSetupGate({ children }: { children: ReactNode }) {
  const local = usesLocalOdaSetup(window.location.origin);
  const online = usesOnlineOdaSetup(window.location.origin);
  const enabled = local || online;
  const tokenRef = useRef('');
  const [status, setStatus] = useState<GateStatus>(enabled ? 'checking' : 'ready');
  const [retry, setRetry] = useState(0);
  const [storeName, setStoreName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [expired, setExpired] = useState(false);
  useLayoutEffect(() => {
    if (enabled) tokenRef.current = consumeSetupFragment(window.location, window.history) || tokenRef.current;
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStatus('checking');
    void fetch(SETUP_PATH, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404 || (online && response.status === 401)) return 'ready' as const;
        if (!response.ok) throw new Error('SETUP_STATUS_UNAVAILABLE');
        const payload = await response.json() as { enabled?: boolean; initialized?: boolean; setupMode?: string; expiresAt?: string; expired?: boolean };
        if (payload.enabled !== true || typeof payload.initialized !== 'boolean') throw new Error('INVALID_SETUP_STATUS');
        if (online && (payload.setupMode !== 'online' || !payload.expiresAt || !Number.isFinite(Date.parse(payload.expiresAt)))) throw new Error('INVALID_SETUP_STATUS');
        if (!controller.signal.aborted) { setExpiresAt(payload.expiresAt ?? ''); setExpired(payload.expired === true); }
        return payload.initialized ? 'ready' as const : 'setup' as const;
      })
      .then((next) => { if (!controller.signal.aborted) { if (next === 'ready') tokenRef.current = ''; setStatus(next); } })
      .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [enabled, online, retry]);
  if (status === 'ready') return children;
  if (status === 'checking') return <SkeletonScreen />;
  if (status === 'error') return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card"><p className="oda-setup-kicker">ODA · {online ? '온라인 매장 정산' : '이 컴퓨터에서 시작'}</p><h1>설정 상태를 확인하지 못했습니다</h1><p role="alert">{online ? '서버 연결을 확인한 뒤 다시 시도해 주세요.' : 'ODA 실행 창이 열려 있는지 확인한 뒤 다시 시도해 주세요.'} 저장된 매장 정보가 있는지 확인하기 전에는 새로 만들지 않습니다.</p><Button onClick={() => setRetry((value) => value + 1)}>다시 확인</Button></section></main>;
  if (status === 'created') return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card"><p className="oda-setup-kicker">ODA · 준비 완료</p><h1>{storeName} 등록이 끝났습니다</h1><p>등록한 관리자 또는 A·B 계정으로 로그인해 주세요. 각 계정은 첫 로그인 후 비밀번호를 변경합니다.</p><StorageNotice online={online} /><Button onClick={() => setStatus('ready')}>로그인으로 이동</Button></section></main>;
  return <OdaSetup initialToken={tokenRef.current} online={online} expiresAt={expiresAt} expired={expired} onCreated={(name) => { tokenRef.current = ''; setStoreName(name); setStatus('created'); }} />;
}

function StorageNotice({ online }: { online: boolean }) {
  return <div className="oda-setup-notice"><strong>{online ? 'ODA 전용 공간에 온라인 저장' : '이 컴퓨터에 저장 · 외부 공유 안 됨'}</strong><p>{online
    ? '정산 자료는 공용 서버 안의 ODA 전용 데이터베이스에 저장합니다. 올드페리도넛 자료와 구분하며, 등록된 담당자는 각자 기기에서 본인 계정으로 접속합니다.'
    : '자료는 이 컴퓨터에 저장됩니다. A·B가 서로 다른 기기에서 동시에 접속하는 기능은 제공하지 않습니다. 같은 컴퓨터에서 각자 계정으로 로그인하거나 정산서를 내려받아 전달할 수 있습니다.'}</p></div>;
}

type Business = { businessNumber: string; legalName: string; representativeName: string; address: string; businessType: string; businessCategory: string; email: string };
type Account = { name: string; email: string; password: string };
type AccountKey = 'master' | 'operatorA' | 'partnerB';
export type OdaSetupForm = {
  headquarters: Business;
  store: { code: string; name: string; openDate: string; business: Business };
  master: Account; operatorA: Account; partnerB: Account;
};
const blankBusiness = (): Business => ({ businessNumber: '', legalName: '', representativeName: '', address: '', businessType: '', businessCategory: '', email: '' });
const blankAccount = (): Account => ({ name: '', email: '', password: '' });
const emptyForm = (): OdaSetupForm => ({ headquarters: blankBusiness(), store: { code: '', name: '', openDate: '', business: blankBusiness() }, master: blankAccount(), operatorA: blankAccount(), partnerB: blankAccount() });
const emailValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const accountRoles: Array<{ key: AccountKey; title: string; hint: string }> = [
  { key: 'master', title: '관리자', hint: '계정을 관리하고 정산을 확인합니다.' },
  { key: 'operatorA', title: '매장 운영자 A', hint: '자료를 올리고 매월 정산을 확정합니다.' },
  { key: 'partnerB', title: '운영 지원자 B', hint: '이 매장의 증빙·손익·배분 내역을 확인합니다.' },
];
const businessFields: Array<{ key: keyof Business; label: string; type?: string }> = [
  { key: 'businessNumber', label: '사업자등록번호' }, { key: 'legalName', label: '상호·법인명' },
  { key: 'representativeName', label: '대표자명' }, { key: 'address', label: '사업장 주소' },
  { key: 'businessType', label: '업태' }, { key: 'businessCategory', label: '종목' },
  { key: 'email', label: '업무용 이메일', type: 'email' },
];
export function setupStepError(form: OdaSetupForm, step: number): string {
  if (step === 0) {
    if (!form.store.name.trim() || !form.store.code.trim()) return '매장명과 매장 코드를 입력해 주세요.';
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(form.store.code.trim())) return '매장 코드는 영문·숫자·밑줄·하이픈 2~32자로 입력해 주세요.';
    if (form.store.openDate) {
      const date = new Date(`${form.store.openDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.store.openDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== form.store.openDate) return '개점일을 올바른 날짜로 입력해 주세요.';
    }
  }
  if (step === 1) {
    for (const [name, business] of [['운영 본부', form.headquarters], ['매장', form.store.business]] as const) {
      if (businessFields.some(({ key }) => !business[key].trim())) return `${name}의 사업자 정보를 모두 입력해 주세요.`;
      if (!/^\d{10}$/.test(business.businessNumber.replace(/[-\s]/g, ''))) return `${name} 사업자등록번호는 숫자 10자리로 입력해 주세요.`;
      if (!emailValid(business.email)) return `${name} 업무용 이메일을 확인해 주세요.`;
    }
  }
  if (step === 2) {
    for (const { key, title } of accountRoles) {
      const account = form[key];
      if (account.name.trim().length < 2 || !emailValid(account.email)) return `${title}의 이름과 이메일을 확인해 주세요.`;
      if (account.password.length < 12 || account.password.length > 200 || !/\d/.test(account.password) || !/[^A-Za-z0-9\s]/.test(account.password)) return `${title} 비밀번호는 숫자·특수문자를 포함해 12~200자로 입력해 주세요.`;
    }
    if (new Set(accountRoles.map(({ key }) => form[key].email.trim().toLowerCase())).size !== 3) return '관리자·A·B는 서로 다른 이메일을 사용해 주세요.';
  }
  return '';
}

export function OdaSetup({ initialToken, onCreated, online = false, expiresAt = '', expired = false }: {
  initialToken: string; onCreated: (storeName: string) => void; online?: boolean; expiresAt?: string; expired?: boolean;
}) {
  const [form, setForm] = useState(emptyForm);
  const [step, setStep] = useState(0);
  const [token, setToken] = useState(initialToken);
  const [tokenEntered, setTokenEntered] = useState(Boolean(initialToken));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const steps = ['매장', '사업자', '계정', '확인'];
  useEffect(() => { headingRef.current?.focus(); }, [step]);
  const updateStore = (key: 'name' | 'code' | 'openDate', value: string) => setForm((current) => ({ ...current, store: { ...current.store, [key]: value } }));
  const updateBusiness = (target: 'headquarters' | 'store', key: keyof Business, value: string) => setForm((current) => target === 'headquarters'
    ? { ...current, headquarters: { ...current.headquarters, [key]: value } }
    : { ...current, store: { ...current.store, business: { ...current.store.business, [key]: value } } });
  const updateAccount = (target: AccountKey, key: keyof Account, value: string) => setForm((current) => ({ ...current, [target]: { ...current[target], [key]: value } }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const validation = step < 3 ? setupStepError(form, step) : [0, 1, 2].map((index) => setupStepError(form, index)).find(Boolean);
    if (validation) { setError(validation); return; }
    if (step < 3) { setStep((value) => value + 1); return; }
    if (!confirmed) { setError('등록할 정보와 저장 위치를 확인해 주세요.'); return; }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) { setError(online ? '운영 관리자가 발급한 일회성 설정 키를 입력해 주세요.' : 'Start-ODA.command를 다시 열어 자동으로 열린 화면에서 설정을 계속하세요.'); return; }
    if (online ? !usesOnlineOdaSetup(window.location.origin) : !usesLocalOdaSetup(window.location.origin)) { setError(online ? '등록된 HTTPS ODA 주소에서 다시 열어 주세요.' : 'ODA 실행 파일로 이 컴퓨터에서 다시 열어 주세요.'); return; }
    if (online && (expired || !expiresAt || Date.now() >= Date.parse(expiresAt))) { setError('설정 키가 만료됐습니다. 운영 관리자에게 새 설정 키를 요청해 주세요.'); return; }
    setBusy(true);
    try {
      const cleanBusiness = (value: Business) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'businessNumber' ? entry.replace(/[-\s]/g, '') : entry.trim()])) as Business;
      const cleanAccount = (value: Account) => ({ name: value.name.trim(), email: value.email.trim().toLowerCase(), password: value.password });
      const response = await fetch(SETUP_PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(online ? { 'x-oda-setup-token': token } : {}) }, body: JSON.stringify({
        ...(online ? {} : { token }), headquarters: cleanBusiness(form.headquarters), store: { code: form.store.code.trim(), name: form.store.name.trim(), ...(form.store.openDate ? { openDate: form.store.openDate } : {}), business: cleanBusiness(form.store.business) },
        master: cleanAccount(form.master), operatorA: cleanAccount(form.operatorA), partnerB: cleanAccount(form.partnerB),
      }) });
      const result = await response.json().catch(() => null) as { created?: boolean; storeName?: string; error?: { code?: string; message?: string } } | null;
      if (!response.ok || result?.created !== true) {
        if (response.status === 409) throw new Error('이미 등록된 매장이 있습니다. 화면을 새로고침한 뒤 로그인해 주세요.');
        if (result?.error?.code === 'ODA_SETUP_EXPIRED') throw new Error('설정 키가 만료됐습니다. 운영 관리자에게 새 설정 키를 요청해 주세요.');
        if (response.status === 401 || response.status === 403) throw new Error(online ? '설정 키 또는 접속 주소를 확인해 주세요. 운영 관리자가 발급한 일회성 설정 키가 필요합니다.' : '설정 연결을 확인할 수 없습니다. Start-ODA.command를 다시 열어 자동으로 열린 화면에서 설정을 계속하세요.');
        throw new Error(result?.error?.message || (online ? '등록을 완료하지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.' : '등록을 완료하지 못했습니다. 실행 창을 확인하고 다시 시도해 주세요.'));
      }
      const name = result.storeName || form.store.name;
      setToken(''); setForm(emptyForm());
      onCreated(name);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '등록을 완료하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  if (online && expired) return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card"><p className="oda-setup-kicker">ODA · 온라인 첫 설정</p><h1>설정 키가 만료됐습니다</h1><p role="alert">운영 관리자에게 새 일회성 설정 키를 요청해 주세요. 매장이나 계정은 등록하지 않았습니다.</p></section></main>;
  if (!tokenEntered && online) return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card"><p className="oda-setup-kicker">ODA · 온라인 첫 설정</p><h1>일회성 설정 키를 입력해 주세요</h1><p>운영 관리자가 발급한 키가 있어야 첫 매장과 계정을 등록할 수 있습니다.</p><form onSubmit={(event) => {
    event.preventDefault();
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) { setError('발급받은 설정 키 전체를 입력해 주세요.'); return; }
    setError(''); setTokenEntered(true);
  }}><label htmlFor="setup-token">일회성 설정 키<input id="setup-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} minLength={43} maxLength={256} autoComplete="off" autoCapitalize="off" spellCheck={false} required /></label><p className="oda-setup-help">설정 키는 이 화면에서만 사용하며, 등록이 끝나면 다시 사용할 수 없습니다.</p>{expiresAt && <p>사용 기한: {new Date(expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)</p>}{error && <p className="form-alert" role="alert">{error}</p>}<footer className="oda-setup-actions"><Button type="submit">첫 설정 시작</Button></footer></form></section></main>;
  if (!tokenEntered) return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card"><p className="oda-setup-kicker">ODA · 첫 실행 설정</p><h1>ODA 실행 파일에서 시작해 주세요</h1><p>Start-ODA.command를 다시 열어 자동으로 열린 화면에서 설정을 계속하세요.</p><p className="oda-setup-notice">설정 중 화면을 새로고침하거나 주소를 직접 입력하면 최초 설정 연결이 끊어질 수 있습니다. 실행 파일을 다시 열면 저장된 자료는 유지됩니다.</p></section></main>;
  return <main className="oda-setup-shell" id="main-content"><section className="oda-setup-card">
    <header><p className="oda-setup-kicker">ODA · 첫 실행 설정</p><h1>매장 정산을 시작할 준비</h1><p>사업자 정보와 담당 계정을 한 번 등록하면, 다음부터 로그인 후 바로 월 정산을 시작합니다.</p></header>
    <ol className="oda-setup-progress" aria-label="설정 진행 단계">{steps.map((title, index) => <li key={title} className={step === index ? 'current' : step > index ? 'done' : ''} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{title}</li>)}</ol>
    <form onSubmit={submit} noValidate>
      <h2 ref={headingRef} tabIndex={-1}>{['어느 매장을 정산하나요?', '사업자등록증을 기준으로 입력해 주세요', '담당자별 계정을 등록해 주세요', '마지막으로 확인해 주세요'][step]}</h2>
      {step === 0 && <div className="oda-setup-fields">
        <label htmlFor="setup-store-name">매장명<input id="setup-store-name" required maxLength={100} value={form.store.name} onChange={(event) => updateStore('name', event.target.value)} placeholder="실제 매장 이름" /></label>
        <label htmlFor="setup-store-code">매장 코드<input id="setup-store-code" required maxLength={32} value={form.store.code} onChange={(event) => updateStore('code', event.target.value)} autoCapitalize="off" spellCheck={false} aria-describedby="store-code-hint" /><small id="store-code-hint">영문·숫자·밑줄·하이픈 2~32자. 매장을 구분할 때 사용합니다.</small></label>
        <label htmlFor="setup-store-openDate">개점일 <small>(알고 있는 경우)</small><input id="setup-store-openDate" type="date" value={form.store.openDate} onChange={(event) => updateStore('openDate', event.target.value)} /><small>월 중간에 개점했다면 첫 달 정산 기준을 별도로 확인합니다.</small></label>
      </div>}
      {step === 1 && <><p className="oda-setup-help">운영 본부와 매장 사업자를 각각 입력합니다. 계약 당사자 A·B는 다음 단계에서 계정으로 구분합니다.</p>{(['headquarters', 'store'] as const).map((target) => <fieldset key={target}><legend>{target === 'headquarters' ? '운영 본부 사업자' : '매장 사업자'}</legend><div className="oda-setup-fields">{businessFields.map(({ key, label, type }) => <label key={key} htmlFor={`setup-${target}-${key}`}>{label}<input id={`setup-${target}-${key}`} type={type || 'text'} inputMode={key === 'businessNumber' ? 'numeric' : type === 'email' ? 'email' : undefined} required maxLength={key === 'address' ? 300 : key === 'businessNumber' ? 12 : 160} value={(target === 'headquarters' ? form.headquarters : form.store.business)[key]} onChange={(event) => updateBusiness(target, key, event.target.value)} /></label>)}</div></fieldset>)}</>}
      {step === 2 && <><p className="oda-setup-help">서로 다른 이메일을 입력해 주세요. 각 계정은 처음 로그인할 때 초기 비밀번호를 변경합니다.</p>{accountRoles.map(({ key, title, hint }) => <fieldset key={key}><legend>{title}</legend><p>{hint}</p><div className="oda-setup-fields"><label htmlFor={`setup-${key}-name`}>이름<input id={`setup-${key}-name`} required maxLength={100} value={form[key].name} onChange={(event) => updateAccount(key, 'name', event.target.value)} /></label><label htmlFor={`setup-${key}-email`}>로그인 이메일<input id={`setup-${key}-email`} type="email" required autoComplete="off" value={form[key].email} onChange={(event) => updateAccount(key, 'email', event.target.value)} /></label><label htmlFor={`setup-${key}-password`}>초기 비밀번호<input id={`setup-${key}-password`} type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={form[key].password} onChange={(event) => updateAccount(key, 'password', event.target.value)} /><small>숫자·특수문자를 포함한 12자 이상</small></label></div></fieldset>)}</>}
      {step === 3 && <><dl className="oda-setup-summary"><div><dt>매장</dt><dd>{form.store.name} · {form.store.code}</dd></div><div><dt>운영 본부 사업자</dt><dd>{form.headquarters.legalName} · {form.headquarters.businessNumber}</dd></div><div><dt>매장 사업자</dt><dd>{form.store.business.legalName} · {form.store.business.businessNumber}</dd></div>{accountRoles.map(({ key, title }) => <div key={key}><dt>{title}</dt><dd>{form[key].name} · {form[key].email}</dd></div>)}</dl>
        <StorageNotice online={online} /><p className="oda-setup-help">계약 배분 기준은 로그인 후 A·B가 확인합니다. 초기 등록만으로 정산 합의나 지급이 처리되지는 않습니다.</p>
        <label className="oda-setup-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />사업자·담당자 정보를 확인했고, {online ? 'ODA 전용 온라인 공간' : '이 컴퓨터'}에 자료가 저장됨을 이해했습니다.</label>
      </>}
      {error && <p className="form-alert" role="alert">{error}</p>}
      <footer className="oda-setup-actions">{step > 0 && <Button type="button" variant="secondary" disabled={busy} onClick={() => { setStep((value) => value - 1); setError(''); }}>이전</Button>}<Button type="submit" disabled={busy || (step === 3 && !confirmed)}>{busy ? '등록하는 중…' : step === 3 ? '매장과 계정 등록' : '다음'}</Button></footer>
    </form>
  </section></main>;
}
