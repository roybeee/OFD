import { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateNativeSignatureStrokes, type NativeContract, type NativeContractTerms, type NativeEmployer, type NativeContractTemplate } from '../../../../packages/domain/src/oda-esign';
import type { HrResponse } from '../api/oda-hr-client';
import { ApiError, newIdempotencyKey } from '../api/client';
import { downloadOdaEsign, getOdaEsign, getOdaEsignContract, mutateOdaEsign, type EsignOverview } from '../api/oda-esign-client';
import { Button } from '../components/ui';
import { ChevronRight, FileCheck2, RefreshCcw } from '../components/icons';
import { EsignSignaturePad, type EsignStroke } from './EsignSignaturePad';
import { EsignComparison } from './EsignComparison';
import { EsignBatchForm } from './EsignBatchForm';
import { HrTalent } from './HrTalent';
import { HrEmpty, hrDate, hrError, hrToday, type HrPanelProps } from './shared';
import { esignTiming, esignTaskLabels, matchesEsignTask, type EsignTask } from './esign-followup';
import { filterEsignRegister, saveEsignRegister, esignStatusLabels, type EsignStatusFilter } from './esign-register';
import './HrEsign.css';

type Props = HrPanelProps & { accounts: NonNullable<HrResponse['accounts']> };
type View = 'list' | 'create' | 'edit' | 'employers' | 'detail' | 'templates' | 'batch' | 'batch-result';
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
  const [statusFilter, setStatusFilter] = useState<EsignStatusFilter>('all');
  const [filter, setFilter] = useState('all');
  const [task, setTask] = useState<EsignTask>('all');
  const [now, setNow] = useState(Date.now);
  const [savedTemplate, setSavedTemplate] = useState<NativeContractTemplate | null>(null);
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [copySource, setCopySource] = useState<NativeContract | null>(null);
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
  useEffect(() => {
    const refresh = () => { setNow(Date.now()); if (document.visibilityState !== 'hidden' && !locked.current && view === 'list') setRetry(value => value + 1); };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [view]);
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
  function navigate(next: View) { if (locked.current) return; detailRequest.current++; setView(next); setLoading(false); setDetail(null); setCopySource(null); setSavedTemplate(null); setError(''); setSuccess(''); }
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
      setData(result); if (result.contract) { setCopySource(null); setSavedTemplate(null); setDetail(result.contract); setView('detail'); }
      if (result.template) { setView('templates'); setDetail(null); setCopySource(null); setSavedTemplate(null); }
      if (result.createdContractIds) { setCreatedIds(result.createdContractIds); setView('batch-result'); setSavedTemplate(null); setDetail(null); setCopySource(null); }
      if (result.employer) { setEditingEmployer(null); setView('employers'); }
      setSuccess(message);
      if (suffix.endsWith('/apply')) await props.onReload?.();
      return true;
    } catch (caught) {
      if (alive.current) {
        setError(hrError(caught));
        if (caught instanceof ApiError && caught.status === 409) {
          try {
            if (suffix === '/contracts/batch') await props.onReload?.();
            const latest = await getOdaEsign(storeId);
            if (!alive.current) return false;
            setData(latest);
            if (savedTemplate) {
              const nextTemplate = latest.templates?.find(row => row.id === savedTemplate.id);
              const nextEmployer = latest.employers.find(row => row.id === nextTemplate?.employerId);
              // A form must never silently submit changed template conditions with old consent.
              if (view === 'batch' && nextTemplate?.active && nextEmployer?.active) setSavedTemplate(nextTemplate);
              else { setSavedTemplate(null); setView('templates'); setError(`${hrError(caught)} 최신 양식을 확인하고 계약 작성을 다시 시작해 주세요.`); }
            }
            if (editingEmployer && suffix === '/employers') {
              setEditingEmployer(latest.employers.find(row => row.id === editingEmployer.id) ?? null);
              setError(`${hrError(caught)} 최신 고용주 정보를 불러왔습니다. 내용을 확인하고 다시 수정해 주세요.`);
            }
            if (detail) {
              const next = await getOdaEsignContract(storeId, detail.id);
              if (alive.current) {
                setDetail(next.contract);
                // Uncontrolled edit fields still contain the previous snapshot. Unmount them
                // before adopting a newer version so retry cannot overwrite a concurrent edit.
                if (view === 'edit') {
                  setView('detail');
                  setError(`${hrError(caught)} 수정 내용은 저장되지 않았습니다. 최신 계약을 확인한 뒤 ‘초안 수정’에서 다시 입력해 주세요.`);
                }
              }
            }
          }
          catch {
            if (alive.current) {
              setDetail(null);
              if (view === 'edit') setView('detail');
              if (savedTemplate) { setSavedTemplate(null); setView('templates'); }
              setError(`${hrError(caught)} 계약을 다시 열어 최신 내용을 확인해 주세요.`);
            }
          }
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
  const registerFilter = { employerId: filter, search, status: statusFilter, task };
  const scoped = filterEsignRegister(contracts, { ...registerFilter, task: 'all' }, props.actorId, now);
  const list = filterEsignRegister(contracts, registerFilter, props.actorId, now);
  async function exportRegister() {
    if (locked.current || disabled || !manage) return;
    locked.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      const latest = await getOdaEsign(storeId);
      if (!alive.current) return;
      if (latest.storeId !== storeId || latest.currentActorId !== props.actorId) throw new Error('계정 정보가 변경되었습니다. 다시 로그인해 주세요.');
      setData(latest);
      if (!latest.permissions.manage) throw new Error('계약 관리대장을 내려받을 권한이 없습니다.');
      const exportedAt = Date.now(); setNow(exportedAt);
      const rows = filterEsignRegister(latest.contracts, registerFilter, props.actorId, exportedAt);
      if (!rows.length) throw new Error('최신 조회 결과에 내려받을 계약이 없습니다.');
      saveEsignRegister(rows, exportedAt);
      setSuccess(`최신 조회 조건에 맞는 계약 ${rows.length}건의 CSV 다운로드를 요청했습니다. 기기의 저장 파일을 확인해 주세요.`);
    } catch (caught) { if (alive.current) setError(hrError(caught)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const tasks: EsignTask[] = manage ? ['all', 'mine', 'expired', 'ending', 'ended', 'delivery', 'apply'] : ['all', 'mine', 'expired', 'ending', 'ended'];
  return <>
    {view !== 'list' && <Button className="esign-back" variant="ghost" disabled={busy} onClick={() => navigate('list')}>← 계약 목록</Button>}
    {error && <div className="hr-error" role="alert"><p>{error}</p>{!busy && <Button variant="secondary" onClick={() => { if (view === 'detail' && detail) void open(detail.id); else { setRetry(value => value + 1); if (view === 'detail') navigate('list'); } }}>다시 불러오기</Button>}</div>}
    {success && <p className="hr-badge" role="status">{success}</p>}
    {loading && <p role="status" className="hr-loading">전자계약 정보를 불러오고 있습니다.</p>}
    {view === 'list' && <>
      <div className="esign-topline"><div><h2>{manage ? '전자 근로계약' : '내 전자계약'}</h2><p>{manage ? '사업자별 계약 작성부터 양측 서명, 사본 교부와 인사 반영까지 관리합니다.' : '계약 내용을 확인하고 서명하세요. 완료된 계약서는 언제든 내려받을 수 있습니다.'}</p></div><div className="esign-actions"><Button variant="secondary" disabled={disabled} onClick={() => setRetry(value => value + 1)} aria-label="전자계약 새로고침"><RefreshCcw size={16} /></Button>{manage && <><Button variant="secondary" disabled={disabled} onClick={() => navigate('employers')}>고용주 관리</Button><Button variant="secondary" disabled={disabled} onClick={() => navigate('templates')}>저장한 양식</Button><Button disabled={disabled || !validData?.employers.some(row => row.active)} onClick={() => navigate('create')}>계약 만들기</Button></>}</div></div>
      {validData && <><div className="esign-stats"><div className="esign-stat"><span>서명 진행</span><strong>{contracts.filter(row => row.status === 'pending' && !esignTiming(row, now).expired).length}</strong></div><div className="esign-stat"><span>체결 완료</span><strong>{contracts.filter(row => row.status === 'completed').length}</strong></div><div className="esign-stat"><span>교부 확인 대기</span><strong>{contracts.filter(row => row.status === 'completed' && !row.deliveries?.some(item => item.method === 'manual_handover')).length}</strong></div><div className="esign-stat"><span>인사 반영 대기</span><strong>{contracts.filter(row => row.status === 'completed' && !row.appliedAt).length}</strong></div></div>
      {manage && !validData.employers.some(row => row.active) && <HrEmpty title="먼저 계약당사자인 고용주를 등록해 주세요.">사업자등록번호와 실제 회사 서명 담당자를 지정하면 계약을 작성할 수 있습니다.</HrEmpty>}
      <div className="esign-toolbar"><label><select disabled={disabled} aria-label="고용주별 계약" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">전체 고용주</option>{validData.employers.map(row => <option key={row.id} value={row.id}>{row.legalName} · {businessNumber(row.businessNumber)}</option>)}</select></label><label><select aria-label="계약 진행 상태" disabled={disabled} value={statusFilter} onChange={event => setStatusFilter(event.target.value as EsignStatusFilter)}><option value="all">모든 진행 상태</option>{Object.entries(esignStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><input disabled={disabled} type="search" aria-label="계약 검색" placeholder="직원·계약명·사업자번호 검색" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      <div className="esign-actions"><span>조회 결과 {list.length}건</span>{manage && <Button variant="secondary" disabled={disabled || !list.length} onClick={() => void exportRegister()}>계약 관리대장 CSV</Button>}</div>
      <nav className="esign-task-filters" aria-label="계약 처리 항목">{tasks.map(key => <button type="button" key={key} disabled={disabled} aria-pressed={task === key} onClick={() => setTask(key)}>{esignTaskLabels[key]} <strong>{scoped.filter(row => matchesEsignTask(row, key, props.actorId, now)).length}</strong></button>)}</nav>
      {['ending', 'ended'].includes(task) && <p className="esign-muted">계약서에 기록된 종료일 기준입니다. 새 계약은 별도로 검토하고 서명해야 하며, 기존 계약이 자동 종료·연장되지는 않습니다.</p>}
      {!list.length ? <HrEmpty title={task !== 'all' || search || filter !== 'all' || statusFilter !== 'all' ? '조건에 맞는 계약이 없습니다.' : '등록된 전자계약이 없습니다.'}>{manage ? '고용주와 직원을 선택해 첫 계약을 준비하세요.' : '담당자가 서명을 요청하면 이곳에서 확인할 수 있습니다.'}</HrEmpty> : <div className="esign-list">{list.map(contract => <button className="esign-row" type="button" key={contract.id} disabled={disabled} onClick={() => void open(contract.id)}><span><strong>{contract.title}</strong><small>{contract.employeeName} · {contract.employer.legalName}<br />사업자 {businessNumber(contract.employer.businessNumber)} · 적용 {hrDate(contract.terms.effectiveDate)}</small></span><span className="esign-row-side"><span className={`esign-badge ${contract.status}`}>{esignTiming(contract, now).expired ? '서명 기한 경과' : statusName[contract.status]}</span>{contract.status === 'completed' && contract.terms.endDate && <small>기록된 종료일 {hrDate(contract.terms.endDate)}</small>}{contract.status === 'pending' && <small>서명 {contract.signatures?.length ?? 0}/2 · {hrDate(contract.expiresAt)}</small>}<ChevronRight size={16} /></span></button>)}</div>}</>}
    </>}
    {view === 'templates' && manage && <><div className="esign-topline"><div><h2>사업자별 저장 양식</h2><p>계약 상세에서 검토한 근로조건을 양식으로 저장할 수 있습니다. 양식마다 고용주가 지정되며 근로자·기간·서명은 새 계약에서 정합니다.</p></div></div>
      {!(validData?.templates ?? []).length && <HrEmpty title="저장한 양식이 없습니다.">작성한 계약을 열어 ‘근로조건을 양식으로 저장’을 선택해 주세요.</HrEmpty>}
      <div className="esign-list">{(validData?.templates ?? []).map(template => { const employer = validData?.employers.find(row => row.id === template.employerId); return <section className="esign-delivery" key={template.id}><div className="esign-topline"><div><h3>{template.name}</h3><p>{employer?.legalName || '등록 고용주 확인 필요'} · {employer ? businessNumber(employer.businessNumber) : ''}</p></div><span className="esign-badge">{template.active ? '사용 중' : '보관됨'}</span></div>
        <p className="esign-muted">{template.terms.jobTitle} · {template.terms.payType === 'monthly' ? '월급' : '시급'} {template.terms.basePay.toLocaleString('ko-KR')}원 · {template.terms.workDays}</p>
        <details><summary>저장한 근로조건 확인</summary><dl className="esign-summary">{Object.entries({ '근무 장소': template.terms.workplace, '근로일별 시간': template.terms.dailyWorkHours, '기본 시업·종업': `${template.terms.workStart}~${template.terms.workEnd}`, '기본 휴게': `${template.terms.breakMinutes}분`, '지급일': template.terms.payday, '임금 구성·계산': template.terms.payCalculation, '지급 방법': template.terms.payMethod, '휴일': template.terms.holidays, '연차': template.terms.annualLeave, '추가 약정': template.terms.additionalTerms || '없음' }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="esign-template-value">{value}</dd></div>)}</dl></details>
        <div className="esign-actions"><Button disabled={disabled || !template.active || !employer?.active} onClick={() => { setSavedTemplate(template); setCopySource(null); setDetail(null); setView('create'); setSuccess('저장한 양식을 불러왔습니다. 직원을 선택하고 새 계약 기간과 조건을 검토해 주세요.'); }}>이 양식으로 계약 작성</Button><Button variant="secondary" disabled={disabled || !template.active || !employer?.active} onClick={() => { setSavedTemplate(template); setCopySource(null); setDetail(null); setView('batch'); setError(''); setSuccess(''); }}>여러 직원 초안 만들기</Button><Button variant="secondary" disabled={disabled || (!template.active && !employer?.active)} onClick={() => void run(`/templates/${encodeURIComponent(template.id)}`, { expectedVersion: template.version, active: !template.active }, template.active ? '양식을 보관했습니다. 기존 계약은 그대로 유지됩니다.' : '양식을 다시 사용할 수 있습니다.')}>{template.active ? '양식 보관' : '양식 복원'}</Button></div>
      </section>; })}</div><p className="esign-muted">양식 조건을 바꾸려면 새 계약 초안을 수정한 뒤 다른 이름으로 저장해 주세요. 양식 보관은 이미 작성·서명한 계약에 영향을 주지 않습니다.</p></>}
    {view === 'batch' && manage && savedTemplate && validData && <EsignBatchForm key={savedTemplate.id} template={savedTemplate} employer={validData.employers.find(row => row.id === savedTemplate.employerId)} workspace={props.workspace} accounts={validData.accounts ?? props.accounts} busy={disabled} onSubmit={input => run('/contracts/batch', input, '계약 초안을 저장했습니다. 직원별 내용을 확인하고 각각 서명을 요청해 주세요.')} />}
    {view === 'batch-result' && manage && <section className="esign-batch-result"><h2>생성한 계약 초안 {createdIds.length}건</h2><p>직원별 초안을 열어 조건을 검토·수정하고 서명을 요청해 주세요.</p><div className="esign-list">{createdIds.map(id => { const contract = contracts.find(row => row.id === id); return contract ? <button type="button" className="esign-row" key={id} disabled={disabled} onClick={() => void open(id)}><span><strong>{contract.employeeName} · {contract.title}</strong><small>{contract.employer.legalName} · 적용 {hrDate(contract.terms.effectiveDate)}</small></span><span>{statusName[contract.status]} <ChevronRight size={16} /></span></button> : null; })}</div></section>}
    {view === 'employers'  && manage && <><div className="esign-topline"><div><h2>고용주 관리</h2><p>현재 매장에 계약을 체결하는 실제 사업자를 등록합니다. 서명 담당자는 지정한 본인 계정으로 서명합니다.</p></div></div><div className="esign-list">{validData?.employers.map(employer => <div className="esign-row" key={employer.id}><span><strong>{employer.legalName}</strong><small>{businessNumber(employer.businessNumber)} · 대표 {employer.representativeName} · 서명 {employer.signerName}</small></span><Button variant="secondary" disabled={disabled} onClick={() => setEditingEmployer(employer)}>수정</Button></div>)}</div>
      <EmployerForm key={editingEmployer ? `${editingEmployer.id}:${editingEmployer.version}` : 'new'} employer={editingEmployer} accounts={validData?.accounts ?? props.accounts} busy={disabled} onCancel={() => setEditingEmployer(null)} onSubmit={input => run('/employers', input, '고용주 정보를 저장했습니다.')} />
    </>}
    {(view === 'create' || view === 'edit') && manage && validData && <ContractForm savedTemplate={savedTemplate} sourceContract={copySource} contract={view === 'edit' ? detail : null} employers={validData.employers.filter(row => row.active)} employees={props.workspace.employees.filter(row => row.status !== 'retired')} busy={disabled} onSubmit={input => run('/contracts', input, '계약 초안을 저장했습니다. 전체 내용을 확인한 뒤 서명을 요청해 주세요.')} />}
    {view === 'detail' && detail && <ContractDetail key={`${detail.id}:${detail.version}`} contract={detail} contracts={contracts} actorId={props.actorId} manage={manage} busy={disabled} onSaveTemplate={name => run('/templates', { expectedVersion: 0, sourceContractId: detail.id, sourceContractVersion: detail.version, name }, '근로조건을 사업자별 양식으로 저장했습니다.')} onEdit={() => setView('edit')} onCopy={() => { setCopySource(detail); setView('create'); setDetail(null); setSuccess('기존 조건을 불러왔습니다. 새 계약 기간과 조건을 검토한 뒤 초안을 저장해 주세요.'); }} onAction={(action, input, message) => run(`/contracts/${encodeURIComponent(detail.id)}/${action}`, { expectedVersion: detail.version, ...input }, message)} onDownload={download} />}
  </>;
}

type Action = (action: string, input: Record<string, unknown>, message: string) => Promise<boolean>;
function ContractDetail({ contract: c, contracts, actorId, manage, busy, onSaveTemplate, onEdit, onCopy, onAction, onDownload }: { contract: NativeContract; contracts: EsignOverview['contracts']; actorId: string; manage: boolean; busy: boolean; onSaveTemplate: (name: string) => Promise<boolean>; onEdit: () => void; onCopy: () => void; onAction: Action; onDownload: (kind: 'pdf' | 'evidence') => Promise<void> }) {
  const role = c.employeeActorId === actorId ? 'employee' : c.employer.signerActorId === actorId ? 'employer' : null;
  const expired = c.status === 'pending' && Date.parse(c.expiresAt) <= Date.now();
  const signed = c.signatures.some(row => row.actorId === actorId);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [showStop, setShowStop] = useState(false);
  const [requestConfirmed, setRequestConfirmed] = useState(false);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  return <article className="esign-detail"><div className="esign-topline"><div><h2>{c.title}</h2><p>{c.employeeName} · {c.employer.legalName}</p></div><span className={`esign-badge ${c.status}`}>{expired ? '서명 기한 경과' : statusName[c.status]}</span></div>
    {manage && c.status !== 'draft' && <div className="esign-actions"><Button variant="secondary" disabled={busy} onClick={onCopy}>기존 조건으로 새 계약 작성</Button><span className="esign-muted">갱신·재요청용 새 초안을 만듭니다. 기존 서명은 복사되지 않습니다.</span></div>}
    {manage && <section className="esign-template-save"><Button variant="secondary" disabled={busy} onClick={() => setShowSaveTemplate(value => !value)}>근로조건을 양식으로 저장</Button>{showSaveTemplate && <form className="hr-form esign-delivery" onSubmit={event => { event.preventDefault(); void onSaveTemplate(field(new FormData(event.currentTarget), 'templateName')); }}><label>양식 이름<input name="templateName" required maxLength={100} placeholder="예: 외대점 평일 시급 근로계약" disabled={busy} /></label><p className="esign-muted">현재 계약의 근로조건만 저장합니다. 근로자·계약 기간·서명은 제외됩니다. 추가 약정 등에 개인 이름이나 개인별 조건이 있으면 먼저 새 초안에서 수정해 주세요.</p><Button type="submit" disabled={busy}>검토한 조건으로 양식 저장</Button></form>}</section>}
    <dl className="esign-summary"><div><dt>계약 고용주</dt><dd>{c.employer.legalName}<br />{businessNumber(c.employer.businessNumber)}</dd></div><div><dt>근로자</dt><dd>{c.employeeName}</dd></div><div><dt>근로 시작일</dt><dd>{hrDate(c.terms.effectiveDate)}</dd></div><div><dt>사용자 서명 담당자</dt><dd>{c.employer.signerName}</dd></div><div><dt>근로 종료일</dt><dd>{c.terms.endDate ? hrDate(c.terms.endDate) : '기간의 정함 없음'}</dd></div><div><dt>서명 기한</dt><dd>{c.expiresAt ? hrDate(c.expiresAt) : '요청 시 지정'}</dd></div></dl>
    {manage && ['draft', 'pending'].includes(c.status) && <EsignComparison current={c} contracts={contracts} busy={busy} />}
    <section className="esign-document" aria-label="계약서 전체 내용"><header className="esign-document-heading"><h3>{c.status === 'draft' ? '계약서 미리보기' : '계약서 원문'}</h3><span className="esign-muted">전체 내용</span></header><pre>{c.documentText}</pre></section>
    {c.documentHash && <details><summary className="esign-muted">서명 대상 문서 확인값</summary><p className="esign-hash">SHA-256 · {c.documentHash}</p></details>}
    <div className="esign-parties">{(['employer', 'employee'] as const).map(party => { const signature = c.signatures.find(row => row.role === party); return <section className="esign-party" key={party}><div><strong>{party === 'employer' ? '사용자' : '근로자'} · {party === 'employer' ? c.employer.signerName : c.employeeName}</strong><p>{signature ? `${hrDate(signature.at)} · 본인 계정 재확인 후 서명` : '서명 대기'}</p></div><span className={`esign-badge ${signature ? 'completed' : ''}`}>{signature ? '서명 완료' : '대기'}</span></section>; })}</div>
    {c.status === 'draft' && manage && <form className="hr-form esign-delivery" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); if (!requestConfirmed) return; void onAction('request', { expiresAt: new Date(`${field(f, 'expiresDate')}T23:59:59+09:00`).toISOString() }, '앱 내 서명 요청을 등록했습니다. 양측 계정의 계약 메뉴에서 서명할 수 있습니다.'); }}><h3>계약 검토 및 서명 요청</h3><Button type="button" variant="secondary" disabled={busy} onClick={onEdit}>초안 수정</Button><p className="esign-muted">요청 후 계약 원문이 확정됩니다. 수정이 필요하면 요청을 취소하고 새 계약을 작성해 주세요.</p><label>서명 마감일<input name="expiresDate" type="date" min={hrToday()} max={new Date(Date.now() + 89 * 86400000).toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)} required disabled={busy} /></label><label className="esign-consent"><input type="checkbox" checked={requestConfirmed} disabled={busy} onChange={event => setRequestConfirmed(event.target.checked)} /><span>계약당사자, 근로조건과 계약서 전체 내용을 검토하고 서명 요청을 승인합니다.</span></label><Button type="submit" disabled={busy || !requestConfirmed}>앱 내 서명 요청</Button></form>}
    {c.status === 'pending' && !expired && role && !signed && <SignatureForm key={c.documentHash} contract={c} role={role} busy={busy} onAction={onAction} />}
    {c.status === 'pending' && expired && <p role="status" className="esign-muted">서명 기한이 지나 서명할 수 없습니다. 담당자가 기존 요청을 취소하고 새 계약을 검토·요청해야 합니다.</p>}
    {c.status === 'pending' && signed && !expired && <p className="esign-muted">본인 서명을 완료했습니다. 상대방 서명이 완료되면 계약서 사본을 내려받을 수 있습니다.</p>}
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
  let validStroke = false;
  try { validateNativeSignatureStrokes(strokes); validStroke = true; } catch { /* Incomplete drawings remain editable. */ }
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

function ContractForm({ employers, employees, busy, onSubmit, contract, sourceContract, savedTemplate }: { contract?: NativeContract | null; sourceContract?: NativeContract | null; savedTemplate?: NativeContractTemplate | null; employers: NativeEmployer[]; employees: Props['workspace']['employees']; busy: boolean; onSubmit: (input: Record<string, unknown>) => Promise<boolean> }) {
  const initial = contract ?? sourceContract ?? (savedTemplate ? { employeeId: '', employer: { id: savedTemplate.employerId }, title: `${savedTemplate.name} 근로계약서`.slice(0, 200), terms: { ...savedTemplate.terms, effectiveDate: '', endDate: '' } } : null);
  const [template, setTemplate] = useState<'monthly' | 'hourly' | 'fixed'>(initial?.terms.employmentType === 'part_time' ? 'hourly' : initial?.terms.employmentType === 'contract' ? 'fixed' : 'monthly');
  const [employeeId, setEmployeeId] = useState(initial?.employeeId || '');
  const employee = employees.find(row => row.id === employeeId);
  const selectedEmployees = employees.filter(row => row.actorId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    const terms: NativeContractTerms = { employmentType: template === 'hourly' ? 'part_time' : template === 'fixed' ? 'contract' : 'regular', payType: field(f, 'payType') as 'monthly' | 'hourly', basePay: Number(field(f, 'basePay')), effectiveDate: field(f, 'effectiveDate'), endDate: field(f, 'endDate'), jobTitle: field(f, 'jobTitle'), workplace: field(f, 'workplace'), workDays: field(f, 'workDays'), dailyWorkHours: field(f, 'dailyWorkHours'), workStart: field(f, 'workStart'), workEnd: field(f, 'workEnd'), breakMinutes: Number(field(f, 'breakMinutes')), payday: field(f, 'payday'), payCalculation: field(f, 'payCalculation'), payMethod: field(f, 'payMethod'), holidays: field(f, 'holidays'), annualLeave: field(f, 'annualLeave'), additionalTerms: field(f, 'additionalTerms') };
    void onSubmit({ ...(contract ? { id: contract.id, expectedVersion: contract.version } : { expectedVersion: 0 }), ...(savedTemplate ? { savedTemplateId: savedTemplate.id, savedTemplateVersion: savedTemplate.version } : {}), employerId: field(f, 'employerId'), employeeId, title: field(f, 'title'), templateKey: contract?.templateKey ?? `oda-employment-${template}-v1`, terms });
  }
  return <form className="hr-form esign-form" onSubmit={submit}><h2>{savedTemplate ? `${savedTemplate.name}로 계약 작성` : sourceContract ? '기존 조건으로 새 계약 작성' : '근로계약 작성'}</h2>{sourceContract && <p className="esign-muted">참고 계약: {sourceContract.title}. 근로 시작일과 종료일을 새로 지정하고, 현재 고용주·직원·급여·근로조건을 다시 확인해 주세요. 기존 계약과 서명은 변경되지 않습니다.</p>}<p className="esign-muted">입력한 조건으로 계약서 초안을 만듭니다. 초안을 확인한 뒤 서명을 요청합니다.</p><fieldset><legend>1. 계약당사자와 양식</legend><div className="hr-form-grid"><label>고용주<select name="employerId" required defaultValue={initial?.employer.id || ''} disabled={busy}><option value="" disabled>사업자 선택</option>{employers.filter(row => !savedTemplate || row.id === savedTemplate.employerId).map(row => <option key={row.id} value={row.id}>{row.legalName} · {businessNumber(row.businessNumber)}</option>)}</select></label><label>근로자<select name="employeeId" value={employeeId} onChange={event => setEmployeeId(event.target.value)} required disabled={busy}><option value="" disabled>직원 선택</option>{selectedEmployees.map(row => <option key={row.id} value={row.id}>{row.name} · {row.employeeNumber}</option>)}</select></label><label>계약 양식<select value={template} onChange={event => setTemplate(event.target.value as typeof template)} disabled={busy}><option value="monthly">월급 · 전일제</option><option value="hourly">시급 · 단시간</option><option value="fixed">기간제</option></select></label><label>계약 제목<input name="title" defaultValue={sourceContract ? `${sourceContract.title.slice(0, 180)} · 갱신 검토` : initial?.title || '근로계약서'} maxLength={200} required disabled={busy} /></label></div>{employees.length !== selectedEmployees.length && <p className="esign-muted">ODA 계정이 연결된 직원만 선택할 수 있습니다. 직원·조직에서 먼저 계정을 연결해 주세요.</p>}</fieldset>
    <fieldset><legend>2. 계약 기간 및 업무</legend><div className="hr-form-grid"><label>근로 시작일<input name="effectiveDate" type="date" required defaultValue={sourceContract || savedTemplate ? '' : initial?.terms.effectiveDate || hrToday()} disabled={busy} /></label><label>근로 종료일 {template !== 'fixed' && '· 선택'}<input name="endDate" defaultValue={sourceContract || savedTemplate ? '' : initial?.terms.endDate} type="date" required={template === 'fixed'} disabled={busy} /></label><label>담당 업무<input name="jobTitle" key={`job:${employeeId}`} defaultValue={savedTemplate ? savedTemplate.terms.jobTitle : employeeId === initial?.employeeId ? initial!.terms.jobTitle : employee?.jobTitle} required maxLength={300} disabled={busy} /></label><label>근무 장소<input name="workplace" defaultValue={initial?.terms.workplace} required maxLength={500} disabled={busy} placeholder="실제 근무할 매장명과 주소" /></label></div></fieldset>
    <fieldset><legend>3. 근로일 및 시간</legend><label>근로일<input name="workDays" defaultValue={initial?.terms.workDays} required maxLength={500} disabled={busy} placeholder="예: 월·화·수·목·금" /></label><label>근로일별 근로시간<textarea name="dailyWorkHours" defaultValue={initial?.terms.dailyWorkHours} required maxLength={1000} rows={3} disabled={busy} placeholder="예: 월·수·금 10:00~15:00, 화·목 10:00~14:00. 요일별 휴게시간도 적어 주세요." /></label><div className="hr-form-grid"><label>기본 시업 시각<input name="workStart" type="time" required defaultValue={initial?.terms.workStart || '09:00'} disabled={busy} /></label><label>기본 종업 시각<input name="workEnd" type="time" required defaultValue={initial?.terms.workEnd || '18:00'} disabled={busy} /></label><label>기본 휴게시간 · 분<input name="breakMinutes" type="number" min="0" max="720" step="1" defaultValue={initial?.terms.breakMinutes ?? 60} required disabled={busy} /></label></div></fieldset>
    <fieldset><legend>4. 임금</legend><div className="hr-form-grid"><label>급여 기준<select key={template} name="payType" defaultValue={initial?.terms.payType || (template === 'hourly' ? 'hourly' : 'monthly')} disabled={busy}><option value="monthly">월급</option><option value="hourly">시급</option></select></label><label>기본급 · 원<input name="basePay" key={`pay:${employeeId}`} defaultValue={savedTemplate ? savedTemplate.terms.basePay : employeeId === initial?.employeeId ? initial!.terms.basePay : employee?.basePay || ''} type="number" min="1" max="1000000000" step="1" required disabled={busy} /></label><label>임금 지급일<input name="payday" defaultValue={initial?.terms.payday} maxLength={500} required placeholder="예: 매월 10일, 전월 근로분 지급" disabled={busy} /></label><label>임금 지급 방법<input name="payMethod" defaultValue={initial?.terms.payMethod} maxLength={500} required placeholder="예: 근로자 명의 계좌로 이체" disabled={busy} /></label></div><label>임금 구성항목 및 계산방법<textarea name="payCalculation" defaultValue={initial?.terms.payCalculation} rows={4} maxLength={2000} required disabled={busy} placeholder="기본급, 수당 항목·금액, 근로시간에 따른 계산방법을 구체적으로 입력해 주세요." /></label></fieldset>
    <fieldset><legend>5. 휴일·휴가·추가 약정</legend><label>휴일<textarea name="holidays" defaultValue={initial?.terms.holidays} required maxLength={2000} rows={3} disabled={busy} placeholder="주휴일과 적용되는 유급휴일, 휴일 운영 기준" /></label><label>연차유급휴가<textarea name="annualLeave" defaultValue={initial?.terms.annualLeave} required maxLength={2000} rows={3} disabled={busy} placeholder="해당 사업장과 근로자에게 적용되는 연차유급휴가 기준" /></label><label>추가 약정 · 선택<textarea name="additionalTerms" defaultValue={initial?.terms.additionalTerms} maxLength={8000} rows={4} disabled={busy} /></label></fieldset><div className="esign-actions"><Button type="submit" disabled={busy || !employeeId}>{busy ? '저장 중…' : '초안 저장 후 미리보기'}</Button></div>
  </form>;
}

export function EsignPendingCard({ storeId, actorId, onOpen, disabled = false }: { storeId: string; actorId: string; onOpen: () => void; disabled?: boolean }) {
  const [overview, setOverview] = useState<EsignOverview | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const update = () => { if (document.visibilityState !== 'hidden') setRefresh(value => value + 1); };
    const timer = window.setInterval(update, 60000); window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => { const controller = new AbortController(); setOverview(previous => previous?.storeId === storeId && previous.currentActorId === actorId ? previous : null); if (!storeId) return; void getOdaEsign(storeId, controller.signal).then(result => { if (!controller.signal.aborted) setOverview(result); }).catch(() => { if (!controller.signal.aborted) setOverview(null); }); return () => controller.abort(); }, [storeId, actorId, refresh]);
  const own = overview?.storeId === storeId ? overview.contracts.filter(row => row.employeeActorId === actorId) : [];
  const now = Date.now();
  const pending = own.filter(row => matchesEsignTask(row, 'mine', actorId, now)).length;
  const expired = own.filter(row => matchesEsignTask(row, 'expired', actorId, now)).length;
  const ending = own.filter(row => matchesEsignTask(row, 'ending', actorId, now)).length;
  if (!pending && !expired && !ending) return null;
  return <button type="button" className="esign-employee-card" onClick={onOpen} disabled={disabled}><FileCheck2 size={24} /><span><strong>{pending ? `서명할 근로계약 ${pending}건` : '확인할 근로계약이 있습니다'}</strong><small>{[pending ? '계약 내용을 확인하고 서명해 주세요.' : '', expired ? `서명 기한 경과 ${expired}건 · 담당자 확인 필요` : '', ending ? `기록된 종료일 30일 이내 ${ending}건` : ''].filter(Boolean).join(' / ')}</small></span><ChevronRight size={19} /></button>;
}
