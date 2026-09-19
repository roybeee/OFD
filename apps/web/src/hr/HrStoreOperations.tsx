import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HR_STORE_CHECKLIST } from '../../../../packages/domain/src/oda-hr';
import { Button } from '../components/ui';
import { Check, ClipboardCheck, Plus, RefreshCcw } from '../components/icons';
import { HrEmpty, hrError, hrToday, type HrPanelProps } from './shared';
import './HrStoreOperations.css';

const categories = { general: '일반', stock: '재고·폐기', facility: '설비', cash: '현금·마감' } as const;
const formatTime = (iso: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
export const storeHandoverPhotoUrl = (storeId: string, id: string) => `${import.meta.env.VITE_API_BASE ?? '/api/v2'}/oda/${encodeURIComponent(storeId)}/hr/handovers/${encodeURIComponent(id)}/photo`;

export function HrStoreOperations({ workspace, permissions, actorId, mutate, busy, onReload }: HrPanelProps) {
  const [date, setDate] = useState(hrToday);
  const [tab, setTab] = useState<'checks' | 'handovers'>('checks');
  const [filter, setFilter] = useState<'date' | 'open'>('date');
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<keyof typeof categories>('general');
  const [photo, setPhoto] = useState<{ base64: string; mimeType: string }>();
  const [photoError, setPhotoError] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoSequence = useRef(0);
  const scope = `${workspace.storeId}:${actorId}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; photoSequence.current++; }; }, []);
  useEffect(() => {
    setDate(hrToday()); setTab('checks'); setFilter('date'); setWriting(false); setBody(''); setCategory('general');
    setPhoto(undefined); setPhotoError(''); setReading(false); photoSequence.current++; setError(''); setSuccess(''); setSaving(false); lock.current = false;
    if (fileInput.current) fileInput.current.value = '';
  }, [scope]);
  const allowed = permissions.manage || permissions.self;
  const disabled = busy || saving || reloading || !allowed;
  const operations = workspace.operations ?? { checks: [], handovers: [] };
  const checks = operations.checks.filter(item => item.date === date);
  const done = checks.filter(item => item.done).length;
  const pending = operations.handovers.filter(item => !item.resolved);
  const earlierPending = pending.filter(item => item.date < date).length;
  const visibleHandovers = operations.handovers.filter(item => filter === 'open' ? !item.resolved : item.date === date).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const actorName = (id?: string) => id === actorId ? '나' : workspace.employees.find(employee => employee.actorId === id)?.name || '매장 구성원';

  async function save(type: string, input: Record<string, unknown>, onSuccess?: () => void) {
    if (lock.current || disabled) return;
    const requestedScope = scope;
    lock.current = true; setSaving(true); setError(''); setSuccess('');
    try {
      await mutate(type, input);
      if (alive.current && activeScope.current === requestedScope) { onSuccess?.(); setSuccess('변경 사항을 저장했습니다.'); }
    } catch (failure) { if (alive.current && activeScope.current === requestedScope) setError(hrError(failure)); }
    finally { if (alive.current && activeScope.current === requestedScope) { lock.current = false; setSaving(false); } }
  }
  async function reload() {
    if (!onReload || disabled) return;
    setReloading(true); setError('');
    try { await onReload(); } catch (failure) { if (alive.current) setError(hrError(failure)); }
    finally { if (alive.current) setReloading(false); }
  }
  function resetPhoto() { photoSequence.current++; setPhoto(undefined); setPhotoError(''); setReading(false); if (fileInput.current) fileInput.current.value = ''; }
  async function readPhoto(file?: File) {
    const sequence = ++photoSequence.current;
    setPhoto(undefined); setPhotoError(''); setReading(false);
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setPhotoError('JPEG·PNG·WebP 사진을 2MB 이하로 선택해 주세요.'); return; }
    setReading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('사진을 읽지 못했습니다. 다시 선택해 주세요.')); reader.readAsDataURL(file); });
      if (alive.current && sequence === photoSequence.current) setPhoto({ base64, mimeType: file.type });
    } catch (failure) { if (alive.current && sequence === photoSequence.current) setPhotoError(hrError(failure)); }
    finally { if (alive.current && sequence === photoSequence.current) setReading(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (reading || photoError || !body.trim()) return;
    void save('operations.handover.create', { date, body: body.trim(), category, ...(photo ? { photo } : {}) }, () => { setWriting(false); setBody(''); setCategory('general'); resetPhoto(); });
  }

  if (!allowed) return <HrEmpty title="매장 업무 권한이 없습니다">매장 관리자 또는 연결된 직원 계정으로 이용할 수 있습니다.</HrEmpty>;
  return <div className="hr-store-operations" data-testid="store-operations">
    <header className="hr-section-heading"><div><h2>매장 업무</h2><p>오픈부터 마감까지 점검하고, 다음 근무자에게 필요한 내용을 남겨 주세요.</p></div>{onReload && <Button variant="secondary" aria-label="매장 업무 새로고침" disabled={disabled} onClick={() => void reload()}><RefreshCcw size={17} /></Button>}</header>
    <div className="hr-ops-context"><label className="hr-field"><span>업무 날짜</span><input type="date" max={hrToday()} aria-label="업무 날짜" value={date} disabled={disabled || reading} onChange={event => { if (event.target.value) { setDate(event.target.value); setSuccess(''); } }} /></label><span>한국 시간 기준 · 매장 구성원과 공유</span></div>
    <div className="hr-ops-summary"><div><ClipboardCheck size={20} /><span>선택일 점검 <strong>{done}/{HR_STORE_CHECKLIST.length}</strong></span></div><button type="button" disabled={disabled} onClick={() => { setTab('handovers'); setFilter('open'); }}><span>미해결 인수인계 <strong>{pending.length}건</strong></span><span aria-hidden="true">→</span></button></div>
    {error && <div className="hr-error" role="alert"><p>{error}</p><p>입력 내용은 유지됩니다. 확인 후 다시 저장하거나 최신 정보를 불러와 주세요.</p></div>}
    {success && <p className="hr-success" role="status"><Check size={16} aria-hidden="true" /> {success}</p>}
    <nav className="hr-ops-tabs" aria-label="매장 업무 메뉴"><button type="button" aria-current={tab === 'checks' ? 'page' : undefined} disabled={disabled || reading} onClick={() => setTab('checks')}>오픈·마감</button><button type="button" aria-current={tab === 'handovers' ? 'page' : undefined} disabled={disabled || reading} onClick={() => setTab('handovers')}>인수인계</button></nav>
    {tab === 'checks' && <div className="hr-ops-checklists">{(['open', 'close'] as const).map(phase => {
      const tasks = HR_STORE_CHECKLIST.filter(item => item.phase === phase);
      const completed = tasks.filter(task => checks.some(check => check.phase === phase && check.taskKey === task.taskKey && check.done)).length;
      return <section className="hr-card" key={phase} aria-label={phase === 'open' ? '오픈 점검' : '마감 점검'}><header className="hr-card-head"><h3>{phase === 'open' ? '오픈 점검' : '마감 점검'}</h3><span>{completed}/{tasks.length}</span></header><progress max={tasks.length} value={completed} aria-label={`${phase === 'open' ? '오픈' : '마감'} 완료율`} />{tasks.map(task => {
        const item = checks.find(check => check.phase === phase && check.taskKey === task.taskKey);
        return <label key={task.taskKey} className={`hr-ops-check${item?.done ? ' is-done' : ''}`}><input type="checkbox" checked={item?.done ?? false} disabled={disabled} onChange={event => void save('operations.check', { date, phase, taskKey: task.taskKey, done: event.target.checked })} /><span><strong>{task.label}</strong><small>{item?.done ? `${actorName(item.completedBy)} 완료${item.completedAt ? ` · ${formatTime(item.completedAt)}` : ''}` : '아직 확인하지 않았어요'}</small></span></label>;
      })}</section>;
    })}</div>}
    {tab === 'handovers' && <section className="hr-ops-handovers" aria-label="매장 인수인계">
      <header className="hr-section-heading"><div><h3>다음 근무자에게</h3><p>설비 이상, 재고·폐기, 현금 차이와 필요한 조치를 공유하세요.</p></div><Button disabled={disabled || reading} onClick={() => setWriting(true)}><Plus size={16} /> 인수인계 작성</Button></header>
      {writing && <form className="hr-card hr-form hr-ops-compose" aria-label="인수인계 작성" onSubmit={submit}><fieldset disabled={disabled || reading}><div className="hr-ops-form-grid"><label><span>분류</span><select name="category" value={category} onChange={event => setCategory(event.target.value as keyof typeof categories)}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>사진 첨부 (선택)</span><input ref={fileInput} name="photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { void readPhoto(event.target.files?.[0]); }} /><small>JPEG·PNG·WebP, 최대 2MB</small></label></div><label><span>인수인계 내용</span><textarea name="body" required maxLength={2000} value={body} onChange={event => setBody(event.target.value)} placeholder="무슨 일이 있었고, 다음 근무자가 무엇을 확인해야 하나요?" /></label>{photo && <img className="hr-ops-photo" src={`data:${photo.mimeType};base64,${photo.base64}`} alt="첨부할 인수인계 사진" />}{photoError && <p className="hr-error" role="alert">{photoError}</p>}{(photo || photoError) && <Button type="button" variant="secondary" onClick={resetPhoto}>사진 제거</Button>}<p className="hr-ops-hint">{date} 업무로 등록합니다. 같은 매장의 구성원에게만 공유됩니다.</p><div className="hr-actions"><Button type="submit" disabled={!body.trim() || Boolean(photoError) || reading}>{saving ? '저장 중…' : '인수인계 등록'}</Button><Button type="button" variant="secondary" onClick={() => setWriting(false)}>작성 접기</Button></div></fieldset>{reading && <p role="status">사진을 준비하고 있습니다…</p>}</form>}
      <div className="hr-ops-filters" aria-label="인수인계 보기"><button type="button" aria-pressed={filter === 'date'} onClick={() => setFilter('date')}>선택일 전체</button><button type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>미해결 전체 {pending.length}</button></div>
      {filter === 'date' && earlierPending > 0 && <p className="hr-note">이전 날짜에 해결되지 않은 인수인계 {earlierPending}건이 있습니다. ‘미해결 전체’에서 확인하세요.</p>}
      {!visibleHandovers.length && <HrEmpty title={filter === 'open' ? '모든 인수인계를 확인했어요' : '이 날짜의 인수인계가 없습니다'}>{filter === 'open' ? '새로 확인할 업무가 생기면 여기에 표시됩니다.' : '다음 근무자에게 필요한 내용을 남겨 주세요.'}</HrEmpty>}
      <div className="hr-ops-feed">{visibleHandovers.map(item => <article className="hr-card" key={item.id}><header className="hr-card-head"><div><strong>{item.authorName}</strong><p>{item.date} · {categories[item.category]} · {formatTime(item.createdAt)}</p></div><span className={`hr-ops-status${item.resolved ? ' is-resolved' : ''}`}>{item.resolved ? '해결 완료' : '확인 필요'}</span></header><p className="hr-prewrap">{item.body}</p>{item.hasPhoto && <a className="hr-ops-photo-link" href={storeHandoverPhotoUrl(workspace.storeId, item.id)} target="_blank" rel="noreferrer" aria-label={`${item.authorName} 인수인계 사진 크게 보기`}><img className="hr-ops-photo" src={storeHandoverPhotoUrl(workspace.storeId, item.id)} alt={`${item.authorName}의 인수인계 사진`} loading="lazy" /><span>사진 크게 보기</span></a>}{item.resolved && <p className="hr-ops-hint">{actorName(item.resolvedBy)} 확인{item.resolvedAt ? ` · ${formatTime(item.resolvedAt)}` : ''}</p>}{permissions.manage && <Button variant="secondary" disabled={disabled} onClick={() => void save('operations.handover.resolve', { id: item.id, resolved: !item.resolved })}>{item.resolved ? '다시 열기' : '해결 완료로 표시'}</Button>}</article>)}</div>
    </section>}
  </div>;
}
