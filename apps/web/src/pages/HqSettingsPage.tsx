import { useEffect, useState } from 'react';
import { loadAccessSettingsV2, newIdempotencyKey, setMenuOrderV2, type AccessPageMeta } from '../api/client';
import { Button, EmptyState } from '../components/ui';
import { ScrollText } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

type Notify = (message: string, tone?: Toast['tone']) => void;

/** 기타 관리 — 마스터 전용 운영 설정. 첫 기능은 메뉴 노출 순서 조정. */
export function HqSettingsPage({ data, notify }: { data: BootstrapData; notify: Notify }) {
  const [pages, setPages] = useState<AccessPageMeta[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    loadAccessSettingsV2()
      .then((result) => {
        if (!mounted) return;
        /* 순서 조정 대상은 본사(hq) 메뉴 — 저장된 순서를 먼저 놓고 나머지는 카탈로그 순서로 뒤에 붙인다 */
        const hqPages = result.pages.filter((page) => page.domain === 'hq');
        const stored = (result.menuOrder ?? []).filter((path) => hqPages.some((page) => page.path === path));
        const rest = hqPages.map((page) => page.path).filter((path) => !stored.includes(path));
        setPages(hqPages);
        setOrder([...stored, ...rest]);
        setSavedOrder(result.menuOrder ?? []);
      })
      .catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : '설정을 불러오지 못했습니다.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const label = (path: string) => pages.find((page) => page.path === path)?.label ?? path;
  const dirty = order.join('|') !== [...savedOrder.filter((p) => order.includes(p)),
    ...order.filter((p) => !savedOrder.includes(p))].join('|');

  function move(index: number, delta: number) {
    setOrder((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const result = await setMenuOrderV2(order, newIdempotencyKey());
      setSavedOrder(result.menuOrder);
      notify('메뉴 순서를 저장했습니다. 새로고침하면 모든 사용자에게 적용됩니다.', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '메뉴 순서를 저장하지 못했습니다.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await setMenuOrderV2([], newIdempotencyKey());
      setSavedOrder([]);
      setOrder(pages.map((page) => page.path));
      notify('메뉴 순서를 기본값으로 되돌렸습니다.', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '되돌리지 못했습니다.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page" aria-labelledby="settings-heading">
      <header className="page-head">
        <div>
          <h1 id="settings-heading">기타 관리</h1>
          <p>운영에 필요한 부가 설정입니다 · 최고관리자만 볼 수 있습니다</p>
        </div>
      </header>

      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="panel" aria-labelledby="menu-order-heading">
        <div className="page-head">
          <div>
            <h2 id="menu-order-heading">메뉴 노출 순서</h2>
            <p>상단 메뉴에 보이는 순서입니다. 자주 쓰는 메뉴를 위로 올리면 모든 사용자에게 같은 순서로 적용됩니다.</p>
          </div>
        </div>

        {loading ? <p className="muted" style={{ padding: '0 17px 15px' }}>불러오는 중…</p>
          : pages.length === 0 ? (
            <EmptyState icon={<ScrollText size={20} aria-hidden="true" />} title="조정할 메뉴가 없습니다">
              본사 메뉴가 확인되지 않습니다.
            </EmptyState>
          ) : (
          <>
            <ol className="menu-order-list" aria-label="메뉴 순서">
              {order.map((path, index) => (
                <li key={path}>
                  <span className="menu-order-rank" aria-hidden="true">{index + 1}</span>
                  <strong>{label(path)}</strong>
                  <span className="muted menu-order-path">{path}</span>
                  <span className="menu-order-actions">
                    <Button type="button" variant="secondary" aria-label={`${label(path)} 위로`}
                      disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</Button>
                    <Button type="button" variant="secondary" aria-label={`${label(path)} 아래로`}
                      disabled={busy || index === order.length - 1} onClick={() => move(index, 1)}>↓</Button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="access-actions" style={{ padding: '0 17px 15px' }}>
              <Button type="button" onClick={() => void save()} disabled={busy || !dirty}>{busy ? '저장 중…' : '순서 저장'}</Button>
              <Button type="button" variant="secondary" onClick={() => void reset()} disabled={busy || savedOrder.length === 0}>기본값으로</Button>
            </div>
            <p className="muted" style={{ padding: '0 17px 15px' }}>
              현재 로그인 계정({data.actor.name})에는 저장 즉시 반영되며, 다른 사용자는 다음 새로고침부터 보입니다.
            </p>
          </>
        )}
      </section>
    </section>
  );
}
