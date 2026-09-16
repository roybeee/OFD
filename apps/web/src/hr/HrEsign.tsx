import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type NativeContract, type NativeContractTerms, type NativeEmployer } from '../../../../packages/domain/src/oda-esign';
import type { HrResponse } from '../api/oda-hr-client';
import { ApiError, newIdempotencyKey } from '../api/client';
import { downloadOdaEsign, getOdaEsign, getOdaEsignContract, mutateOdaEsign, type EsignOverview } from '../api/oda-esign-client';
import { Button } from '../components/ui';
import { ChevronRight, FileCheck2, RefreshCcw } from '../components/icons';
import { EsignSignaturePad, type EsignStroke } from './EsignSignaturePad';
import { HrTalent } from './HrTalent';
import { HrEmpty, hrDate, hrError, hrToday, type HrPanelProps } from './shared';
import './HrEsign.css';

type Props = HrPanelProps & { accounts: NonNullable<HrResponse['accounts']> };
type View = 'list' | 'create' | 'edit' | 'employers' | 'detail';
const statusName = { draft: '작성 중', pending: '서명 진행 중', completed: '체결 완료', declined: '서명 거절', cancelled: '요청 취소' };
const field = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const businessNumber = (value: string) => value.replace(/^(\d{3})(\d{2})(\d{5})$/, '$1-$2-$3');
const eventName: Record<string, string> = { 'contract.created': '계약 초안 작성', 'contract.updated': '계약 초안 수정', 'contract.requested': '앱 내 서명 요청', 'signature.employer': '사용자 서명', 'signature.employee': '근로자 서명', 'contract.completed': '양측 서명 완료', 'contract.declined': '서명 거절', 'contract.cancelled': '서명 요청 취소', 'copy.employee_download': '근로자 사본 다운로드 요청', 'copy.manual_handover': '담당자 사본 교부 기록', 'hr.applied': '인사정보 반영' };

export function HrEsign(props: Props) {
  const [section, setSection] = useState<'native' | 'legacy'>('native');
  return <section className="esign-panel" aria-label="전자 근로계약"><nav className="esign-subnav" aria-label="계약 구분"><button type="button" aria-pressed={section === 'native'} onClick={() => setSection('native')}>전자계약</button><button type="button" aria-pressed={section === 'legacy'} onClick={() => setSection('legacy')}>기존 계약 기록</button></nav>
    {section === 'legacy' ? <HrTalent {...props} tab="contracts" /> : <NativeContracts key={`${props.workspace.storeId}:${props.actorId}`} {...props} />}
  </section>;
}

function NativeContracts(props: Props) {
  const storeId = props.workspace.storeId;
  const [data, setData] = useState<EsignOverview | null>(null);
  const [detail, setDetail] = useState<NativeContract | null>(null);
  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [retry, setRetry] = useState(0);
  const [editingEmployer, setEditingEmployer] = useState<NativeEmployer | null>(null);
  const alive = useRef(true), locked = useRef(false), detailRequest = useRef(0);
  const retryMutation = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailRequest.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void getOdaEsign(storeId, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(caught => { if (!controller.signal.aborted) setError(hrError(caught)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [storeId, retry]);
  const validData = data?.storeId === storeId ? data : null;
  const manage = Boolean(validData?.permissions.manage);
  const disabled = busy || loading || props.busy;
  async function open(id: string) {
    if (locked.current) return;
    const request = ++detailRequest.current;
    setDetail(null); setView('detail'); setLoading(true); setError(''); setSuccess('');
    try { const result = await getOdaEsignContract(storeId, id); if (alive.current && detailRequest.current === request) setDetail(result.contract); }
    catch (caught) { if (alive.current && detailRequest.current === request) setError(hrError(caught)); }
    finally { if (alive.current && detailRequest.current === request) setLoading(false); }
  }
  function navigate(next: View) { if (locked.current) return; detailRequest.current++; setView(next); setLoading(false); setDetail(null); setError(''); setSuccess(''); }
  async function run(suffix: string, input: Record<string, unknown>, message: string): Promise<boolean> {
    if (locked.current || loading || props.busy) return false;
    locked.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      const { password: _password, ...nonSecretInput } = input;
      const fingerprint = JSON.stringify({ suffix, input: nonSecretInput });
      if (retryMutation.current?.fingerprint !== fingerprint) retryMutation.current = { fingerprint, key: newIdempotencyKey() };
      const result = await mutateOdaEsign(storeId, suffix, input, retryMutation.current.key);
      retryMutation.current = null;
      if (!alive.current) return false;
      setData(result); if (result.contract) { setDetail(result.contract); setView('detail'); }
      if (result.employer) { setEditingEmployer(null); setView('employers'); }
      setSuccess(message);
      if (suffix.endsWith('/apply')) await props.onReload?.();
      return true;
    } catch (caught) {
      if (alive.current) {
        setError(hrError(caught));
        if (caught instanceof ApiError && caught.status === 409) {
          try { const latest = await getOdaEsign(storeId); if (alive.current) setData(latest); if (detail) { const next = await getOdaEsignContract(storeId, detail.id); if (alive.current) setDetail(next.contract); } }
          catch { if (alive.current) { setDetail(null); setError(`${hrError(caught)} 계약을 다시 열어 최신 내용을 확인해 주세요.`); } }
        }
      }
      return false;
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function download(kind: 'pdf' | 'evidence') {
    if (!detail || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await downloadOdaEsign(storeId, detail.id, kind); if (!alive.current) return; setSuccess('다운로드를 요청했습니다. 기기의 저장 파일을 확인해 주세요.'); const next = await getOdaEsignContract(storeId, detail.id); if (alive.current) setDetail(next.contract); }
    catch (caught) { if (alive.current) setError(hrError(caught)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const contracts = validData?.contracts ?? [];
  const list = contracts.filter(row => (filter === 'all' || row.employer.id === filter) && `${row.title} ${row.employeeName} ${row.employer.legalName} ${row.employer.businessNumber}`.includes(search.trim()));
  return <>
    {view !== 'list' && <Button className="esign-back" variant="ghost" disabled={busy} onClick={() => navigate('list')}>← 계약 목록</Button>}
    {error && <div className="hr-error" role="alert"><p>{error}</p>{!busy && <Button variant="secondary" onClick={() => { if (view === 'detail' && detail) void open(detail.id); else { setRetry(value => value + 1); if (view === 'detail') navigate('list'); } }}>다시 불러오기</Button>}</div>}
    {success && <p className="hr-badge" role="status">{success}</p>}
    {loading && <p role="status" className="hr-loading">전자계약 정보를 불러오고 있습니다.</p>}
    {view === 'list' && <>
      <div className="esign-topline"><div><h2>{manage ? '전자 근로계약' : '내 전자계약'}</h2><p>{manage ? '사업자별 계약 작성부터 양측 서명, 사본 교부와 인사 반영까지 관리합니다.' : '계약 내용을 확인하고 서명하세요. 완료된 계약서는 언제든 내려받을 수 있습니다.'}</p></div><div className="esign-actions"><Button variant="secondary" disabled={disabled} onClick={() => setRetry(value => value + 1)} aria-label="전자계약 새로고침"><RefreshCcw size={16} /></Button>{manage && <><Button variant="secondary" disabled={disabled} onClick={() => navigate('employers')}>고용주 관리</Button><Button disabled={disabled || !validData?.employers.some(row => row.active)} onClick={() => navigate('create')}>계약 만들기</Button></>}</div></div>
      {validData && <><div className="esign-stats"><div className="esign-stat"><span>서명 진행</span><strong>{contracts.filter(row => row.status === 'pending').length}</strong></div><div className="esign-stat"><span>체결 완료</span><strong>{contracts.filter(row => row.status === 'completed').length}</strong></div><div className="esign-stat"><span>교부 확인 대기</span><strong>{contracts.filter(row => row.status === 'completed' && !row.deliveries?.some(item => item.method === 'manual_handover')).length}</strong></div><div className="esign-stat"><span>인사 반영 대기</span><strong>{contracts.filter(row => row.status === 'completed' && !row.appliedAt).length}</strong></div></div>
      {manage && !validData.employers.some(row => row.active) && <HrEmpty title="먼저 계약당사자인 고용주를 등록해 주세요.">사업자등록번호와 실제 회사 서명 담당자를 지정하면 계약을 작성할 수 있습니다.</HrEmpty>}
      <div className="esign-toolbar"><label><select aria-label="고용주별 계약" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">전체 고용주</option>{validData.employers.map(row => <option key={row.id} value={row.id}>{row.legalName} · {businessNumber(row.businessNumber)}</option>)}</select></label><label><input type="search" aria-label="계약 검색" placeholder="직원·계약명·사업자번호 검색" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      {!list.length ? <HrEmpty title={search || filter !== 'all' ? '조건에 맞는 계약이 없습니다.' : '등록된 전자계약이 없습니다.'}>{manage ? '고용주와 직원을 선택해 첫 계약을 준비하세요.' : '담당자가 서명을 요청하면 이곳에서 확인할 수 있습니다.'}</HrEmpty> : <div className="esign-list">{list.map(contract => <button className="esign-row" type="button" key={contract.id} disabled={disabled} onClick={() => void open(contract.id)}><span><strong>{contract.title}</strong><small>{contract.employeeName} · {contract.employer.legalName}<br />사업자 {businessNumber(contract.employer.businessNumber)} · 적용 {hrDate(contract.terms.effectiveDate)}</small></span><span className="esign-row-side"><span className={`esign-badge ${contract.status}`}>{statusName[contract.status]}</span>{contract.status === 'pending' && <small>서명 {contract.signatures?.length ?? 0}/2 · {hrDate(contract.expiresAt)}</small>}<ChevronRight size={16} /></span></button>)}</div>}</>}
    </>}
    {view === 'employers' && manage && <><div className="esign-topline"><div><h2>고용주 관리</h2><p>현재 매장에 계약을 체결하는 실제 사업자를 등록합니다. 서명 담당자는 지정한 본인 계정으로 서명합니다.</p></div></div><div className="esign-list">{validData?.employers.map(employer => <div className="esign-row" key={employer.id}><span><strong>{employer.legalName}</strong><small>{businessNumber(employer.businessNumber)} · 대표 {employer.representativeName} · 서명 {employer.signerName}</small></span><Button variant="secondary" disabled={disabled} onClick={() => setEditingEmployer(employer)}>수정</Button></div>)}</div>
      <EmployerForm key={editingEmployer?.id || 'new'} employer={editingEmployer} accounts={validData?.accounts ?? props.accounts} busy={disabled} onCancel={() => setEditingEmployer(null)} onSubmit={input => run('/employers', input, '고용주 정보를 저장했습니다.')} />
    </>}
    {(view === 'create' || view === 'edit') && manage && validData && <ContractForm contract={view === 'edit' ? detail : null} employers={validData.employers.filter(row => row.active)} employees={props.workspace.employees.filter(row => row.status !== 'retired')} busy={disabled} onSubmit={input => run('/contracts', input, '계약 초안을 저장했습니다. 전체 내용을 확인한 뒤 서명을 요청해 주세요.')} />}
    {view === 'detail' && detail && <ContractDetail key={`${detail.id}:${detail.version}`} contract={detail} actorId={props.actorId} manage={manage} busy={disabled} onEdit={() => setView('edit')} onAction={(action, input, message) => run(`/contracts/${encodeURIComponent(detail.id)}/${action}`, { expectedVersion: detail.version, ...input }, message)} onDownload={download} />}
  </>;
}

type Action = (action: string, input: Record<string, unknown>, message: string) => Promise<boolean>;
function ContractDetail({ contract: c, actorId, manage, busy, onEdit, onAction, onDownload }: { contract: NativeContract; actorId: string; manage: boolean; busy: boolean; onEdit: () => void; onAction: Action; onDownload: (kind: 'pdf' | 'evidence') => Promise<void> }) {
  const role = c.employeeActorId === actorId ? 'employee' : c.employer.signerActorId === actorId ? 'employer' : null;
  const expired = c.status === 'pending' && Date.parse(c.expiresAt) <= Date.now();
  const signed = c.signatures.some(row => row.actorId === actorId);
  const [showStop, setShowStop] = useState(false);
  const [requestConfirmed, setRequestConfirmed] = useState(false);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  return <article className="esign-detail"><div className="esign-topline"><div><h2>{c.title}</h2><p>{c.employeeName} · {c.employer.legalName}</p></div><span className={`esign-badge ${c.status}`}>{expired ? '서명 기한 경과' : statusName[c.status]}</span></div>
    <dl className="esign-summary"><div><dt>계약 고용주</dt><dd>{c.employer.legalName}<br />{businessNumber(c.employer.businessNumber)}</dd></div><div><dt>근로자</dt><dd>{c.employeeName}</dd></div><div><dt>근로 시작일</dt><dd>{hrDate(c.terms.effectiveDate)}</dd></div><div><dt>사용자 서명 담당자</dt><dd>{c.employer.signerName}</dd></div><div><dt>근로 종료일</dt><dd>{c.terms.endDate ? hrDate(c.terms.endDate) : '기간의 정함 없음'}</dd></div><div><dt>서명 기한</dt><dd>{c.expiresAt ? hrDate(c.expiresAt) : '요청 시 지정'}</dd></div></dl>
    <section className="esign-document" aria-label="계약서 전체 내용"><header className="esign-document-heading"><h3>{c.status === 'draft' ? '계약서 미리보기' : '계약서 원문'}</h3><span className="esign-muted">전체 내용</span></header><pre>{c.documentText}</pre></section>
    {c.documentHash && <details><summary className="esign-muted">서명 대상 문서 확인값</summary><p className="esign-hash">SHA-256 · {c.documentHash}</p></details>}
    <div className="esign-parties">{(['employer', 'employee'] as const).map(party => { const signature = c.signatures.find(row => row.role === party); return <section className="esign-party" key={party}><div><strong>{party === 'employer' ? '사용자' : '근로자'} · {party === 'employer' ? c.employer.signerName : c.employeeName}</strong><p>{signature ? `${hrDate(signature.at)} · 본인 계정 재확인 후 서명` : '서명 대기'}</p></div><span className={`esign-badge ${signature ? 'completed' : ''}`}>{signature ? '서명 완료' : '대기'}</span></section>; })}</div>
    {c.status === 'draft' && manage && <form className="hr-form esign-delivery" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); if (!requestConfirmed) return; void onAction('request', { expiresAt: new Date(`${field(f, 'expiresDate')}T23:59:59+09:00`).toISOString() }, '앱 내 서명 요청을 등록했습니다. 양측 계정의 계약 메뉴에서 서명할 수 있습니다.'); }}><h3>계약 검토 및 서명 요청</h3><Button type="button" variant="secondary" disabled={busy} onClick={onEdit}>초안 수정</Button><p className="esign-muted">요청 후 계약 원문이 확정됩니다. 수정이 필요하면 요청을 취소하고 새 계약을 작성해 주세요.</p><label>서명 마감일<input name="expiresDate" type="date" min={hrToday()} max={new Date(Date.now() + 89 * 86400000).toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)} required disabled={busy} /></label><label className="esign-consent"><input type="checkbox" checked={requestConfirmed} disabled={busy} onChange={event => setRequestConfirmed(event.target.checked)} /><span>계약당사자, 근로조건과 계약서 전체 내용을 검토하고 서명 요청을 승인합니다.</span></label><Button type="submit" disabled={busy || !requestConfirmed}>앱 내 서명 요청</Button></form>}
    {c.status === 'pending' && !expired && role && !signed && <SignatureForm key={c.documentHash} contract={c} role={role} busy={busy} onAction={onAction} />}
    {c.status === 'pending' && signed && <p className="esign-muted">본인 서명을 완료했습니다. 상대방 서명이 완료되면 계약서 사본을 내려받을 수 있습니다.</p>}
    {c.status === 'pending' && (manage || role) && <div className="esign-actions"><Button variant="ghost" disabled={busy} onClick={() => setShowStop(!showStop)}>{manage ? '서명 요청 취소' : '수정 요청·서명 거절'}</Button></div>}
    {showStop && <form className="hr-form esign-delivery" onSubmit={event => { event.preventDefault(); void onAction(manage ? 'cancel' : 'decline', { reason: field(new FormData(event.currentTarget), 'reason') }, manage ? '서명 요청을 취소했습니다.' : '거절 사유를 기록했습니다. 담당자가 확인할 수 있습니다.'); }}><label>{manage ? '취소 사유' : '수정 요청·거절 사유'}<textarea name="reason" required maxLength={2000} rows={3} disabled={busy} /></label><Button type="submit" variant="secondary" disabled={busy}>사유 기록 후 {manage ? '요청 취소' : '서명 거절'}</Button></form>}
    {c.closeReason && <p className="esign-muted">종료 사유: {c.closeReason}</p>}
    {c.status === 'completed' && <><div className="esign-actions"><Button disabled={busy} onClick={() => void onDownload('pdf')}>완료 계약서 PDF</Button><Button variant="secondary" disabled={busy} onClick={() => void onDownload('evidence')}>체결 시점 진행기록</Button></div>
      <section className="esign-delivery"><h3>계약서 사본 교부</h3><p>{c.deliveries.some(row => row.method === 'manual_handover') ? '담당자가 사본 교부 근거를 등록했습니다.' : '사본 교부 확인이 필요합니다.'}</p><p className="esign-muted">직원은 완료 계약서를 내려받을 수 있습니다. 실제 사본 교부 근거는 담당자가 별도로 기록합니다.</p>{c.deliveries.map(row => <p className="esign-muted" key={row.id}>{hrDate(row.at)} · {row.method === 'manual_handover' ? '사본 교부 기록' : '직원 다운로드 요청'}{row.evidenceNote && ` · ${row.evidenceNote}`}</p>)}
      {manage && <form className="hr-form" onSubmit={event => { event.preventDefault(); void onAction('delivery', { method: 'manual_handover', evidenceNote: field(new FormData(event.currentTarget), 'evidenceNote') }, '사본 교부 근거를 기록했습니다.'); }}><label>실제 교부 일시·방법·수신처·확인 근거<textarea name="evidenceNote" required maxLength={2000} rows={3} disabled={busy} placeholder="예: 9월 16일 직원이 지정한 이메일로 완료 PDF 전달, 수신 확인 내용 및 증빙 보관 위치" /></label><Button type="submit" variant="secondary" disabled={busy}>교부 근거 기록</Button></form>}</section>
      {manage && <section className="esign-delivery"><h3>인사정보 반영</h3>{c.appliedAt ? <p>{hrDate(c.appliedAt)}에 인사정보를 반영했습니다.</p> : <><p className="esign-muted">{c.terms.employmentType === 'regular' ? '정규직' : c.terms.employmentType === 'part_time' ? '단시간' : '기간제'} · {c.terms.jobTitle} · {c.terms.payType === 'monthly' ? '월급' : '시급'} {c.terms.basePay.toLocaleString('ko-KR')}원<br />적용일 {hrDate(c.terms.effectiveDate)}부터 현재 인사정보에 반영할 수 있습니다.</p><label className="esign-consent"><input type="checkbox" checked={applyConfirmed} disabled={busy || c.terms.effectiveDate > hrToday()} onChange={event => setApplyConfirmed(event.target.checked)} /><span>계약 조건으로 현재 직원 정보를 변경하는 것을 확인했습니다.</span></label><div className="esign-actions"><Button disabled={busy || !applyConfirmed || c.terms.effectiveDate > hrToday()} onClick={() => void onAction('apply', {}, '계약 조건을 인사정보에 반영했습니다.')}>인사정보에 반영</Button></div></>}</section>}
    </>}
    <details className="esign-timeline"><summary>계약 진행기록 {c.audit.length}건</summary><ol>{c.audit.map(row => <li key={row.id}>{eventName[row.action] || row.action}<small>{new Date(row.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</small></li>)}</ol></details>
  </article>;
}

function SignatureForm({ contract, role, busy, onAction }: { contract: NativeContract; role: 'employee' | 'employer'; busy: boolean; onAction: Action }) {
  const [strokes, setStrokes] = useState<EsignStroke[]>([]);
  const [consent, setConsent] = useState(false);
  const [password, setPassword] = useState('');
  const [typedName, setTypedName] = useState('');
  const expectedName = role === 'employee' ? contract.employeeName : contract.employer.signerName;
  const validStroke = strokes.reduce((total, stroke) => total + stroke.length, 0) >= 3;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!consent || !validStroke || !password || typedName.trim() !== expectedName) return;
    const secret = password; setPassword('');
    await onAction('sign', { role, typedName: typedName.trim(), documentHash: contract.documentHash, consent: true, consentVersion: contract.consentVersion, strokes, password: secret }, '본인 서명을 저장했습니다. 체결 상태는 서버에서 확인한 결과입니다.');
  }
  return <form className="hr-form esign-signform" onSubmit={event => void submit(event)}><h3>{role === 'employee' ? '근로자' : '사용자'} 서명</h3><label>본인 성명 · {expectedName}<input name="typedName" value={typedName} onChange={event => setTypedName(event.target.value)} autoComplete="name" required maxLength={100} disabled={busy} /></label><EsignSignaturePad value={strokes} onChange={setStrokes} disabled={busy} /><label className="esign-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /><span>{contract.intentText}</span></label><label>본인 ODA 계정 비밀번호<input name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} /></label><Button type="submit" disabled={busy || !consent || !validStroke || !password || typedName.trim() !== expectedName}>{busy ? '서명 확인 중…' : '본인 확인 후 서명'}</Button></form>;
}

function EmployerForm({ employer, accounts, busy, onCancel, onSubmit }: { employer: NativeEmployer | null; accounts: NonNullable<HrResponse['accounts']>; busy: boolean; onCancel: () => void; onSubmit: (input: Record<string, unknown>) => Promise<boolean> }) {
  return <form className="hr-form esign-form" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); void onSubmit({ ...(employer ? { id: employer.id, expectedVersion: employer.version } : { expectedVersion: 0 }), legalName: field(f, 'legalName'), businessNumber: field(f, 'businessNumber'), representativeName: field(f, 'representativeName'), address: field(f, 'address'), signerActorId: field(f, 'signerActorId'), active: true }); }}><fieldset><legend>{employer ? '고용주 수정' : '새 고용주 등록'}</legend><div className="hr-form-grid"><label>상호·법인명<input name="legalName" defaultValue={employer?.legalName} required maxLength={300} disabled={busy} /></label><label>사업자등록번호<input name="businessNumber" defaultValue={employer?.businessNumber} placeholder="000-00-00000" inputMode="numeric" required maxLength={14} disabled={busy} /></label><label>대표자명<input name="representativeName" defaultValue={employer?.representativeName} required maxLength={100} disabled={busy} /></label><label>계약 서명 담당 계정<select name="signerActorId" defaultValue={employer?.signerActorId ?? ''} required disabled={busy}><option value="" disabled>계정 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label></div><label>사업장 주소<input name="address" defaultValue={employer?.address} required maxLength={500} disabled={busy} /></label><p className="esign-muted">고용주 변경은 이후 작성하는 계약에 적용됩니다. 요청된 계약은 당시 정보를 보존합니다.</p><div className="esign-actions">{employer && <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>새 고용주 등록으로</Button>}<Button type="submit" disabled={busy}>{employer ? '변경 저장' : '고용주 등록'}</Button></div></fieldset></form>;
}

function ContractForm({ employers, employees, busy, onSubmit, contract }: { contract?: NativeContract | null; employers: NativeEmployer[]; employees: Props['workspace']['employees']; busy: boolean; onSubmit: (input: Record<string, unknown>) => Promise<boolean> }) {
  const [template, setTemplate] = useState<'monthly' | 'hourly' | 'fixed'>(contract?.terms.employmentType === 'part_time' ? 'hourly' : contract?.terms.employmentType === 'contract' ? 'fixed' : 'monthly');
  const [employeeId, setEmployeeId] = useState(contract?.employeeId || '');
  const employee = employees.find(row => row.id === employeeId);
  const selectedEmployees = employees.filter(row => row.actorId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    const terms: NativeContractTerms = { employmentType: template === 'hourly' ? 'part_time' : template === 'fixed' ? 'contract' : 'regular', payType: field(f, 'payType') as 'monthly' | 'hourly', basePay: Number(field(f, 'basePay')), effectiveDate: field(f, 'effectiveDate'), endDate: field(f, 'endDate'), jobTitle: field(f, 'jobTitle'), workplace: field(f, 'workplace'), workDays: field(f, 'workDays'), dailyWorkHours: field(f, 'dailyWorkHours'), workStart: field(f, 'workStart'), workEnd: field(f, 'workEnd'), breakMinutes: Number(field(f, 'breakMinutes')), payday: field(f, 'payday'), payCalculation: field(f, 'payCalculation'), payMethod: field(f, 'payMethod'), holidays: field(f, 'holidays'), annualLeave: field(f, 'annualLeave'), additionalTerms: field(f, 'additionalTerms') };
    void onSubmit({ ...(contract ? { id: contract.id, expectedVersion: contract.version } : { expectedVersion: 0 }), employerId: field(f, 'employerId'), employeeId, title: field(f, 'title'), templateKey: `oda-employment-${template}-v1`, terms });
  }
  return <form className="hr-form esign-form" onSubmit={submit}><h2>근로계약 작성</h2><p className="esign-muted">입력한 조건으로 계약서 초안을 만듭니다. 초안을 확인한 뒤 서명을 요청합니다.</p><fieldset><legend>1. 계약당사자와 양식</legend><div className="hr-form-grid"><label>고용주<select name="employerId" required defaultValue={contract?.employer.id || ''} disabled={busy}><option value="" disabled>사업자 선택</option>{employers.map(row => <option key={row.id} value={row.id}>{row.legalName} · {businessNumber(row.businessNumber)}</option>)}</select></label><label>근로자<select name="employeeId" value={employeeId} onChange={event => setEmployeeId(event.target.value)} required disabled={busy}><option value="" disabled>직원 선택</option>{selectedEmployees.map(row => <option key={row.id} value={row.id}>{row.name} · {row.employeeNumber}</option>)}</select></label><label>계약 양식<select value={template} onChange={event => setTemplate(event.target.value as typeof template)} disabled={busy}><option value="monthly">월급 · 전일제</option><option value="hourly">시급 · 단시간</option><option value="fixed">기간제</option></select></label><label>계약 제목<input name="title" defaultValue={contract?.title || '근로계약서'} maxLength={200} required disabled={busy} /></label></div>{employees.length !== selectedEmployees.length && <p className="esign-muted">ODA 계정이 연결된 직원만 선택할 수 있습니다. 직원·조직에서 먼저 계정을 연결해 주세요.</p>}</fieldset>
    <fieldset><legend>2. 계약 기간 및 업무</legend><div className="hr-form-grid"><label>근로 시작일<input name="effectiveDate" type="date" required defaultValue={contract?.terms.effectiveDate || hrToday()} disabled={busy} /></label><label>근로 종료일 {template !== 'fixed' && '· 선택'}<input name="endDate" defaultValue={contract?.terms.endDate} type="date" required={template === 'fixed'} disabled={busy} /></label><label>담당 업무<input name="jobTitle" key={`job:${employeeId}`} defaultValue={employeeId === contract?.employeeId ? contract.terms.jobTitle : employee?.jobTitle} required maxLength={300} disabled={busy} /></label><label>근무 장소<input name="workplace" defaultValue={contract?.terms.workplace} required maxLength={500} disabled={busy} placeholder="실제 근무할 매장명과 주소" /></label></div></fieldset>
    <fieldset><legend>3. 근로일 및 시간</legend><label>근로일<input name="workDays" defaultValue={contract?.terms.workDays} required maxLength={500} disabled={busy} placeholder="예: 월·화·수·목·금" /></label><label>근로일별 근로시간<textarea name="dailyWorkHours" defaultValue={contract?.terms.dailyWorkHours} required maxLength={1000} rows={3} disabled={busy} placeholder="예: 월·수·금 10:00~15:00, 화·목 10:00~14:00. 요일별 휴게시간도 적어 주세요." /></label><div className="hr-form-grid"><label>기본 시업 시각<input name="workStart" type="time" required defaultValue={contract?.terms.workStart || '09:00'} disabled={busy} /></label><label>기본 종업 시각<input name="workEnd" type="time" required defaultValue={contract?.terms.workEnd || '18:00'} disabled={busy} /></label><label>기본 휴게시간 · 분<input name="breakMinutes" type="number" min="0" max="720" step="1" defaultValue={contract?.terms.breakMinutes ?? 60} required disabled={busy} /></label></div></fieldset>
    <fieldset><legend>4. 임금</legend><div className="hr-form-grid"><label>급여 기준<select key={template} name="payType" defaultValue={contract?.terms.payType || (template === 'hourly' ? 'hourly' : 'monthly')} disabled={busy}><option value="monthly">월급</option><option value="hourly">시급</option></select></label><label>기본급 · 원<input name="basePay" key={`pay:${employeeId}`} defaultValue={employeeId === contract?.employeeId ? contract.terms.basePay : employee?.basePay || ''} type="number" min="1" max="1000000000" step="1" required disabled={busy} /></label><label>임금 지급일<input name="payday" defaultValue={contract?.terms.payday} maxLength={500} required placeholder="예: 매월 10일, 전월 근로분 지급" disabled={busy} /></label><label>임금 지급 방법<input name="payMethod" defaultValue={contract?.terms.payMethod} maxLength={500} required placeholder="예: 근로자 명의 계좌로 이체" disabled={busy} /></label></div><label>임금 구성항목 및 계산방법<textarea name="payCalculation" defaultValue={contract?.terms.payCalculation} rows={4} maxLength={2000} required disabled={busy} placeholder="기본급, 수당 항목·금액, 근로시간에 따른 계산방법을 구체적으로 입력해 주세요." /></label></fieldset>
    <fieldset><legend>5. 휴일·휴가·추가 약정</legend><label>휴일<textarea name="holidays" defaultValue={contract?.terms.holidays} required maxLength={2000} rows={3} disabled={busy} placeholder="주휴일과 적용되는 유급휴일, 휴일 운영 기준" /></label><label>연차유급휴가<textarea name="annualLeave" defaultValue={contract?.terms.annualLeave} required maxLength={2000} rows={3} disabled={busy} placeholder="해당 사업장과 근로자에게 적용되는 연차유급휴가 기준" /></label><label>추가 약정 · 선택<textarea name="additionalTerms" defaultValue={contract?.terms.additionalTerms} maxLength={8000} rows={4} disabled={busy} /></label></fieldset><div className="esign-actions"><Button type="submit" disabled={busy || !employeeId}>{busy ? '저장 중…' : '초안 저장 후 미리보기'}</Button></div>
  </form>;
}

export function EsignPendingCard({ storeId, actorId, onOpen, disabled = false }: { storeId: string; actorId: string; onOpen: () => void; disabled?: boolean }) {
  const [overview, setOverview] = useState<EsignOverview | null>(null);
  useEffect(() => { const controller = new AbortController(); setOverview(null); if (!storeId) return; void getOdaEsign(storeId, controller.signal).then(result => { if (!controller.signal.aborted) setOverview(result); }).catch(() => { if (!controller.signal.aborted) setOverview(null); }); return () => controller.abort(); }, [storeId, actorId]);
  const pending = overview?.storeId === storeId ? overview.contracts.filter(row => row.status === 'pending' && row.employeeActorId === actorId && !row.signatures?.some(signature => signature.actorId === actorId) && Date.parse(row.expiresAt) > Date.now()).length : 0;
  if (!pending) return null;
  return <button type="button" className="esign-employee-card" onClick={onOpen} disabled={disabled}><FileCheck2 size={24} /><span><strong>서명할 근로계약 {pending}건</strong><small>계약 내용을 확인하고 서명해 주세요.</small></span><ChevronRight size={19} /></button>;
}
