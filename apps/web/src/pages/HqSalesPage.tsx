import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPosLinkV2, createPosStoreV2, loadPosReport, loadPosDiscovered, loadPosLinks, newIdempotencyKey, syncPosV2,
  type PosReportResult, type PosReportUnit,
} from '../api/client';
import { Button, EmptyState, MetricCard } from '../components/ui';
import { LayoutGrid } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

const won = (value: number) => value.toLocaleString('ko-KR');
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const shiftDays = (date: string, days: number) => {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

/** V1 매출현황 이식: 기간×매장 피벗 + 행 클릭 시 품목별 판매 드릴다운 */
export function HqSalesPage({ data, notify }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [unit, setUnit] = useState<PosReportUnit>('day');
  const [to, setTo] = useState(seoulToday);
  const [from, setFrom] = useState(() => shiftDays(seoulToday(), -29));
  const [metric, setMetric] = useState<'amount' | 'qty'>('amount');
  const [report, setReport] = useState<PosReportResult | null>(null);
  const [storeNames, setStoreNames] = useState<Record<string, string>>({});
  const [storeFilter, setStoreFilter] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Array<{ id: string; storeId: string; merchantId: string; lastSyncAt: string | null }>>([]);
  const [discovered, setDiscovered] = useState<Array<{ merchantId: string; lastSeenAt: string }>>([]);
  const [localStores, setLocalStores] = useState<Array<{ id: string; name: string }>>(() => data.stores.map((store) => ({ id: store.id, name: store.name })));
  const [setupOpen, setSetupOpen] = useState(false);
  const [storeForm, setStoreForm] = useState({ name: '', storeKind: '직영', billingCycle: 'monthly', paymentMethod: 'monthly_credit', notificationPhone: '' });
  const [linkForm, setLinkForm] = useState({ storeId: '', merchantId: '', accessKey: '', secretKey: '' });
  const [setupBusy, setSetupBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [result, linkResult, discoveredResult] = await Promise.all([
        loadPosReport(from, to, unit, storeFilter), loadPosLinks(), loadPosDiscovered(),
      ]);
      setReport(result);
      setLinks(linkResult.links.map(({ id, storeId, merchantId, lastSyncAt }) => ({ id, storeId, merchantId, lastSyncAt })));
      setStoreNames(Object.fromEntries(linkResult.links.map((link) => [link.storeId, link.merchantId])));
      setDiscovered(discoveredResult.merchants.map(({ merchantId, lastSeenAt }) => ({ merchantId, lastSeenAt })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '매출을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [from, to, unit, storeFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  const storeIds = report?.storeIds ?? [];
  const totals = useMemo(() => {
    const rows = report?.rows ?? [];
    const amount = rows.reduce((acc, row) => acc + row.total.amount, 0);
    const qty = rows.reduce((acc, row) => acc + row.total.qty, 0);
    return { amount, qty, buckets: rows.length, average: rows.length ? Math.round(amount / rows.length) : 0 };
  }, [report]);

  async function submitStore() {
    if (storeForm.name.trim().length < 2) { notify('매장명을 2자 이상 입력해 주세요.', 'warning'); return; }
    setSetupBusy(true);
    try {
      const created = await createPosStoreV2({
        name: storeForm.name.trim(), storeKind: storeForm.storeKind, billingCycle: storeForm.billingCycle,
        paymentMethod: storeForm.paymentMethod, notificationPhone: storeForm.notificationPhone,
      }, newIdempotencyKey());
      setLocalStores((current) => [...current, { id: created.store.id, name: created.store.name }]);
      setLinkForm((current) => ({ ...current, storeId: created.store.id }));
      setStoreForm({ name: '', storeKind: '직영', billingCycle: 'monthly', paymentMethod: 'monthly_credit', notificationPhone: '' });
      notify(`${created.store.name} 매장 등록 완료 (${created.store.code}) — 아래에서 토스 키를 연결해 주세요.`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '매장 등록에 실패했습니다.', 'warning');
    } finally {
      setSetupBusy(false);
    }
  }

  async function submitLink() {
    if (!linkForm.storeId || !linkForm.merchantId.trim() || !linkForm.accessKey.trim() || !linkForm.secretKey.trim()) {
      notify('매장, merchantId, 액세스 키, 시크릿 키를 모두 입력해 주세요.', 'warning');
      return;
    }
    setSetupBusy(true);
    try {
      await createPosLinkV2({
        storeId: linkForm.storeId, merchantId: linkForm.merchantId.trim(),
        accessKey: linkForm.accessKey.trim(), secretKey: linkForm.secretKey.trim(),
      }, newIdempotencyKey());
      notify('토스플레이스 연동 완료 — [POS 동기화]로 수집을 시작하세요.', 'success');
      setLinkForm({ storeId: '', merchantId: '', accessKey: '', secretKey: '' });
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '연동 등록에 실패했습니다.', 'warning');
    } finally {
      setSetupBusy(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      const result = await syncPosV2(from, to, newIdempotencyKey());
      const rows = result.results.reduce((acc, item) => acc + item.rows, 0);
      const failed = result.results.filter((item) => item.status === 'error');
      notify(failed.length ? `수집 완료 ${rows}건 · 실패 ${failed.length}곳: ${failed[0]?.error ?? ''}` : `POS 수집 완료 — ${rows}건 반영`, failed.length ? 'warning' : 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'POS 수집에 실패했습니다.', 'warning');
    } finally {
      setSyncing(false);
    }
  }

  function toggleRow(bucket: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(bucket)) next.delete(bucket); else next.add(bucket);
      return next;
    });
  }

  function toggleStore(storeId: string) {
    setStoreFilter((current) => current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId]);
    setOpen(new Set());
  }

  const label = (storeId: string) => storeNames[storeId] ?? storeId.slice(0, 8);
  const cell = (value: { qty: number; amount: number } | undefined) => value ? won(metric === 'amount' ? value.amount : value.qty) : '–';

  return (
    <section className="page" aria-labelledby="sales-heading">
      <header className="page-head">
        <div>
          <h1 id="sales-heading">매출현황</h1>
          <p>{from} ~ {to} · POS 실측 기준 · 데이터가 있는 기간만 표시</p>
        </div>
        <div className="page-actions">
          <Button type="button" variant="ghost" onClick={() => setSetupOpen((value) => !value)} aria-expanded={setupOpen}>POS 연동 관리</Button>
          <Button type="button" variant="secondary" onClick={runSync} disabled={syncing}>{syncing ? '수집 중…' : 'POS 동기화'}</Button>
        </div>
      </header>

      {(setupOpen || links.length === 0) && (
        <section className="panel" aria-labelledby="pos-setup-heading">
          <h2 id="pos-setup-heading">POS 연동 관리</h2>
          {links.length > 0 ? (
            <div className="table-wrap">
              <table className="data-table compact">
                <thead><tr><th scope="col">merchantId</th><th scope="col">매장</th><th scope="col">마지막 수집</th></tr></thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.id}>
                      <th scope="row">{link.merchantId}</th>
                      <td>{localStores.find((store) => store.id === link.storeId)?.name ?? link.storeId.slice(0, 8)}</td>
                      <td className="muted">{link.lastSyncAt ? link.lastSyncAt.slice(0, 16).replace('T', ' ') : '아직 없음'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">아직 연동된 매장이 없습니다. 매장을 등록하고 토스플레이스 키를 연결하면 30분마다 자동 수집됩니다.</p>}

          <h3 className="setup-sub">① 매장 등록 <span className="muted">(목록에 없을 때만)</span></h3>
          <div className="form-grid">
            <label>매장명<input type="text" value={storeForm.name} onChange={(event) => setStoreForm({ ...storeForm, name: event.target.value })} placeholder="예: 독산점" /></label>
            <label>구분
              <select value={storeForm.storeKind} onChange={(event) => setStoreForm({ ...storeForm, storeKind: event.target.value })}>
                <option value="직영">직영</option><option value="가맹">가맹</option>
              </select>
            </label>
            <label>청구 방식
              <select value={storeForm.billingCycle} onChange={(event) => setStoreForm({ ...storeForm, billingCycle: event.target.value })}>
                <option value="monthly">월 합산</option><option value="per_delivery">건별</option>
              </select>
            </label>
            <label>결제 조건
              <select value={storeForm.paymentMethod} onChange={(event) => setStoreForm({ ...storeForm, paymentMethod: event.target.value })}>
                <option value="monthly_credit">월 외상</option><option value="prepaid">선결제</option>
              </select>
            </label>
            <label>알림 연락처<input type="text" value={storeForm.notificationPhone} onChange={(event) => setStoreForm({ ...storeForm, notificationPhone: event.target.value })} placeholder="010-0000-0000" /></label>
          </div>
          <Button type="button" variant="secondary" onClick={submitStore} disabled={setupBusy}>매장 등록</Button>

          <h3 className="setup-sub">② 토스플레이스 연동</h3>
          {discovered.length > 0 && (
            <div className="discovered-strip" data-testid="discovered-merchants" role="group" aria-label="자동 수집된 매장 ID">
              <p className="muted">매장 POS에서 앱 설치가 감지됐습니다 — 매장 ID를 클릭하면 아래 입력칸에 채워집니다.</p>
              <div className="discovered-chips">
                {discovered.map((item) => (
                  <button key={item.merchantId} type="button" className="chip"
                    onClick={() => setLinkForm((current) => ({ ...current, merchantId: item.merchantId }))}>
                    {item.merchantId} <span className="muted">({item.lastSeenAt.slice(0, 16).replace('T', ' ')})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="form-grid">
            <label>매장
              <select value={linkForm.storeId} onChange={(event) => setLinkForm({ ...linkForm, storeId: event.target.value })}>
                <option value="">선택…</option>
                {localStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </label>
            <label>merchantId<input type="text" value={linkForm.merchantId} onChange={(event) => setLinkForm({ ...linkForm, merchantId: event.target.value })} placeholder="토스 개발자센터의 매장 ID" /></label>
            <label>액세스 키<input type="password" value={linkForm.accessKey} onChange={(event) => setLinkForm({ ...linkForm, accessKey: event.target.value })} autoComplete="off" /></label>
            <label>시크릿 키<input type="password" value={linkForm.secretKey} onChange={(event) => setLinkForm({ ...linkForm, secretKey: event.target.value })} autoComplete="off" /></label>
          </div>
          <Button type="button" onClick={submitLink} disabled={setupBusy}>{setupBusy ? '처리 중…' : '연동 등록'}</Button>
          <p className="muted setup-note">키는 서버에서 AES-256-GCM으로 암호화되어 저장되며 화면에 다시 표시되지 않습니다.</p>
        </section>
      )}

      <div className="filter-bar">
        <div className="filter-group" role="group" aria-label="집계 단위">
          {(['day', 'week', 'month'] as PosReportUnit[]).map((value) => (
            <button key={value} type="button" className={unit === value ? 'chip chip-on' : 'chip'} aria-pressed={unit === value}
              onClick={() => { setUnit(value); setOpen(new Set()); }}>
              {value === 'day' ? '일별' : value === 'week' ? '주별' : '월별'}
            </button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="기간 프리셋">
          {[7, 30, 90].map((days) => (
            <button key={days} type="button" className="chip" onClick={() => { setFrom(shiftDays(to, -(days - 1))); setOpen(new Set()); }}>{days}일</button>
          ))}
        </div>
        <label className="filter-date">시작<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="filter-date">종료<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        <div className="filter-group" role="group" aria-label="표시 값">
          <button type="button" className={metric === 'amount' ? 'chip chip-on' : 'chip'} aria-pressed={metric === 'amount'} onClick={() => setMetric('amount')}>금액</button>
          <button type="button" className={metric === 'qty' ? 'chip chip-on' : 'chip'} aria-pressed={metric === 'qty'} onClick={() => setMetric('qty')}>수량</button>
        </div>
      </div>

      {storeIds.length > 1 && (
        <div className="filter-bar" role="group" aria-label="매장 필터">
          <button type="button" className={storeFilter.length === 0 ? 'chip chip-on' : 'chip'} onClick={() => { setStoreFilter([]); setOpen(new Set()); }}>전체</button>
          {storeIds.map((storeId) => (
            <button key={storeId} type="button" className={storeFilter.includes(storeId) ? 'chip chip-on' : 'chip'}
              aria-pressed={storeFilter.includes(storeId)} onClick={() => toggleStore(storeId)}>{label(storeId)}</button>
          ))}
        </div>
      )}

      <div className="metric-grid">
        <MetricCard label="기간 합계" value={`${won(totals.amount)}원`} detail={`${unit === 'day' ? '일별' : unit === 'week' ? '주별' : '월별'} ${totals.buckets}개 구간`} icon={<LayoutGrid size={18} aria-hidden="true" />} />
        <MetricCard label="판매 수량" value={`${won(totals.qty)}개`} detail="POS 실측 합계" icon={<LayoutGrid size={18} aria-hidden="true" />} />
        <MetricCard label="구간 평균" value={`${won(totals.average)}원`} detail="데이터 있는 구간 기준" icon={<LayoutGrid size={18} aria-hidden="true" />} tone="orange" />
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}

      {loading ? <p className="muted">불러오는 중…</p> : (report?.rows.length ?? 0) === 0 ? (
        <EmptyState icon={<LayoutGrid size={20} aria-hidden="true" />} title="표시할 매출이 없습니다">
          기간을 넓히거나 POS 동기화를 실행해 주세요.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">기간별 매장 매출과 품목 내역</caption>
            <thead>
              <tr>
                <th scope="col">기간</th>
                {storeIds.map((storeId) => <th key={storeId} scope="col" className="num">{label(storeId)}</th>)}
                <th scope="col" className="num">합계</th>
              </tr>
            </thead>
            <tbody>
              {report!.rows.map((row) => {
                const expanded = open.has(row.bucket);
                return [
                  <tr key={row.bucket} className="row-clickable">
                    <th scope="row">
                      <button type="button" className="row-toggle" aria-expanded={expanded} onClick={() => toggleRow(row.bucket)}>
                        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {row.label}
                      </button>
                    </th>
                    {storeIds.map((storeId) => <td key={storeId} className="num">{cell(row.perStore[storeId])}</td>)}
                    <td className="num strong">{won(metric === 'amount' ? row.total.amount : row.total.qty)}</td>
                  </tr>,
                  expanded && (
                    <tr key={`${row.bucket}-mix`} className="row-detail">
                      <td colSpan={storeIds.length + 2}>
                        <div className="drilldown">
                          <p className="drilldown-head">{row.label} 품목별 판매 — {row.mix.length}개 품목 · {won(row.total.qty)}개 / {won(row.total.amount)}원</p>
                          <table className="data-table compact">
                            <thead>
                              <tr>
                                <th scope="col">품목</th>
                                {storeIds.length > 1 && storeIds.map((storeId) => <th key={storeId} scope="col" className="num">{label(storeId)}</th>)}
                                <th scope="col" className="num">수량</th>
                                <th scope="col" className="num">매출</th>
                                <th scope="col" className="num">비중</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.mix.map((mix) => (
                                <tr key={mix.key}>
                                  <th scope="row">{mix.name}</th>
                                  {storeIds.length > 1 && storeIds.map((storeId) => {
                                    const store = mix.stores.find((item) => item.storeId === storeId);
                                    return <td key={storeId} className="num muted">{store ? won(metric === 'amount' ? store.amount : store.qty) : '–'}</td>;
                                  })}
                                  <td className="num">{won(mix.qty)}</td>
                                  <td className="num strong">{won(mix.amount)}</td>
                                  <td className="num muted">{row.total.amount ? ((mix.amount / row.total.amount) * 100).toFixed(1) : '0.0'}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
