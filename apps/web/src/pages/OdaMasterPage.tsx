import { useEffect, useState, type FormEvent } from 'react';
import { createOdaAdminStore, loadOdaAdminStores, newIdempotencyKey, updateOdaAdminStore,
  type OdaAdminStore, type OdaBusinessDetails } from '../api/client';
import { ArrowDownToLine, ArrowRight, CircleDollarSign, FileCheck2, Plus, ReceiptText, RefreshCcw, ShieldCheck, Store, UserRound } from '../components/icons';
import { Button } from '../components/ui';
import type { BootstrapData } from '../types';
import './OdaMasterPage.css';
import { OdaOverviewPanel } from './OdaOverviewPanel';

type Props = { data: BootstrapData; onNavigate: (path: string) => void };
type Notify = (message: string, tone?: 'success' | 'info' | 'warning') => void;
const shortcuts = [
  { title: '월 손익계산서', description: '매출·비용·영업이익과 배분액을 한눈에 확인합니다.', tab: 'overview', icon: ReceiptText },
  { title: '매출·비용·증빙', description: '파일을 넣고 중복·누락·분류만 확인합니다.', tab: 'transactions', icon: FileCheck2 },
  { title: '정산서 내려받기', description: '선택한 매장의 월 정산서를 엑셀·CSV로 받습니다.', tab: 'overview', anchor: 'oda-exports', icon: ArrowDownToLine },
  { title: '계약·정산 기준', description: '우선배분·부가세·귀속 기준과 양측 확인을 관리합니다.', tab: 'policy', icon: ShieldCheck },
  { title: '정산 확정·지급 기록', description: '확인된 정산을 확정하고 실제 지급 내역을 남깁니다.', tab: 'overview', anchor: 'oda-payment', icon: CircleDollarSign },
  { title: '변경 기록', description: '확정본과 수정 사유, 담당자별 확인 기록을 봅니다.', tab: 'history', icon: RefreshCcw },
];

export { odaMasterSettlementPath } from '../lib/oda-navigation';
import { odaMasterSettlementPath } from '../lib/oda-navigation';

export function OdaMasterPage({ data, onNavigate }: Props) {
  const stores = data.stores.filter(store => store.active !== false);
  const [storeId, setStoreId] = useState(stores.find(store => store.id === data.store.id)?.id || stores[0]?.id || '');
  return <main id="main-content" className="page oda-master-page" tabIndex={-1}>
    <header className="oda-master-heading"><div><p className="oda-master-kicker">ODA · MASTER WORKSPACE</p><h1>{data.actor.name}님의 작업공간</h1><p>정산부터 계정·매장 관리까지, 필요한 업무를 바로 시작하세요.</p></div><span className="oda-master-badge"><ShieldCheck size={17} /> 마스터 계정</span></header>
    <section className="oda-master-start" aria-labelledby="oda-master-start-title"><div><p className="oda-master-kicker">바로 시작하기</p><h2 id="oda-master-start-title">자료를 넣으면 월 손익이 정리됩니다</h2><p>사업자 정보는 나중에 등록해도 됩니다. 기본 작업공간에서 시작하고 실제 매장 이름으로 바꿀 수 있습니다.</p></div><div className="oda-master-start-actions">{stores.length ? <><label htmlFor="oda-master-store">작업할 매장<select id="oda-master-store" value={storeId} onChange={event => setStoreId(event.target.value)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><Button onClick={() => onNavigate(odaMasterSettlementPath(storeId, 'transactions'))}>이번 달 자료 넣기 <ArrowRight size={17} /></Button></> : <Button onClick={() => onNavigate('/hq/oda-stores')}>작업공간 만들기 <Plus size={17} /></Button>}</div></section>
    <OdaOverviewPanel operationalDate={data.meta.operationalDate} onNavigate={onNavigate} />
    <section aria-labelledby="oda-master-functions"><div className="oda-master-section-heading"><h2 id="oda-master-functions">이번 달 정산 업무</h2><p>정산 확정에는 실제 증빙과 A·B의 기준 확인이 필요합니다.</p></div><div className="oda-master-grid">{shortcuts.map(item => {
      const Icon = item.icon;
      return <button type="button" className="oda-master-shortcut" key={item.title} onClick={() => onNavigate(stores.length ? odaMasterSettlementPath(storeId, item.tab, item.anchor) : '/hq/oda-stores')}><Icon size={23} /><strong>{item.title}</strong><span>{item.description}</span><ArrowRight size={18} className="oda-shortcut-arrow" /></button>;
    })}</div></section>
    <section aria-labelledby="oda-master-management"><div className="oda-master-section-heading"><h2 id="oda-master-management">운영 관리</h2></div><div className="oda-master-management"><button type="button" onClick={() => onNavigate('/hq/oda-stores')}><Store size={25} /><span><strong>매장·사업자 관리</strong><small>작업공간 이름 변경, 매장 추가, 사업자 정보 후등록</small></span><ArrowRight size={18} /></button><button type="button" onClick={() => onNavigate('/hq/accounts')}><UserRound size={25} /><span><strong>계정 관리</strong><small>A·B 담당자 추가, 매장 배정, 비밀번호 재설정</small></span><ArrowRight size={18} /></button></div></section>
  </main>;
}

const blankBusiness = (): OdaBusinessDetails => ({ businessNumber: '', legalName: '', representativeName: '', address: '', businessType: '', businessCategory: '', email: '' });
const businessFields: Array<{ key: keyof OdaBusinessDetails; label: string }> = [
  { key: 'businessNumber', label: '사업자등록번호' }, { key: 'legalName', label: '상호·법인명' },
  { key: 'representativeName', label: '대표자명' }, { key: 'address', label: '사업장 주소' },
  { key: 'businessType', label: '업태' }, { key: 'businessCategory', label: '종목' }, { key: 'email', label: '사업자 이메일' },
];

export function OdaStoresPage({ onNavigate, notify, onSaved }: { onNavigate: Props['onNavigate']; notify: Notify; onSaved: () => void }) {
  const [stores, setStores] = useState<OdaAdminStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<OdaAdminStore | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [includeBusiness, setIncludeBusiness] = useState(false);
  const [business, setBusiness] = useState(blankBusiness);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void loadOdaAdminStores().then(result => { if (active) setStores(result.stores); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : '매장을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  function openForm(store: OdaAdminStore | null) {
    setEditing(store); setName(store?.name || ''); setCode(store?.code || ''); setOpenDate(store?.openDate || '');
    setBusiness(store?.business || blankBusiness()); setIncludeBusiness(Boolean(store?.business?.businessNumber));
    setFormError(''); setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving) return;
    if (!name.trim()) { setFormError('매장 이름을 입력해 주세요.'); return; }
    const cleanBusiness = Object.fromEntries(Object.entries(business).map(([key, value]) => [key, key === 'businessNumber' ? value.replace(/[-\s]/g, '') : value.trim()])) as OdaBusinessDetails;
    if (includeBusiness && (businessFields.some(({ key }) => !cleanBusiness[key]) || !/^\d{10}$/.test(cleanBusiness.businessNumber) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanBusiness.email))) {
      setFormError('사업자 정보 7개 항목을 확인해 주세요. 사업자등록번호는 숫자 10자리입니다.'); return;
    }
    setSaving(true); setFormError('');
    const input = { name: name.trim(), ...(code.trim() ? { code: code.trim() } : {}),
      ...(openDate ? { openDate } : editing?.openDate ? { openDate: null } : {}),
      ...(includeBusiness ? { business: cleanBusiness } : {}) };
    try {
      const result = editing ? await updateOdaAdminStore({ ...input, id: editing.id, expectedVersion: editing.version }, newIdempotencyKey()) : await createOdaAdminStore(input, newIdempotencyKey());
      setStores(current => editing ? current.map(store => store.id === result.store.id ? result.store : store) : [...current, result.store]);
      setFormOpen(false); notify(editing ? '매장 정보를 저장했습니다.' : '새 매장을 만들었습니다.', 'success'); onSaved();
    } catch (caught) { setFormError(caught instanceof Error ? caught.message : '저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }
  return <main id="main-content" className="page oda-master-page" tabIndex={-1}>
    <header className="oda-master-heading"><div><p className="oda-master-kicker">ODA · STORE MANAGEMENT</p><h1>매장·사업자 관리</h1><p>매장 이름만으로 시작하고 사업자 정보는 필요할 때 등록하세요.</p></div><Button onClick={() => openForm(null)} disabled={saving}><Plus size={17} /> 매장 추가</Button></header>
    {error && <div className="oda-master-error" role="alert">{error}<Button variant="secondary" onClick={() => setRetry(value => value + 1)}>다시 불러오기</Button></div>}
    {loading ? <p role="status">매장 목록을 불러옵니다.</p> : <section className="oda-store-list" aria-label="매장 목록">{stores.map(store => <article className="oda-store-item" key={store.id}><Store size={25} /><div><h2>{store.name}</h2><p>{store.business?.legalName || '사업자 정보 미등록 · 정산 업무 사용 가능'}{!store.active ? ' · 비활성' : ''}</p><small>{store.code}</small></div><div className="oda-store-actions"><Button variant="secondary" disabled={saving} onClick={() => openForm(store)} aria-label={`${store.name} 정보 수정`}>정보 수정</Button>{store.active && <Button variant="ghost" onClick={() => onNavigate(odaMasterSettlementPath(store.id))}>월 정산 열기 <ArrowRight size={16} /></Button>}</div></article>)}{!stores.length && <div className="oda-master-empty"><h2>첫 작업공간을 만드세요</h2><p>매장 이름만 입력하면 월 정산을 시작할 수 있습니다.</p><Button onClick={() => openForm(null)}>매장 만들기</Button></div>}</section>}
    {formOpen && <section className="oda-store-form" aria-labelledby="oda-store-form-title"><h2 id="oda-store-form-title">{editing ? '매장 정보 수정' : '새 매장'}</h2><form onSubmit={save}>
      <div className="oda-master-fields"><label htmlFor="oda-store-name">매장 이름<input id="oda-store-name" value={name} onChange={event => setName(event.target.value)} maxLength={200} required disabled={saving} /></label><label htmlFor="oda-store-code">매장 코드 <small>(선택)</small><input id="oda-store-code" value={code} onChange={event => setCode(event.target.value)} maxLength={40} placeholder="비워두면 자동 생성" disabled={saving} /></label><label htmlFor="oda-store-open-date">개점일 <small>(선택)</small><input id="oda-store-open-date" type="date" value={openDate} onChange={event => setOpenDate(event.target.value)} disabled={saving} /></label></div>
      <label className="oda-master-checkbox"><input type="checkbox" checked={includeBusiness} onChange={event => setIncludeBusiness(event.target.checked)} disabled={saving || Boolean(editing?.business?.businessNumber)} />사업자 정보도 등록하기 <small>(정산 시작에는 필요하지 않습니다)</small></label>
      {includeBusiness && <fieldset className="oda-master-business"><legend>사업자 정보</legend><div className="oda-master-fields">{businessFields.map(field => <label key={field.key} htmlFor={`oda-business-${field.key}`}>{field.label}<input id={`oda-business-${field.key}`} type={field.key === 'email' ? 'email' : 'text'} inputMode={field.key === 'businessNumber' ? 'numeric' : undefined} value={business[field.key]} onChange={event => setBusiness(current => ({ ...current, [field.key]: event.target.value }))} required maxLength={field.key === 'address' ? 500 : 254} disabled={saving} /></label>)}</div></fieldset>}
      {formError && <p className="oda-master-error" role="alert">{formError}</p>}<div className="oda-master-form-actions"><Button type="button" variant="secondary" disabled={saving} onClick={() => setFormOpen(false)}>취소</Button><Button type="submit" disabled={saving}>{saving ? '저장 중…' : '매장 저장'}</Button></div>
    </form></section>}
  </main>;
}
