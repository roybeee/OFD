import { useEffect, useMemo, useState } from 'react';
import { ApiError, isExplicitDemoMode, loadBootstrap, logoutV2 } from './api/client';
import { LoginScreen, UnauthorizedScreen } from './components/AuthGate';
import { AppShell } from './components/AppShell';
import { ApiConnectionError, SkeletonScreen, ToastRegion } from './components/ui';
import { DriverTodayPage } from './pages/DriverTodayPage';
import { HqDeliveryPage } from './pages/HqDeliveryPage';
import { HqInvoicesPage } from './pages/HqInvoicesPage';
import { HqOrdersPage } from './pages/HqOrdersPage';
import { HqReconciliationPage } from './pages/HqReconciliationPage';
import { StoreDocumentsPage } from './pages/StoreDocumentsPage';
import { StoreOrdersPage } from './pages/StoreOrdersPage';
import type { BootstrapData, DataSource, Toast } from './types';
import { canAccessPath, defaultPathFor, roleForPath } from './lib/access';

const knownPaths = new Set(['/store/orders', '/store/documents', '/hq/orders', '/hq/delivery', '/hq/reconciliation', '/hq/invoices', '/driver/today', '/unauthorized']);

function initialPath() {
  if (knownPaths.has(window.location.pathname)) return window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role');
  const view = params.get('view');
  if (role === 'hq') return view === 'delivery' ? '/hq/delivery' : view === 'reconciliation' ? '/hq/reconciliation' : view === 'invoices' ? '/hq/invoices' : '/hq/orders';
  if (role === 'driver') return '/driver/today';
  return view === 'documents' ? '/store/documents' : '/store/orders';
}

export default function App() {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [source, setSource] = useState<DataSource>('demo');
  const [connectionError, setConnectionError] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const role = roleForPath(path);
  const explicitDemo = isExplicitDemoMode();

  useEffect(() => {
    let mounted = true;
    setData(null);
    setConnectionError(false);
    setAuthenticationRequired(false);
    loadBootstrap()
      .then((result) => {
        if (!mounted) return;
        if (!canAccessPath(path, result.data.capabilities, explicitDemo)) {
          const permittedPath = defaultPathFor(result.data.capabilities);
          window.history.replaceState({}, '', permittedPath);
          setPath(permittedPath);
          return;
        }
        setData(result.data);
        setSource(result.source);
      })
      .catch((error) => {
        if (!mounted) return;
        setData(null);
        if (error instanceof ApiError && error.status === 401) setAuthenticationRequired(true);
        else setConnectionError(true);
      });
    return () => { mounted = false; };
  }, [explicitDemo, path, retryKey]);

  useEffect(() => {
    const onPopState = () => setPath(initialPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const actorName = useMemo(() => source === 'live' ? data?.actor.name ?? '사용자' : role === 'store' ? '박도현' : role === 'driver' ? '강민호' : '김운영', [data, role, source]);

  function navigate(nextPath: string) {
    if (data && !canAccessPath(nextPath, data.capabilities, explicitDemo)) return;
    const demo = explicitDemo ? '?demo=1' : '';
    window.history.pushState({}, '', `${nextPath}${demo}`);
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  async function logout() {
    try { if (!explicitDemo) await logoutV2(); } catch { /* 세션이 이미 만료된 경우도 로그인으로 이동 */ }
    setData(null);
    setAuthenticationRequired(true);
  }

  function notify(message: string, tone: Toast['tone'] = 'info') {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_500);
  }

  if (connectionError) return <ApiConnectionError onRetry={() => setRetryKey((value) => value + 1)} />;
  if (authenticationRequired) return <LoginScreen onAuthenticated={() => setRetryKey((value) => value + 1)} />;
  if (!data) return <SkeletonScreen />;
  if (path === '/unauthorized') return <UnauthorizedScreen onLogout={logout} />;

  return (
    <AppShell role={role} path={path} source={source} actorName={actorName} actorRole={data.actor.role} storeName={data.store.name} deliveryCount={data.deliveries.length} capabilities={data.capabilities} explicitDemo={explicitDemo} onNavigate={navigate} onLogout={logout}>
      {path === '/store/orders' && <StoreOrdersPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/store/documents' && <StoreDocumentsPage data={data} notify={notify} />}
      {path === '/hq/orders' && <HqOrdersPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/delivery' && <HqDeliveryPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/reconciliation' && <HqReconciliationPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/invoices' && <HqInvoicesPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/driver/today' && <DriverTodayPage data={data} source={source} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      <ToastRegion toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </AppShell>
  );
}
