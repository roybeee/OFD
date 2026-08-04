import { useCallback, useEffect, useState } from 'react';
import {
  createPosAliasV2, createPosProductV2, loadPosLinks, loadPosProducts, loadPosUnmatched, loadPosWaste,
  newIdempotencyKey, type PosDeviation, type PosProduct, type PosUnmatched, type PosWasteResult,
} from '../api/client';
import { Button, EmptyState, MetricCard } from '../components/ui';
import { PackageCheck } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

const CATEGORIES = ['도넛', '링도넛', '음료', '굿즈', '서비스', '세트', '기타'] as const;
const won = (value: number) => value.toLocaleString('ko-KR');
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const shiftDays = (date: string, days: number) => {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

/** V1 상품 관리 이식: 카테고리·미매칭 매핑·가격 편차 + 폐기 산출 */
export function HqProductsPage({ notify }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [to, setTo] = useState(seoulToday);
  const [from, setFrom] = useState(() => shiftDays(seoulToday(), -29));
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [deviations, setDeviations] = useState<PosDeviation[]>([]);
  const [unmatched, setUnmatched] = useState<PosUnmatched[]>([]);
  const [storeNames, setStoreNames] = useState<Record<string, string>>({});
  const [waste, setWaste] = useState<PosWasteResult | null>(null);
  const [wasteStore, setWasteStore] = useState('');
  const [wasteDate, setWasteDate] = useState(seoulToday);
  const [category, setCategory] = useState<string>('전체');
  const [pending, setPending] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [productResult, unmatchedResult, links] = await Promise.all([
        loadPosProducts(from, to), loadPosUnmatched(from, to), loadPosLinks(),
      ]);
      setProducts(productResult.products);
      setDeviations(productResult.deviations);
      setUnmatched(unmatchedResult.items);
      setStoreNames(Object.fromEntries(links.links.map((link) => [link.storeId, link.merchantId])));
      if (!wasteStore && links.links[0]) setWasteStore(links.links[0].storeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '상품 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [from, to, wasteStore]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!wasteStore) return;
    let mounted = true;
    loadPosWaste(wasteStore, wasteDate)
      .then((result) => { if (mounted) setWaste(result); })
      .catch(() => { if (mounted) setWaste(null); });
    return () => { mounted = false; };
  }, [wasteStore, wasteDate]);

  async function mapAlias(item: PosUnmatched, productId: string) {
    setPending(item.rawName);
    try {
      const result = await createPosAliasV2(item.rawName, productId, newIdempotencyKey());
      notify(`"${item.rawName}" 매핑 완료 — ${result.relinked}건 소급 반영${result.scopeStoreId ? ' (해당 매장만)' : ''}`, 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '매핑에 실패했습니다.', 'warning');
    } finally {
      setPending('');
    }
  }

  async function promote(item: PosUnmatched) {
    setPending(item.rawName);
    try {
      const price = item.qty > 0 ? Math.round(item.amount / item.qty) : null;
      await createPosProductV2({ name: item.rawName, category: '기타', storeId: null, consumerPrice: price, rawName: item.rawName }, newIdempotencyKey());
      notify(`"${item.rawName}"을 신규 상품으로 등록했습니다. 카테고리를 확인해 주세요.`, 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '상품 등록에 실패했습니다.', 'warning');
    } finally {
      setPending('');
    }
  }

  const label = (storeId: string) => storeNames[storeId] ?? storeId.slice(0, 8);
  const shown = category === '전체' ? products : products.filter((product) => product.category === category);
  const unmatchedAmount = unmatched.reduce((acc, item) => acc + item.amount, 0);

  return (
    <section className="page" aria-labelledby="products-heading">
      <header className="page-head">
        <div>
          <h1 id="products-heading">상품 관리</h1>
          <p>{from} ~ {to} · 미매칭 품목을 정리하면 매출·정산에 즉시 반영됩니다</p>
        </div>
        <div className="page-actions">
          <label className="filter-date">시작<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="filter-date">종료<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        </div>
      </header>

      <div className="metric-grid">
        <MetricCard label="등록 상품" value={`${products.length}종`} detail={`${CATEGORIES.filter((item) => products.some((product) => product.category === item)).length}개 카테고리`} icon={<PackageCheck size={18} aria-hidden="true" />} />
        <MetricCard label="미매칭 품목" value={`${unmatched.length}건`} detail={`매출 ${won(unmatchedAmount)}원 미분류`} icon={<PackageCheck size={18} aria-hidden="true" />} tone={unmatched.length ? 'red' : 'green'} />
        <MetricCard label="가격 편차" value={`${deviations.length}건`} detail="소비자가 대비 ±3% 이상" icon={<PackageCheck size={18} aria-hidden="true" />} tone={deviations.length ? 'orange' : 'default'} />
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}

      {unmatched.length > 0 && (
        <section className="panel" aria-labelledby="unmatched-heading">
          <h2 id="unmatched-heading">미매칭 품목 정리</h2>
          <p className="muted">POS 품목명이 등록 상품과 연결되지 않은 항목입니다. 매핑하면 과거 매출까지 소급 반영됩니다.</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">POS 품목명</th>
                  <th scope="col">매장</th>
                  <th scope="col" className="num">수량</th>
                  <th scope="col" className="num">매출</th>
                  <th scope="col">연결</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map((item) => (
                  <tr key={`${item.storeId}-${item.rawName}`}>
                    <th scope="row">{item.rawName}</th>
                    <td>{label(item.storeId)}</td>
                    <td className="num">{won(item.qty)}</td>
                    <td className="num strong">{won(item.amount)}</td>
                    <td>
                      <div className="inline-actions">
                        <select aria-label={`${item.rawName} 연결 상품`} defaultValue={item.suggestion?.productId ?? ''}
                          onChange={(event) => { if (event.target.value) void mapAlias(item, event.target.value); }}
                          disabled={pending === item.rawName}>
                          <option value="">상품 선택…</option>
                          {item.suggestion && <option value={item.suggestion.productId}>{item.suggestion.productName} (유사도 {item.suggestion.similarity}%)</option>}
                          {products.filter((product) => product.id !== item.suggestion?.productId).map((product) => (
                            <option key={product.id} value={product.id}>{product.name}{product.storeId ? ' · 전용' : ''}</option>
                          ))}
                        </select>
                        <Button type="button" variant="ghost" onClick={() => void promote(item)} disabled={pending === item.rawName}>신규 등록</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {deviations.length > 0 && (
        <section className="panel" aria-labelledby="deviation-heading">
          <h2 id="deviation-heading">가격 편차</h2>
          <p className="muted">등록 소비자가와 실제 판매 평균단가의 차이입니다. 매장별 임의 가격 변경이나 등록가 미갱신을 의심할 수 있습니다.</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">품목</th>
                  <th scope="col">매장</th>
                  <th scope="col" className="num">등록 소비자가</th>
                  <th scope="col" className="num">실판매 평균</th>
                  <th scope="col" className="num">편차</th>
                </tr>
              </thead>
              <tbody>
                {deviations.map((item) => (
                  <tr key={`${item.productId}-${item.storeId}`}>
                    <th scope="row">{item.productName}</th>
                    <td>{label(item.storeId)}</td>
                    <td className="num">{won(item.consumerPrice)}</td>
                    <td className="num">{won(item.avgSoldPrice)}</td>
                    <td className={item.deviationPct > 0 ? 'num strong tone-red' : 'num strong tone-green'}>
                      {item.deviationPct > 0 ? '+' : ''}{item.deviationPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="waste-heading">
        <h2 id="waste-heading">폐기 산출</h2>
        <div className="filter-bar">
          <label className="filter-date">매장
            <select value={wasteStore} onChange={(event) => setWasteStore(event.target.value)}>
              {Object.keys(storeNames).map((storeId) => <option key={storeId} value={storeId}>{label(storeId)}</option>)}
            </select>
          </label>
          <label className="filter-date">일자<input type="date" value={wasteDate} onChange={(event) => setWasteDate(event.target.value)} /></label>
        </div>
        {!waste ? <p className="muted">불러오는 중…</p> : !waste.hasReceipt ? (
          <EmptyState icon={<PackageCheck size={20} aria-hidden="true" />} title="입고 기록이 없어 폐기를 계산할 수 없습니다">
            판매 {won(waste.totals.sold)}개는 확인되지만, 이 날짜의 입고 검수 기록이 없어 폐기는 N/A입니다.
            발주·입고를 기록하면 폐기율과 로스 금액이 자동 산출됩니다.
          </EmptyState>
        ) : (
          <>
            <div className="metric-grid">
              <MetricCard label="입고" value={`${won(waste.totals.received ?? 0)}개`} detail="검수 확정 수량" icon={<PackageCheck size={18} aria-hidden="true" />} />
              <MetricCard label="판매" value={`${won(waste.totals.sold)}개`} detail="POS 실측" icon={<PackageCheck size={18} aria-hidden="true" />} />
              <MetricCard label="폐기" value={`${won(waste.totals.waste ?? 0)}개`} detail={`폐기율 ${waste.totals.wasteRatePct ?? 0}%`} icon={<PackageCheck size={18} aria-hidden="true" />} tone={(waste.totals.wasteRatePct ?? 0) > 10 ? 'red' : 'green'} />
              <MetricCard label="로스 금액" value={`${won(waste.totals.lossAmount ?? 0)}원`} detail="공급단가 기준" icon={<PackageCheck size={18} aria-hidden="true" />} tone="orange" />
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">품목</th>
                    <th scope="col" className="num">입고</th>
                    <th scope="col" className="num">판매</th>
                    <th scope="col" className="num">폐기</th>
                    <th scope="col" className="num">폐기율</th>
                    <th scope="col" className="num">로스</th>
                  </tr>
                </thead>
                <tbody>
                  {waste.items.map((item) => (
                    <tr key={item.productId}>
                      <th scope="row">{item.productName}{item.over > 0 && <span className="tag tag-warn"> 판매초과 {item.over}</span>}</th>
                      <td className="num">{item.received === null ? 'N/A' : won(item.received)}</td>
                      <td className="num">{won(item.sold)}</td>
                      <td className="num">{item.waste === null ? 'N/A' : won(item.waste)}</td>
                      <td className="num muted">{item.wasteRatePct === null ? 'N/A' : `${item.wasteRatePct}%`}</td>
                      <td className="num strong">{item.lossAmount === null ? 'N/A' : won(item.lossAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="catalog-heading">
        <h2 id="catalog-heading">상품 목록</h2>
        <div className="filter-bar" role="group" aria-label="카테고리 필터">
          {(['전체', ...CATEGORIES] as string[]).map((item) => (
            <button key={item} type="button" className={category === item ? 'chip chip-on' : 'chip'} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>
          ))}
        </div>
        {loading ? <p className="muted">불러오는 중…</p> : shown.length === 0 ? (
          <EmptyState icon={<PackageCheck size={20} aria-hidden="true" />} title="상품이 없습니다">미매칭 품목을 신규 등록하면 여기에 나타납니다.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">상품명</th>
                  <th scope="col">카테고리</th>
                  <th scope="col">범위</th>
                  <th scope="col" className="num">소비자가</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((product) => (
                  <tr key={product.id}>
                    <th scope="row">{product.name}</th>
                    <td>{product.category}</td>
                    <td>{product.storeId ? `${label(product.storeId)} 전용` : '공통'}</td>
                    <td className="num">{product.consumerPrice === null ? '미등록' : won(product.consumerPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
