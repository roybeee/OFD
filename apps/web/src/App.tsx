import { useEffect, useMemo, useState } from 'react';
import { ApiError, loadBootstrap, logoutV2 } from './api/client';
import { SessionRequiredScreen, UnauthorizedScreen } from './components/AuthGate';
import { AppShell } from './components/AppShell';
import { ApiConnectionError, SkeletonScreen, ToastRegion } from './components/ui';
import { DriverTodayPage } from './pages/DriverTodayPage';
import { HqDeliveryPage } from './pages/HqDeliveryPage';
import { HqInvoicesPage } from './pages/HqInvoicesPage';
import { HqOrdersPage } from './pages/HqOrdersPage';
import { HqReconciliationPage } from './pages/HqReconciliationPage';
import { StoreDocumentsPage } from './pages/StoreDocumentsPage';
import { StoreOrdersPage } from './pages/StoreOrdersPage';
import type { BootstrapData, Toast } from './types';
import { browserPathFor, canAccessPath, defaultPathFor, logicalPathFromLocation, roleForPath } from './lib/access';

const knownPaths = new Set(['/store/orders', '/store/documents', '/hq/orders', '/hq/delivery', '/hq/reconciliation', '/hq/invoices', '/driver/today', '/unauthorized']);

function initialPath() {
  const logicalPath = logicalPathFromLocation(window.location.pathname, import.meta.env.BASE_URL);
  if (knownPaths.has(logicalPath)) return logicalPath;
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
  const [connectionError, setConnectionError] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [authorizationDenied, setAuthorizationDenied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const role = roleForPath(path);

  useEffect(() => {
    let mounted = true;
    setData(null);
    setConnectionError(false);
    setAuthenticationRequired(false);
    setAuthorizationDenied(false);
    loadBootstrap()
      .then((result) => {
        if (!mounted) return;
        if (!canAccessPath(path, result.data.capabilities)) {
          const permittedPath = defaultPathFor(result.data.capabilities);
          if (permittedPath === '/unauthorized') {
            window.history.replaceState({}, '', browserPathFor(permittedPath, import.meta.env.BASE_URL));
            setAuthorizationDenied(true);
            return;
          }
          window.history.replaceState({}, '', browserPathFor(permittedPath, import.meta.env.BASE_URL));
          setPath(permittedPath);
          return;
        }
        setData(result.data);
      })
      .catch((error) => {
        if (!mounted) return;
        setData(null);
        if (error instanceof ApiError && error.status === 401) setAuthenticationRequired(true);
        else if (error instanceof ApiError && error.status === 403) setAuthorizationDenied(true);
        else setConnectionError(true);
      });
    return () => { mounted = false; };
  }, [path, retryKey]);

  useEffect(() => {
    const onPopState = () => setPath(initialPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const actorName = useMemo(() => data?.actor.name ?? '사용자', [data]);

  function navigate(nextPath: string) {
    if (data && !canAccessPath(nextPath, data.capabilities)) return;
    window.history.pushState({}, '', browserPathFor(nextPath, import.meta.env.BASE_URL));
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  async function logout() {
    try { await logoutV2(); } catch { /* 세션이 이미 만료된 경우도 로그인 안내로 이동 */ }
    setData(null);
    setAuthorizationDenied(false);
    setAuthenticationRequired(true);
  }

  function notify(message: string, tone: Toast['tone'] = 'info') {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_500);
  }

  if (connectionError) return <ApiConnectionError onRetry={() => setRetryKey((value) => value + 1)} />;
  if (authenticationRequired) return <SessionRequiredScreen onRetry={() => setRetryKey((value) => value + 1)} />;
  if (authorizationDenied) return <UnauthorizedScreen onLogout={logout} />;
  if (!data) return <SkeletonScreen />;
  if (path === '/unauthorized') return <UnauthorizedScreen onLogout={logout} />;

  return (
    <AppShell role={role} path={path} actorName={actorName} actorRole={data.actor.role} storeName={data.store.name} deliveryCount={data.deliveries.length} capabilities={data.capabilities} onNavigate={navigate} onLogout={logout}>
      {path === '/store/orders' && <StoreOrdersPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/store/documents' && <StoreDocumentsPage data={data} notify={notify} />}
      {path === '/hq/orders' && <HqOrdersPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/delivery' && <HqDeliveryPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/reconciliation' && <HqReconciliationPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/invoices' && <HqInvoicesPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/driver/today' && <DriverTodayPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      <ToastRegion toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </AppShell>
  );
}
